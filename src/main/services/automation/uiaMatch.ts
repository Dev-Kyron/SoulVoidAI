/**
 * v1.9.0 — UIA candidate matching.
 *
 * Pure scoring function: given a user description like "the Send button"
 * and the set of clickable elements enumerated from the UIA tree, return
 * the single best match if one is unambiguously best, or null if either
 * nothing matches or the top candidates are too close to call (in which
 * case the orchestrator falls back to vision-locate).
 *
 * Scoring weights are tuned for the common case ("the X button", "click
 * the Y") rather than for adversarial inputs. The "ambiguity floor"
 * (best must beat second-best by RELATIVE_GAP_MIN) is the key safety —
 * a wrong-but-confident pick is worse than no pick, because no pick
 * falls through to the vision pipeline which has its own preview HUD.
 */
import type { UiaElement } from './uia'

export interface UiaMatch {
  element: UiaElement
  /** 0-1 score the orchestrator can present to the user as confidence. */
  confidence: number
  /** Why it matched — surfaced in the preview HUD label. */
  reason: string
}

/** Top match must score this much absolutely or we refuse. Below this
 *  and even a "best" candidate is too weak to trust over vision. */
const MIN_ABSOLUTE_SCORE = 4
/** Top match must beat second-best by this RELATIVE margin or we refuse
 *  (ambiguous). 0.3 = top is at least 30% higher than runner-up. */
const RELATIVE_GAP_MIN = 0.3

/** Common stopwords to strip from the description before keyword
 *  matching. The user types "the Send button" but the button's Name is
 *  just "Send" — without stripping "button" we'd penalize the match. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'my',
  'this',
  'that',
  'on',
  'in',
  'at',
  'to',
  'click',
  'press',
  'tap',
  'choose',
  'hit',
  'please'
  // NOTE: "send" / "submit" / "select" are deliberately NOT here —
  // they're frequently the actual element Name we want to match
  // against ("Send" / "Submit" / "Select all").
])

/** Control types we prefer for click actions. Order matters — first
 *  match wins on tiebreak. Exported so the v2.0 Phase 3 uia-pick path
 *  ranks against the same canonical set the production matcher uses
 *  — adding a new type here automatically improves both paths. */
export const PREFERRED_CONTROL_TYPES = [
  'ControlType.Button',
  'ControlType.SplitButton',
  'ControlType.MenuItem',
  'ControlType.Hyperlink',
  'ControlType.TabItem',
  'ControlType.CheckBox',
  'ControlType.RadioButton',
  'ControlType.ListItem',
  'ControlType.TreeItem'
]

/** v1.9.3 — control types that are STRUCTURAL containers, never click
 *  targets when they're large. Browsers like Opera/Edge expose the whole
 *  browser viewport as a single Pane named after the page title — if
 *  that name happens to share keywords with the user's description ("the
 *  Send button in the Facebook Messenger composer" vs window title
 *  "Messenger | Facebook - Opera"), the Pane scores well and we click
 *  the centre of the browser window instead of the actual button. Hard-
 *  reject these once they cross the size threshold so the matcher falls
 *  through to vision instead. Exported for the same reason as the
 *  PREFERRED list — keeps the uia-pick taxonomy aligned. */
export const CONTAINER_CONTROL_TYPES = new Set([
  'ControlType.Pane',
  'ControlType.Window',
  'ControlType.Document',
  'ControlType.Group',
  'ControlType.Custom'
])

/** Strip the canonical `ControlType.` prefix for user-visible display.
 *  Centralised here (uiaMatch owns the taxonomy) so log lines, the
 *  preview HUD, the bench report, and Settings dialogs all render the
 *  same short form. */
export function prettyControlType(ct: string): string {
  return ct.replace(/^ControlType\./, '')
}

/** Pixel-area threshold above which a CONTAINER_CONTROL_TYPES element
 *  is treated as structural framing rather than a click target. 500×400
 *  = 200,000 px² — bigger than any realistic button (a "Buy Now" hero
 *  CTA tops out around 400×80 = 32k) but smaller than every Pane / Window
 *  that wraps actual web content. */
const CONTAINER_REJECT_AREA = 500 * 400

/** Soft penalty threshold for ANY large element regardless of type. Buttons
 *  bigger than this are almost always layout wrappers misclassified by the
 *  app developer. We don't hard-reject (some legit hero CTAs sneak above)
 *  but we shave a few points off so a properly-sized neighbour can win. */
const LARGE_ELEMENT_PENALTY_AREA = 300 * 200

/** Extracts the meaningful keywords from a user description. Lowercases,
 *  drops stopwords, drops short tokens, returns unique. "the Send button"
 *  → ["send", "button"]. "click the blue arrow icon to send" →
 *  ["blue", "arrow", "icon", "send"]. */
export function tokeniseDescription(description: string): string[] {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  return Array.from(new Set(tokens))
}

/** Scores one element against the description tokens. The composition is
 *  intentionally additive so we can explain the score in `reason`.
 *  Returns -Infinity for hard-rejected elements (large containers) so
 *  they're guaranteed to be filtered out at the MIN_ABSOLUTE_SCORE
 *  threshold rather than relying on the runner-up gap. */
function scoreElement(elem: UiaElement, tokens: string[], descriptionLower: string): number {
  const area = Math.max(1, elem.w * elem.h)

  // v1.9.3 — HARD REJECT large structural containers. The Opera browser
  // pane named "Messenger | Facebook - Opera" was matching "Messenger"
  // and "Facebook" from descriptions like "the Send button in the
  // Facebook Messenger composer" and winning, then we clicked the centre
  // of the browser window. By rejecting these outright the matcher
  // returns null and the orchestrator falls through to vision-locate
  // which can actually see the Send button in the screenshot.
  if (CONTAINER_CONTROL_TYPES.has(elem.controlType) && area >= CONTAINER_REJECT_AREA) {
    return Number.NEGATIVE_INFINITY
  }

  let score = 0
  const nameL = elem.name.toLowerCase()
  const autoL = elem.automationId.toLowerCase()

  // Exact name match (case-insensitive) is the strongest signal — that
  // means the user said "send" and there's an element literally named
  // "Send". Worth a hefty bonus over substring.
  if (nameL && nameL === descriptionLower.trim()) score += 8

  for (const token of tokens) {
    if (!token) continue
    if (nameL.includes(token)) score += 5
    if (autoL.includes(token)) score += 3
  }

  // Control-type bias: a Button matching "Send" beats a Text matching
  // "Send" because the user almost certainly meant the button.
  if (PREFERRED_CONTROL_TYPES.includes(elem.controlType)) score += 2

  // Tight-target bias: small elements (< ~80×40) are more likely to
  // be focused UI controls than sprawling containers that happen to
  // share a label. Cap the bonus so a 1×1 sliver doesn't always win.
  if (area < 80 * 40) score += 1

  // v1.9.3 — soft penalty for any element bigger than a typical button.
  // Real buttons rarely exceed 300×200; anything larger is most likely
  // a layout wrapper, hero banner, or full-pane container that happens
  // to carry a Name. Doesn't hard-reject (some legit hero CTAs are big)
  // but penalty is large enough that a properly-sized neighbour wins
  // past the runner-up ambiguity gap.
  if (area > LARGE_ELEMENT_PENALTY_AREA) {
    score -= 5
  }

  // Penalty for excessively long names — a "Send" match in an element
  // named "Click here to send your message to the chat history" is
  // weaker than a match in an element simply named "Send".
  if (nameL.length > 0) {
    const lengthPenalty = Math.min(2, Math.floor(nameL.length / 30))
    score -= lengthPenalty
  }

  return score
}

/**
 * Pick the best UIA match for the description, or null if no candidate
 * is confident enough. Exported for tests as well as the orchestrator.
 */
export function matchUiaElement(elements: UiaElement[], description: string): UiaMatch | null {
  if (elements.length === 0) return null
  const tokens = tokeniseDescription(description)
  if (tokens.length === 0) return null
  const descLower = description.toLowerCase().trim()

  const scored = elements
    .map((element) => ({ element, score: scoreElement(element, tokens, descLower) }))
    .filter((s) => s.score >= MIN_ABSOLUTE_SCORE)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return null

  const top = scored[0]
  const second = scored[1]
  // Ambiguity guard: if the second-best is within RELATIVE_GAP_MIN of
  // the top, we can't confidently choose. Better to refuse and let
  // vision-locate pick (it may use visual cues like colour / position
  // that UIA can't see).
  //
  // EXCEPTION: if the top is a preferred clickable control type
  // (Button, MenuItem, Hyperlink, …) and the runner-up ISN'T, that's
  // an unambiguous click intent — a Button labelled "Send" beats a
  // static Text labelled "Send" 100% of the time when the user said
  // "click Send". Skip the ambiguity guard for that case.
  if (second) {
    const topPreferred = PREFERRED_CONTROL_TYPES.includes(top.element.controlType)
    const secondPreferred = PREFERRED_CONTROL_TYPES.includes(second.element.controlType)
    const clearClickWinner = topPreferred && !secondPreferred
    if (!clearClickWinner) {
      if ((top.score - second.score) / top.score < RELATIVE_GAP_MIN) {
        return null
      }
    }
  }

  // Confidence: scale absolute score into a presentable 0.6-0.99 range.
  // Scores typically land 4-15; map that into a sensible 0.6-0.95 window
  // so the HUD chip reads honestly. Exact-name matches (score ≥ 13) pin
  // close to 0.95.
  const normalised = Math.min(0.95, 0.6 + (top.score - MIN_ABSOLUTE_SCORE) * 0.04)

  // Build a human-readable reason for the preview HUD.
  const nameBit = top.element.name ? `"${top.element.name}"` : top.element.automationId
  const typeBit = prettyControlType(top.element.controlType)
  const reason = `accessibility match: ${nameBit} (${typeBit})`

  return { element: top.element, confidence: normalised, reason }
}
