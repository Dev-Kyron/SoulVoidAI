/**
 * v1.8.0 — vision-guided element locator.
 *
 * Given a screenshot of the user's desktop and a plain-English description
 * of a UI element ("the Send button in Gmail"), ask the active vision-capable
 * LLM where that element is and return pixel coordinates. The reply must be
 * a strict JSON envelope — same idea as `screenWatch.ts`'s decision JSON —
 * so we can parse it without prose-stripping shenanigans.
 *
 * Output coordinates are in the same pixel space as the screenshot bytes
 * (raw display pixels including DPI scaling). The caller is responsible
 * for normalising to logical coords if its click API expects them (Windows
 * `mouse_event` does accept raw pixels so on the canonical wake-word path
 * no conversion is needed).
 *
 * Design choices:
 *  - We pass the screenshot as a data URL on a single user turn, matching the
 *    `screenWatch.ts` invocation shape. Every supported vision provider
 *    (OpenAI, Anthropic, Gemini, Ollama LLaVA) accepts that format via the
 *    shared `invokeCompletion` adapter.
 *  - We suppress the agent tool registry (`{ tools: [] }`) so the model can't
 *    sidetrack into "let me web_search how to click Send" — we want a JSON
 *    answer and only a JSON answer.
 *  - The prompt is intentionally short. Longer prompts wire-feed cost without
 *    measurably improving locate accuracy in beta.
 */
import { randomUUID } from 'node:crypto'
import { invokeCompletion } from '../ai'
import { getConfig } from '../storage/config'
import type { ChatTurn } from '@shared/types'

export interface LocatedTarget {
  /** Pixel x in screenshot space. */
  x: number
  /** Pixel y in screenshot space. */
  y: number
  /** Model's confidence 0-1 (self-reported, treat as a hint). */
  confidence: number
  /** Short label the model used internally — surfaced in the preview HUD. */
  label: string
}

export interface LocateFailure {
  ok: false
  reason: string
}

export type LocateOutcome = ({ ok: true } & LocatedTarget) | LocateFailure

const LOCATE_SYSTEM = `You are a UI element locator for VoidSoul AI Companion. You are shown a screenshot of the user's desktop and asked to find a specific element described in plain English. Reply with the pixel coordinates of the centre of that element, or refuse if you genuinely cannot find any plausible candidate.

CRITICAL CONTEXT: The user sees a 3-second cancellable preview HUD with a target ring at your coordinates BEFORE the click actually fires. Wrong locates are recoverable — they just press Esc and the click is cancelled. Refusing wastes their time. BIAS TOWARD COMMITTING TO A LIKELY MATCH over refusing.

Reply with STRICT JSON, no markdown fences, no prose:
{ "found": boolean, "x": number, "y": number, "confidence": number, "label": string, "reason": string }

Precision rules:
- The screenshot uses top-left as origin (0,0). x grows rightward, y grows downward, both in pixels.
- x,y MUST be the visual CENTRE of the clickable target — not the corner, not nearby text. For a button, that's the centre of the button's coloured/bordered rectangle, NOT the centre of any adjacent label.
- Verify your coordinates twice before answering. Imagine drawing a small ring at (x,y) — does that ring sit ON the element you described? If not, adjust.
- If the element is tiny (under 30 pixels in either dimension), be especially careful — small targets are where errors compound — but still commit if you have a plausible candidate.
- Confidence calibration: 0.9+ = clearly visible unambiguous match. 0.6-0.8 = plausible but small/blurry/partially occluded. 0.3-0.5 = best-guess at the conventional location for this UI pattern. Anything you'd actually commit to clicking should score ≥ 0.3.

When to commit vs refuse (READ CAREFULLY):
- COMMIT (found=true) when: you see ANY plausible candidate at the expected location, even if the icon shape doesn't perfectly match common examples. A small icon at the bottom-right of a chat compose area is almost certainly the Send button regardless of whether it looks exactly like a paper plane, arrow, triangle, chevron, or anything else. Positional hints in the prompt body tell you where the target lives — use them as strong priors.
- COMMIT (found=true) when: there's only one plausible candidate. Even if you can't read its label, if it's the only icon at the conventional spot, that's it.
- REFUSE (found=false) only when: the element category is genuinely not visible (e.g. user asked for the "Send" button but no compose area is even on screen), or when multiple plausible candidates exist in different locations and you'd be guessing which (e.g. two equally-prominent Send buttons in different panels). When you refuse, name specifically why in reason ("no compose area visible on screen" / "two equally-plausible Reply buttons — clarify which thread").

Success format:
- found=true: x,y are integers in screenshot pixel space. confidence 0-1. label is a short tag echoing what you found ("Send button"). reason is empty.
- Never invent coordinates outside the screenshot's dimensions.`

const TIMEOUT_MS = 30_000
const MAX_DESCRIPTION_CHARS = 240

/**
 * v1.9.4 — positional priors for common UI patterns. Vision models even
 * at frontier scale struggle to identify small icon-only buttons in busy
 * UIs (e.g. the paper-plane Send icon in Messenger). Telling them where
 * the target conventionally lives dramatically improves locate accuracy
 * for icon buttons.
 *
 * Patterns are intentionally additive — multiple hints can apply if the
 * description matches several. The model uses them as priors, not hard
 * rules; if the screenshot shows the button somewhere unconventional,
 * the visual evidence still wins.
 *
 * Each `pattern` is a regex tested case-insensitively against the
 * description. Add new entries when you observe a consistent failure
 * mode for a category of button.
 */
interface PositionalHint {
  pattern: RegExp
  hint: string
}

const POSITIONAL_HINTS: PositionalHint[] = [
  {
    // Send / Submit / Post — chat & form CTAs
    pattern: /\b(?:send|submit|post|reply send|message send)\b/i,
    hint:
      'SEND / SUBMIT / POST buttons in chat / messaging apps:\n' +
      '- LOCATION: almost always at the BOTTOM-RIGHT of the message compose area, immediately to the right of the text input field. The compose area itself is at the BOTTOM of the chat window — never in the message scroll region above.\n' +
      '- SIZE: typically 24-48 pixels square (sometimes a circle).\n' +
      "- SHAPE: COULD BE almost any small icon — paper-plane (✈), right-pointing arrow (→ / ➤), chevron, triangle, plus, circle-with-arrow-inside (common in Messenger/WhatsApp), upward arrow, even just a coloured circle. Do NOT refuse just because the icon shape doesn't look exactly like a paper plane — ANY small interactive-looking icon at the bottom-right of the compose area is almost certainly the Send target. Position is a much stronger signal than icon shape for this category.\n" +
      "- COLOUR: frequently the app's brand accent (blue for Messenger/Discord/Twitter, purple for Slack, red for Gmail), but plenty of apps use white-on-grey or muted styles. Colour is a tiebreaker, not a requirement.\n" +
      "- COMMIT RULE: if you see any clickable-looking icon at the conventional position (bottom-right of compose, right of text input), commit to it with confidence 0.5-0.7. The user has a preview HUD to cancel if you're wrong.\n" +
      '- DO NOT confuse with: timestamp text like "Sent 3d ago" / "Sent at 4:05pm" (informational, not interactive — these sit next to message bubbles in the scroll area, NOT in the compose area). Emoji-picker icons (smiley face — usually just LEFT of the Send button). The text input field itself.'
  },
  {
    // Close / Dismiss / X
    pattern: /\b(?:close|dismiss|cancel(?:lation)?|x button)\b/i,
    hint: "CLOSE / DISMISS / X buttons: almost always in the TOP-RIGHT corner of the window or dialog they belong to. Typically a small X shape (20-40 px). On modal dialogs the X is in the dialog's own top-right, not the parent window's."
  },
  {
    // Reply / Forward / message actions
    pattern: /\b(?:reply|forward|reaction|react|thread)\b/i,
    hint: "REPLY / FORWARD / REACTION buttons: appear adjacent to or below individual message bubbles, often in a small hover-revealed toolbar row. Look in the immediate vicinity of message content rather than at window edges. They're usually icon-only (curved arrow for reply, right-arrow with line for forward, smiley for reaction)."
  },
  {
    // Settings / Preferences / gear
    pattern: /\b(?:settings|preferences|options|gear|cog)\b/i,
    hint: 'SETTINGS buttons: usually a gear/cog icon (⚙). Commonly found in the top-right area of a window, in a sidebar, or in a menu bar. Sometimes accessed via a three-dots overflow menu.'
  },
  {
    // Hamburger / menu
    pattern: /\b(?:menu|hamburger|three.dots?|more options?|overflow)\b/i,
    hint: 'MENU buttons: usually a hamburger icon (☰) or three dots (⋮ vertical, ⋯ horizontal). Hamburger menus are typically top-left; three-dots overflow menus are often top-right of toolbars or adjacent to individual items.'
  },
  {
    // Search
    pattern: /\bsearch\b/i,
    hint: 'SEARCH inputs: usually at the top of the window, often top-left or top-centered, with a magnifying glass icon (🔍). Either a button that opens a search field or an always-visible text input.'
  },
  {
    // New / Compose / +
    pattern: /\b(?:new (?:message|email|chat|conversation|note|tab)|compose|create new)\b/i,
    hint: 'NEW / COMPOSE buttons: prominently placed, usually top-left of a list pane or as a floating action button bottom-right. Often a + (plus) icon, a pencil/edit icon, or a labeled "New" / "Compose" button. Stands out from the surrounding UI.'
  }
]

/**
 * Returns concatenated positional hints for any patterns that match the
 * description. Empty string when no patterns apply (most arbitrary clicks).
 * Exported for unit tests.
 */
export function getPositionalHints(description: string): string {
  const matched: string[] = []
  for (const h of POSITIONAL_HINTS) {
    if (h.pattern.test(description)) matched.push(h.hint)
  }
  return matched.join('\n\n')
}

/**
 * Locates a UI element on the supplied screenshot using the user's active
 * vision-capable LLM. Returns ok=true with pixel coords on success, ok=false
 * with a reason on failure. Never throws — every failure path is wrapped.
 *
 * `refinement: true` switches the prompt to a refinement-pass variant that
 * tells the model "this is a zoomed-in crop of a prior prediction — find
 * the target's centre in THIS crop's coord space". Used by the two-pass
 * refinement in visualClick.ts (v1.8.2+) where the first-pass coords seed
 * a 500×500 crop that gets located again at much higher effective density.
 */
export async function locateElement(args: {
  screenshotDataUrl: string
  width: number
  height: number
  description: string
  refinement?: boolean
  signal?: AbortSignal
}): Promise<LocateOutcome> {
  const description = args.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
  if (!description) return { ok: false, reason: 'No element description supplied.' }

  const cfg = getConfig()
  const provider = cfg.activeProvider
  const model = cfg.providers[provider]?.model
  if (!model) return { ok: false, reason: 'No active AI model is configured.' }

  // Compose two abort sources: caller's signal AND a per-call timeout, so a
  // hung provider doesn't leave the preview HUD spinning forever.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onUpstream = (): void => controller.abort()
  args.signal?.addEventListener('abort', onUpstream)

  // v1.9.4 — positional priors injected when description matches known
  // UI patterns. Helps the model bias toward the conventional location
  // for icon-only buttons it would otherwise miss.
  const hints = getPositionalHints(description)
  const hintsBlock = hints
    ? `\nPOSITIONAL HINTS (use as priors, not hard rules — visual evidence wins if it disagrees):\n${hints}\n`
    : ''

  const promptBody = args.refinement
    ? // Refinement pass — model is told this is a crop centred on a prior
      // prediction. The target is almost certainly visible and close to
      // the centre; we want a precise refined coordinate in this crop's
      // own coordinate space (NOT mapped back to the original screen).
      `REFINEMENT PASS. This image is a zoomed-in ${args.width}×${args.height} pixel crop of a previous prediction region. The element "${description}" should be visible in this crop, most likely near the centre. Find its EXACT visual centre and reply with pixel coordinates IN THIS CROP'S COORDINATE SPACE (top-left = 0,0; bottom-right = ${args.width - 1},${args.height - 1}). Do not map coordinates back to the original screenshot — the caller will project them. If the target is NOT in this crop (the prior prediction was wrong), reply with found=false.${hintsBlock}\n` +
      'Reply with the strict JSON envelope.'
    : `Find this element on my screen: "${description}".\n` +
      `Screenshot dimensions are ${args.width}×${args.height} pixels.${hintsBlock}\n` +
      'Reply with the strict JSON envelope.'

  const turn: ChatTurn = {
    role: 'user',
    content: promptBody,
    images: [args.screenshotDataUrl]
  }

  try {
    const result = await invokeCompletion(
      {
        requestId: `visual-locate-${randomUUID()}`,
        provider,
        model,
        system: LOCATE_SYSTEM,
        messages: [turn]
      },
      controller.signal,
      // Hard-suppress agent tools — we want JSON, not "the model decided
      // to call run_shell to grep for the button". Same trick screenWatch uses.
      { tools: [] }
    )
    if (result.error) {
      return { ok: false, reason: `Vision provider error: ${result.error}` }
    }
    const parsed = parseLocateResponse(result.text, args.width, args.height)
    // v1.10.1 — retry once on JSON parse failure. Smaller / cheaper
    // models (gpt-4o-mini in particular) occasionally lapse into
    // conversational replies even when system-prompted for strict
    // JSON. Cost: one extra vision call on the unlucky ~5% of calls
    // that miss. Worth it vs giving up and showing a "couldn't parse"
    // failure to the user.
    if (!parsed.ok && parsed.reason === 'Model reply was not valid JSON.') {
      const retryTurn: ChatTurn = {
        role: 'user',
        content:
          'Your last reply was not valid JSON. Reply ONLY with the JSON envelope ' +
          '({ "found": ..., "x": ..., "y": ..., "confidence": ..., "label": ..., ' +
          '"reason": ... }) — no prose, no markdown fences, nothing else.\n\n' +
          promptBody,
        images: [args.screenshotDataUrl]
      }
      const retry = await invokeCompletion(
        {
          requestId: `visual-locate-retry-${randomUUID()}`,
          provider,
          model,
          system: LOCATE_SYSTEM,
          messages: [retryTurn]
        },
        controller.signal,
        { tools: [] }
      )
      if (retry.error) {
        return { ok: false, reason: `Vision retry failed: ${retry.error}` }
      }
      return parseLocateResponse(retry.text, args.width, args.height)
    }
    return parsed
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'Vision lookup timed out or was cancelled.' }
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Vision call failed.'
    }
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onUpstream)
  }
}

/**
 * Strict-JSON parser with markdown-fence tolerance (Gemini in particular
 * wraps JSON in ```json...``` even when told not to). Clamps coords to the
 * screenshot bounds so a hallucinated (99999, 99999) can't drive the mouse
 * off-screen. Exported for unit tests.
 */
export function parseLocateResponse(raw: string, width: number, height: number): LocateOutcome {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    // Pure parser — no logger side effect. The orchestrator surfaces the
    // failure reason via its ActionResult error path.
    return { ok: false, reason: 'Model reply was not valid JSON.' }
  }

  if (json.found !== true) {
    const reason =
      typeof json.reason === 'string' && json.reason.trim()
        ? json.reason.trim().slice(0, 200)
        : 'Model could not locate the element.'
    return { ok: false, reason }
  }

  const x = typeof json.x === 'number' ? json.x : Number(json.x)
  const y = typeof json.y === 'number' ? json.y : Number(json.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: 'Model returned non-numeric coordinates.' }
  }
  // Clamp into screenshot bounds. A model that returned out-of-bounds
  // coords is almost certainly hallucinating, but clamping is safer than
  // throwing — the user can still cancel via the preview HUD.
  const clampedX = Math.max(0, Math.min(Math.round(x), width - 1))
  const clampedY = Math.max(0, Math.min(Math.round(y), height - 1))

  const confidenceRaw = typeof json.confidence === 'number' ? json.confidence : 0.5
  const confidence = Math.max(0, Math.min(1, confidenceRaw))
  const label = typeof json.label === 'string' ? json.label.trim().slice(0, 120) : ''

  return { ok: true, x: clampedX, y: clampedY, confidence, label }
}
