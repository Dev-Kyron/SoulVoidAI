/**
 * Tests for `parsePick` — the only pure-logic surface of the v2.0
 * Phase 3 uia-pick path. The rest of uiaPickLocate.ts orchestrates IPC
 * + vision dispatch + UIA enumeration, none of which test cleanly in
 * a unit harness; integration coverage lives in the bench report.
 *
 * What we want to guard against: the model strays from "reply with
 * just the id" in known ways — leading whitespace, trailing prose,
 * markdown fences, "none" variants. parsePick should still surface
 * the right id (or null) instead of misclicking.
 */
import { describe, expect, it } from 'vitest'
import { filterCandidates, parsePick } from './uiaPickLocate'
import type { CapturedScreen } from './screenCapture'
import type { UiaElement } from './uia'

function elem(partial: Partial<UiaElement>): UiaElement {
  return {
    name: '',
    automationId: '',
    controlType: 'ControlType.Button',
    x: 100,
    y: 100,
    w: 50,
    h: 30,
    enabled: true,
    offscreen: false,
    ...partial
  } as UiaElement
}

function makeShot(overrides: Partial<CapturedScreen> = {}): CapturedScreen {
  return {
    image: {} as never,
    dataUrl: 'data:image/png;base64,_',
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    path: '',
    windowOriginX: 0,
    windowOriginY: 0,
    ...overrides
  }
}

describe('parsePick — v2.0 Phase 3 uia-pick reply parser', () => {
  it('accepts a bare integer', () => {
    expect(parsePick('7')).toEqual({ id: 7 })
  })

  it('accepts a leading integer with trailing prose', () => {
    expect(parsePick('7. Send button')).toEqual({ id: 7 })
  })

  it('handles whitespace around the answer', () => {
    expect(parsePick('   12  ')).toEqual({ id: 12 })
  })

  it.each(['none', 'None', 'NONE', 'null', 'n/a', 'N/A'])(
    'recognises "%s" as a refusal',
    (reply) => {
      const result = parsePick(reply)
      expect(result.id).toBeNull()
      expect(result.reason).toContain('none')
    }
  )

  it('returns null with a reason for empty reply', () => {
    const result = parsePick('')
    expect(result.id).toBeNull()
    expect(result.reason).toBe('empty model reply')
  })

  it('refuses to extract an id from prose (v2.0 polish — removes the loose-int fallback)', () => {
    // Pre-polish, "item 3 looks similar" would match id 3 with
    // confidence "best-effort parse" and we'd click a wrong element.
    // After polish, prose without a leading id falls through to
    // unparseable → caller falls back to vision-locate.
    expect(parsePick("I'd pick element 9 since it matches the send button").id).toBeNull()
    expect(parsePick('The button is not in this list but item 3 looks similar').id).toBeNull()
    expect(parsePick('My pick is element 23 because it looks right').id).toBeNull()
  })

  it('refuses to extract a digit from inside a multi-digit cluster', () => {
    expect(parsePick('The button is at coordinates 234,567').id).toBeNull()
  })

  it('returns null with reason when reply is unparseable', () => {
    // No leading digits AND no refusal keyword at start → unparseable.
    // The caller's "no id" guard then falls back to vision-locate.
    const result = parsePick('I think this is a question for someone else.')
    expect(result.id).toBeNull()
    expect(result.reason).toContain('unparseable')
  })

  it('treats "0 none" as refusal, not as id 0', () => {
    // Quality-review regression: pre-fix, this matched the leading
    // digit FIRST and returned { id: 0 }. id 0 doesn't exist in any
    // candidate list (ids start at 1), so the caller correctly fell
    // back to vision — but the trail string said "model picked id 0"
    // which mislead debugging. After fix, refusal check runs first.
    const result = parsePick('0 none')
    expect(result.id).toBeNull()
    expect(result.reason).toContain('none')
  })

  it('treats "1. none of these match" as refusal, not as id 1 misclick', () => {
    // CRITICAL pre-fix bug: leading "1." matched the strict-int regex
    // and returned { id: 1 } — the caller would have clicked the
    // first candidate. After fix, "none" keyword wins.
    const result = parsePick('1. none of these match the description')
    expect(result.id).toBeNull()
    expect(result.reason).toContain('none')
  })

  it('accepts "7." (digit followed by period) as id 7', () => {
    expect(parsePick('7. Send button')).toEqual({ id: 7 })
  })

  it('refuses "(7)" wrapped in parens (v2.0 polish — strict-int requires leading digit)', () => {
    // Pre-polish, "(7)" matched via the loose-int fallback. Post-polish
    // it doesn't — strict-int requires the digit at the start, and
    // there's no loose fallback. Safe refusal beats a confident wrong
    // pick; the prompt explicitly asks for a bare integer or "none".
    expect(parsePick('(7)').id).toBeNull()
  })

  it('truncates very long unparseable replies in the reason field', () => {
    const longReply = 'x'.repeat(200)
    const result = parsePick(longReply)
    expect(result.id).toBeNull()
    // Reason includes a 60-char preview, not the full 200.
    expect(result.reason).toMatch(/^unparseable reply: x{60}$/)
  })
})

describe('filterCandidates — v2.0 Phase 3 uia-pick ranking', () => {
  it('rejects elements with bbox area below MIN_BBOX_AREA (100px²)', () => {
    // 9×11 = 99 < 100 → rejected. 10×10 = 100 → kept (>=).
    const tiny = elem({ name: 'tiny', w: 9, h: 11 })
    const boundary = elem({ name: 'boundary', w: 10, h: 10 })
    const result = filterCandidates([tiny, boundary], makeShot())
    expect(result.map((r) => r.element.name)).toEqual(['boundary'])
  })

  it('rejects elements entirely off the captured screenshot', () => {
    const offRight = elem({ name: 'off-right', x: 5000, y: 100 })
    const offBottom = elem({ name: 'off-bottom', x: 100, y: 5000 })
    const offLeft = elem({ name: 'off-left', x: -200, y: 100, w: 50, h: 30 })
    const onscreen = elem({ name: 'on-screen', x: 200, y: 200 })
    const result = filterCandidates([offRight, offBottom, offLeft, onscreen], makeShot())
    expect(result.map((r) => r.element.name)).toEqual(['on-screen'])
  })

  it('honours windowed-capture bounds (windowOriginX/Y + displayWidth/Height)', () => {
    // Window at (1000, 500), 800×600. An element at (200, 200) on the
    // screen falls OUTSIDE the window crop and should be rejected.
    const shot = makeShot({
      windowOriginX: 1000,
      windowOriginY: 500,
      displayWidth: 800,
      displayHeight: 600
    })
    const insideWindow = elem({ name: 'inside', x: 1100, y: 600 })
    const outsideWindow = elem({ name: 'outside', x: 200, y: 200 })
    const result = filterCandidates([insideWindow, outsideWindow], shot)
    expect(result.map((r) => r.element.name)).toEqual(['inside'])
  })

  it('boosts named PREFERRED control types over unnamed Pane', () => {
    const button = elem({
      name: 'Send',
      controlType: 'ControlType.Button',
      x: 100,
      y: 100
    })
    const pane = elem({
      name: 'pane',
      controlType: 'ControlType.Pane',
      x: 200,
      y: 200,
      w: 600,
      h: 400
    })
    const result = filterCandidates([pane, button], makeShot())
    // Button: name +10, preferred +5 = 15. Pane: name +10, container -2 = 8.
    expect(result[0].element.name).toBe('Send')
    expect(result[1].element.name).toBe('pane')
  })

  it('demotes container control types via exact match (not substring)', () => {
    // Pane: -2 (CONTAINER), Hyperlink: +5 (PREFERRED). Both have names.
    const pane = elem({ name: 'A', controlType: 'ControlType.Pane' })
    const link = elem({ name: 'B', controlType: 'ControlType.Hyperlink' })
    const result = filterCandidates([pane, link], makeShot())
    expect(result[0].element.name).toBe('B')
    expect(result[1].element.name).toBe('A')
  })

  it('does NOT match substrings inside custom control-type names', () => {
    // 'ControlType.CustomPaneButton' contains both 'Pane' and 'Button'
    // as substrings, but exact set membership = neither preferred nor
    // container. Should score only on its name. Regression guard for
    // the quality-review finding.
    const custom = elem({
      name: 'C',
      controlType: 'ControlType.CustomPaneButton'
    })
    const realButton = elem({ name: 'D', controlType: 'ControlType.Button' })
    const result = filterCandidates([custom, realButton], makeShot())
    // Custom: name +10 = 10. Button: name +10 + preferred +5 = 15.
    expect(result[0].element.name).toBe('D')
    expect(result[1].element.name).toBe('C')
  })

  it('assigns 1-based ids after sorting', () => {
    const a = elem({ name: 'A', controlType: 'ControlType.Pane', x: 50, y: 50 })
    const b = elem({ name: 'B', controlType: 'ControlType.Button', x: 150, y: 50 })
    const c = elem({ name: 'C', controlType: 'ControlType.Hyperlink', x: 250, y: 50 })
    const result = filterCandidates([a, b, c], makeShot())
    expect(result.map((r) => r.id)).toEqual([1, 2, 3])
    // Button (15) and Hyperlink (15) tie above Pane (8). Stable sort
    // would keep input order for ties → B then C — but Array.sort is
    // not guaranteed stable across engines, so just check Pane is
    // last and that B + C come first in some order.
    expect(result[2].element.name).toBe('A')
  })
})
