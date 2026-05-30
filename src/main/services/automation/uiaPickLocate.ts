/**
 * v2.0 Phase 3 — UIA-candidate-pick (textual Set-of-Marks).
 *
 * When UIA enumerates candidates but matchUiaElement can't find a
 * usable match (the v1.9.3 container rejection plus the fuzzy-string
 * miss), the next step today is free-form vision-locate — the model
 * hunts pixels and mis-clicks by 50-200px on small icons.
 *
 * This module takes a different swing: send the model the screenshot
 * PLUS a numbered list of UIA candidates and ask "which id best
 * matches the user's description?" Coordinates come from UIA's bbox →
 * ZERO pixel error when the model picks correctly. When the model
 * picks "none", caller falls through to existing vision-locate.
 *
 * Why this works:
 *   - "Pick id 7 from this list" is structurally easier than "find the
 *     pixel" — the model uses its grounding on screenshot tokens to
 *     read the labels next to elements (Send button, Cancel, etc).
 *   - UIA already supplies names + control types for clickable
 *     elements with high precision; matchUiaElement just lacks the
 *     fuzzy-semantic reasoning a vision model brings.
 *   - Output coords are EXACT — model doesn't get to pick pixels, only
 *     which existing element to click.
 *
 * v2.0 ships the textual variant (candidate list + screenshot — no
 * image annotation). Visual marks (numbered overlays drawn on the
 * screenshot) require image compositing deps we don't have; the
 * textual variant captures most of the win and the bench will tell
 * us whether the visual upgrade is worth pulling sharp in for.
 *
 * Failure modes return null + a trail string — same contract as
 * locateVisionRefined and locateViaComputerUse.
 */
import { randomUUID } from 'node:crypto'
import { invokeCompletion } from '../ai'
import { getConfig } from '../storage/config'
import { CONTAINER_CONTROL_TYPES, PREFERRED_CONTROL_TYPES, prettyControlType } from './uiaMatch'
import type { CapturedScreen } from './screenCapture'
import type { UiaElement } from './uia'
import type { ChatTurn } from '@shared/types'

/**
 * Cached lowercase set of preferred control types for substring-free
 * exact matching. Faster than re-creating a set per call and avoids
 * the brittleness of `ct.includes('button')` matching `'ButtonPane'`
 * or other oddly-named non-Microsoft UIA providers.
 */
const PREFERRED_SET = new Set(PREFERRED_CONTROL_TYPES)

/**
 * How many candidates we'll show the model. Hard-capped to keep the
 * prompt short — at 50+ elements per query the model loses track of
 * which is which. UI surfaces with that many clickable controls exist
 * (file explorer, dense IDEs) but the right ones almost always rise to
 * the top under the control-type bias below.
 */
const MAX_CANDIDATES = 40

/**
 * Minimum bbox area in screen pixels for a candidate to be worth
 * showing. UIA frequently emits tiny invisible-anchor elements (1×1,
 * 4×4) that crowd the list. 100px² drops them.
 */
const MIN_BBOX_AREA = 100

const UIA_PICK_SYSTEM = `You are an accessibility-aware click helper. The user describes a UI element. You're given a screenshot AND a numbered list of candidates the OS accessibility tree found. Pick the id of the best match.

REPLY FORMAT: reply with ONLY the integer id (e.g. "7"), or "none" if no candidate matches. No JSON, no markdown, no commentary. Just the number or "none".`

/**
 * Filter + rank UIA candidates for the model. Drops elements that are
 * off-screen or sub-pixel, and prioritises ones with names + a
 * clickable control type so the most useful 40 always rise to the top.
 */
export function filterCandidates(
  elements: UiaElement[],
  shot: CapturedScreen
): Array<{ id: number; element: UiaElement }> {
  // UIA's PowerShell walker already filters offscreen + zero-bounds
  // (see uia.ts), so the bbox-vs-shot check here is the SECOND-pass
  // defence for windowed captures: when shot.windowOriginX/Y is set,
  // the screenshot covers a sub-rect of the screen and UIA elements
  // sitting outside that rect (parent dialog, sibling window) would
  // otherwise crowd the candidate list.
  // v2.0 polish — bounds are pixel-inclusive [windowOriginX, shotMaxX), so
  // an element with `e.x === shotMaxX` sits one pixel past the visible rect
  // and shouldn't be listed. The previous strict `>` let it through; its
  // bbox rendered outside the screenshot the vision model saw, wasting a
  // candidate slot and confusing the pick. Use `>=` to match the half-open
  // interval semantics.
  const shotMaxX = shot.windowOriginX + shot.displayWidth
  const shotMaxY = shot.windowOriginY + shot.displayHeight
  const scored = elements
    .filter((e) => {
      if (e.x + e.w <= shot.windowOriginX) return false
      if (e.y + e.h <= shot.windowOriginY) return false
      if (e.x >= shotMaxX) return false
      if (e.y >= shotMaxY) return false
      if (e.w * e.h < MIN_BBOX_AREA) return false
      return true
    })
    .map((element) => {
      let score = 0
      if (element.name && element.name.trim()) score += 10
      // Exact match against the canonical sets that matchUiaElement
      // uses (PREFERRED_CONTROL_TYPES / CONTAINER_CONTROL_TYPES). The
      // earlier substring approach risked over-matching custom
      // ProgrammaticName strings emitted by non-Microsoft UIA
      // providers; exact-match keeps the taxonomy stable.
      if (PREFERRED_SET.has(element.controlType)) score += 5
      // v1.9.3 rejected these as click targets when large — kept in
      // the list (model might rescue one) but ranked lower so real
      // buttons rise to the top of the 40-cand window.
      if (CONTAINER_CONTROL_TYPES.has(element.controlType)) score -= 2
      return { element, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)

  return scored.map((s, i) => ({ id: i + 1, element: s.element }))
}

/**
 * Parse the model's reply into a structured pick. Accepts a plain
 * integer ("7"), the literal "none"/"null", or a best-effort embedded
 * integer if the model strayed into prose. Tolerant on purpose so a
 * model that doesn't follow the format still works.
 */
export function parsePick(text: string): { id: number | null; reason?: string } {
  const trimmed = text.trim()
  if (!trimmed) return { id: null, reason: 'empty model reply' }
  // Refusal check FIRST — otherwise "1. none of these match" or
  // "0 none" silently misclicks the first candidate. Tolerant of
  // leading punctuation/digits when followed by an explicit "none".
  if (/^(\W|\d)*\s*(none|null|n\/a|no match|cannot|can't)\b/i.test(trimmed)) {
    return { id: null, reason: 'model said none' }
  }
  // Bare-integer-followed-by-end-or-punctuation. Anchored at the START
  // so "1. send" matches but multi-digit clusters ("1234" coordinates)
  // fail the (?=...) lookahead. Strict by design — see comment below.
  const strictInt = /^(\d{1,2})(?=[\s.,:;)\]]|$)/.exec(trimmed)
  if (strictInt) return { id: Number(strictInt[1]) }
  // v2.0 polish — the previous "loose-int anywhere" fallback was
  // demonstrably unsafe: a model reply like "The send button isn't
  // in this list, but item 3 looks similar" matched id 3 with
  // confidence "best-effort parse" and we clicked. Refuse instead.
  // The caller falls through to vision-locate when we return null,
  // which is the correct behaviour for a non-committal model reply.
  return { id: null, reason: `unparseable reply: ${trimmed.slice(0, 60)}` }
}

/**
 * Ask the model which UIA candidate matches the description. Returns
 * the picked element's centre in LOGICAL display pixels, or null.
 *
 * Calls invokeCompletion directly with `tools: []` (same trick screen
 * watch + vision/locate use) so the model can't decide to invoke
 * run_shell or pivot — it sees just the screenshot, the list, and the
 * "reply with an id" framing.
 */
export async function locateViaUiaPick(args: {
  shot: CapturedScreen
  description: string
  elements: UiaElement[]
  /** Abort signal from the agent's per-request controller, or undefined
   *  when the call isn't tied to a per-request abort (proactive turns,
   *  background tasks). The bench runner always forwards its per-cell
   *  cancel signal. v2.0 — relaxed from required to optional to match
   *  visualClick.ts's existing optional signal field; making it required
   *  here was a contract drift, not an intentional safety gate. */
  signal?: AbortSignal
}): Promise<{
  predicted: { x: number; y: number } | null
  trail: string
  msElapsed: number
  pickedElement: UiaElement | null
}> {
  const start = Date.now()
  const candidates = filterCandidates(args.elements, args.shot)
  if (candidates.length === 0) {
    return {
      predicted: null,
      trail: 'uia-pick: no candidates after filter',
      msElapsed: Date.now() - start,
      pickedElement: null
    }
  }

  const cfg = getConfig()
  const provider = cfg.activeProvider
  const model = cfg.providers[provider]?.model
  if (!model) {
    return {
      predicted: null,
      trail: 'uia-pick: no active model',
      msElapsed: Date.now() - start,
      pickedElement: null
    }
  }

  const listing = candidates
    .map(
      ({ id, element }) =>
        `${id}. ${prettyControlType(element.controlType)}: "${element.name || element.automationId || '(unnamed)'}" at (${element.x},${element.y}) ${element.w}×${element.h}`
    )
    .join('\n')

  const prompt = [
    `Target: ${args.description}`,
    '',
    'Candidates (OS accessibility tree, screenshot above):',
    listing,
    '',
    'Pick the best id, or "none". Reply with just the number.'
  ].join('\n')

  const turn: ChatTurn = {
    role: 'user',
    content: prompt,
    images: [args.shot.dataUrl]
  }

  let replyText = ''
  try {
    const result = await invokeCompletion(
      {
        requestId: `uia-pick-${randomUUID()}`,
        provider,
        model,
        system: UIA_PICK_SYSTEM,
        messages: [turn]
      },
      // Fall back to a fresh (never-fired) signal so the downstream
      // provider always sees a valid AbortSignal. Proactive turns and
      // some background-tool entrypoints call through without a per-
      // request controller; that's fine here — there's nothing for
      // them to abort against.
      args.signal ?? new AbortController().signal,
      // tools: [] — same hard-suppression vision/locate uses so the
      // model can't pivot to a tool call instead of answering.
      { tools: [] }
    )
    if (result.error) {
      return {
        predicted: null,
        trail: `uia-pick model error: ${result.error}`,
        msElapsed: Date.now() - start,
        pickedElement: null
      }
    }
    replyText = result.text || ''
  } catch (err) {
    return {
      predicted: null,
      trail: `uia-pick dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
      msElapsed: Date.now() - start,
      pickedElement: null
    }
  }

  const pick = parsePick(replyText)
  if (pick.id === null) {
    return {
      predicted: null,
      trail: `uia-pick (${candidates.length} cands): ${pick.reason ?? 'no id'}`,
      msElapsed: Date.now() - start,
      pickedElement: null
    }
  }
  const chosen = candidates.find((c) => c.id === pick.id)
  if (!chosen) {
    return {
      predicted: null,
      trail: `uia-pick: model returned id ${pick.id} not in ${candidates.length}-candidate list`,
      msElapsed: Date.now() - start,
      pickedElement: null
    }
  }

  const cx = chosen.element.x + Math.round(chosen.element.w / 2)
  const cy = chosen.element.y + Math.round(chosen.element.h / 2)
  return {
    predicted: { x: cx, y: cy },
    trail: `uia-pick (${candidates.length} cands): chose id ${pick.id} → "${chosen.element.name || chosen.element.automationId}" (${chosen.element.controlType}) at (${cx},${cy})`,
    msElapsed: Date.now() - start,
    pickedElement: chosen.element
  }
}
