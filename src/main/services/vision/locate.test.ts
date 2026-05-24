import { describe, expect, it } from 'vitest'
import { parseLocateResponse, getPositionalHints } from './locate'

// The vision-locate response parser is the trust boundary between the LLM's
// freeform text and the OS-level click. Anything that gets past these
// assertions becomes pixel coordinates we'll drive the mouse to — so we
// lock down clamping, missing fields, prose contamination, and the
// markdown-fence case Gemini insists on.
describe('parseLocateResponse', () => {
  const W = 1600
  const H = 900

  it('parses a clean JSON locate result', () => {
    const raw = '{"found": true, "x": 800, "y": 450, "confidence": 0.92, "label": "Send button", "reason": ""}'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.x).toBe(800)
      expect(result.y).toBe(450)
      expect(result.confidence).toBeCloseTo(0.92)
      expect(result.label).toBe('Send button')
    }
  })

  it('returns a typed failure when the model says found=false', () => {
    const raw = '{"found": false, "x": 0, "y": 0, "confidence": 0, "label": "", "reason": "no compose window visible"}'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no compose window visible')
    }
  })

  it('strips Gemini-style markdown fences before parsing', () => {
    // Gemini wraps JSON in ```json…``` even when the system prompt says not
    // to. Same defensive strip the screen-watch parser uses.
    const raw = '```json\n{"found": true, "x": 100, "y": 200, "confidence": 0.5, "label": "icon", "reason": ""}\n```'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(true)
  })

  it('clamps out-of-bounds coordinates into the screenshot rectangle', () => {
    // Hallucinated coords past the screenshot can\'t drive the mouse off
    // the display — clamp into bounds rather than reject so the user
    // still has a preview to cancel.
    const raw = '{"found": true, "x": 99999, "y": -50, "confidence": 0.4, "label": "x", "reason": ""}'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.x).toBe(W - 1)
      expect(result.y).toBe(0)
    }
  })

  it('clamps confidence into [0, 1] regardless of model output', () => {
    const raw = '{"found": true, "x": 10, "y": 10, "confidence": 5, "label": "x", "reason": ""}'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.confidence).toBe(1)
    }
  })

  it('rejects non-numeric coordinates rather than silently zeroing', () => {
    // A model that returned strings or null for x/y is broken — failing
    // closed here is safer than coercing to NaN→0 and clicking at the
    // top-left corner of the user\'s screen.
    const raw = '{"found": true, "x": "hello", "y": null, "confidence": 0.5, "label": "x", "reason": ""}'
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(false)
  })

  it('returns a typed failure when the response is not valid JSON', () => {
    // Some providers warm up with "Sure! Here\'s what I see…" preamble
    // even when asked for strict JSON. We catch the parse error and
    // surface a clear reason rather than throwing.
    const result = parseLocateResponse('Sure! Here is the answer: {bad json}', W, H)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/JSON/i)
    }
  })

  it('caps the failure reason to keep error toasts bounded', () => {
    // Some providers return verbose reasoning in `reason`. We slice to
    // 200 chars so a 4kb reason chain can\'t blow out the chat surface.
    const longReason = 'x'.repeat(500)
    const raw = `{"found": false, "x": 0, "y": 0, "confidence": 0, "label": "", "reason": "${longReason}"}`
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.length).toBeLessThanOrEqual(200)
    }
  })

  it('truncates excessively long labels', () => {
    const longLabel = 'a'.repeat(500)
    const raw = `{"found": true, "x": 50, "y": 50, "confidence": 0.5, "label": "${longLabel}", "reason": ""}`
    const result = parseLocateResponse(raw, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.label.length).toBeLessThanOrEqual(120)
    }
  })
})

// v1.9.4 positional hint injection. The full prompt is sent to the
// vision model — these tests just lock in that the right hint fires
// for the right description keyword. Wrong-hint or missing-hint
// regressions would silently degrade locate accuracy on icon buttons.
describe('getPositionalHints', () => {
  it('returns the send-button prior for send/submit descriptions', () => {
    // The headline failure mode from the v1.9.x beta — vision missed
    // the Messenger Send arrow because it was a small icon in a busy
    // chat UI. The hint tells the model where to look (bottom-right
    // of compose) + warns about "Sent 3d ago" timestamps + commits
    // even when the icon shape isn't a literal paper-plane.
    const hint = getPositionalHints('the Send button in Messenger')
    expect(hint).toMatch(/BOTTOM-RIGHT/)
    expect(hint).toMatch(/timestamp|sent.*ago/i)
    expect(hint).toMatch(/paper-plane|arrow|chevron|triangle|circle/i)
    // v1.9.5 — must contain the commit guidance so the model doesn\'t
    // refuse on icon-shape mismatch.
    expect(hint).toMatch(/COMMIT|position is a much stronger signal/i)
  })

  it('returns the close prior for close/dismiss/X descriptions', () => {
    expect(getPositionalHints('close this dialog')).toMatch(/TOP-RIGHT/)
    expect(getPositionalHints('dismiss the popup')).toMatch(/TOP-RIGHT/)
    expect(getPositionalHints('the X button to close it')).toMatch(/TOP-RIGHT/)
  })

  it('returns the menu prior for hamburger/three-dots descriptions', () => {
    const hint = getPositionalHints('the hamburger menu')
    expect(hint).toMatch(/hamburger/i)
    expect(hint).toMatch(/top-left/i)
  })

  it('returns empty string when no patterns apply', () => {
    // Arbitrary click descriptions don't get hints — the model just
    // does normal visual analysis without bias.
    expect(getPositionalHints('the third row in the table')).toBe('')
    expect(getPositionalHints('the red dot')).toBe('')
  })

  it('combines multiple hints when several patterns match', () => {
    // "send a new message" matches both SEND and NEW/COMPOSE.
    const hint = getPositionalHints('send a new message')
    expect(hint).toMatch(/BOTTOM-RIGHT/)
    expect(hint).toMatch(/NEW \/ COMPOSE/)
  })

  it('matches case-insensitively', () => {
    expect(getPositionalHints('SEND').length).toBeGreaterThan(0)
    expect(getPositionalHints('Send').length).toBeGreaterThan(0)
    expect(getPositionalHints('send').length).toBeGreaterThan(0)
  })

  it('does NOT trip on substrings of unrelated words', () => {
    // "ascending order" must not match /send/ — \b boundaries.
    expect(getPositionalHints('the ascending order toggle')).toBe('')
    // "menubar" is part of the menu pattern via the \bmenu\b at the start
    // — that's correct because it actually IS a menu reference.
  })
})
