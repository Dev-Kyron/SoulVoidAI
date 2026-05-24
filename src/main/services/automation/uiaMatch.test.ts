import { describe, expect, it } from 'vitest'
import { matchUiaElement, tokeniseDescription } from './uiaMatch'
import { parseUiaJson } from './uia'
import type { UiaElement } from './uia'

// The UIA matcher is the trust boundary between an enumerated tree of
// hundreds of elements and the single coordinate we drive the cursor to.
// A wrong pick on a confident-but-wrong match would send the user's
// email to the wrong recipient — so every test here is about correctness,
// not about clever matching. Ambiguity must always refuse.

function elem(partial: Partial<UiaElement> & { name?: string }): UiaElement {
  return {
    name: partial.name ?? '',
    automationId: partial.automationId ?? '',
    controlType: partial.controlType ?? 'ControlType.Custom',
    x: partial.x ?? 100,
    y: partial.y ?? 100,
    w: partial.w ?? 60,
    h: partial.h ?? 30
  }
}

describe('tokeniseDescription', () => {
  it('strips common stopwords and short tokens', () => {
    expect(tokeniseDescription('the Send button')).toEqual(['send', 'button'])
    expect(tokeniseDescription('click the X to close')).toEqual(['close'])
  })

  it('handles punctuation and case', () => {
    expect(tokeniseDescription('Press "Submit", please.')).toEqual(['submit'])
  })

  it('deduplicates repeated tokens', () => {
    expect(tokeniseDescription('save the saved save')).toEqual(['save', 'saved'])
  })
})

describe('matchUiaElement', () => {
  it('returns null when no elements pass the absolute score floor', () => {
    const result = matchUiaElement(
      [elem({ name: 'Unrelated label', controlType: 'ControlType.Text' })],
      'the Send button'
    )
    expect(result).toBeNull()
  })

  it('picks a Button with a name match over a Text with the same name', () => {
    // Same name "Send" on a button vs a static text label — the user
    // almost certainly meant the button. Button preference is the
    // tiebreaker that makes this deterministic.
    const result = matchUiaElement(
      [
        elem({ name: 'Send', controlType: 'ControlType.Text' }),
        elem({ name: 'Send', controlType: 'ControlType.Button', x: 800, y: 500 })
      ],
      'Send'
    )
    expect(result).not.toBeNull()
    expect(result?.element.controlType).toBe('ControlType.Button')
    expect(result?.element.x).toBe(800)
  })

  it('refuses to choose between two equally strong matches', () => {
    // Two buttons literally named "Send" — refuse so vision-locate can
    // try to disambiguate using visual cues (colour, position) that
    // UIA can't see.
    const result = matchUiaElement(
      [
        elem({ name: 'Send', controlType: 'ControlType.Button' }),
        elem({ name: 'Send', controlType: 'ControlType.Button', x: 500 })
      ],
      'the Send button'
    )
    expect(result).toBeNull()
  })

  it('prefers an exact name match over a substring match', () => {
    // "Send" exact match wins over "Send a copy" substring — the user
    // gave the simplest description, take the simplest target.
    const result = matchUiaElement(
      [
        elem({ name: 'Send a copy', controlType: 'ControlType.Button' }),
        elem({ name: 'Send', controlType: 'ControlType.Button', x: 1000 })
      ],
      'Send'
    )
    expect(result).not.toBeNull()
    expect(result?.element.name).toBe('Send')
  })

  it('matches against AutomationId when name is empty', () => {
    // Web content sometimes has data-testid set but no aria-label;
    // Chromium maps testid → AutomationId. We should still find it.
    const result = matchUiaElement(
      [elem({ automationId: 'send-button', controlType: 'ControlType.Button' })],
      'send button'
    )
    expect(result).not.toBeNull()
    expect(result?.element.automationId).toBe('send-button')
  })

  it('returns null for empty input or stopword-only descriptions', () => {
    expect(matchUiaElement([], 'anything')).toBeNull()
    // "click the" tokenises to nothing meaningful → can't match.
    expect(matchUiaElement([elem({ name: 'Send' })], 'click the')).toBeNull()
  })

  it('produces a confidence in [0.6, 0.95]', () => {
    // Confidence is shown to the user in the preview HUD. It must
    // never read 100% (we're never that sure) nor below 60% (we
    // wouldn't have matched at all at that score).
    const result = matchUiaElement(
      [elem({ name: 'Send', controlType: 'ControlType.Button' })],
      'Send'
    )
    expect(result?.confidence).toBeGreaterThanOrEqual(0.6)
    expect(result?.confidence).toBeLessThanOrEqual(0.95)
  })

  it('hard-rejects a large browser-pane container even with a strong name match', () => {
    // v1.9.3 regression — Opera exposes the whole browser viewport as
    // a single Pane named after the page title ("Messenger | Facebook
    // - Opera"). Without the container reject, the Pane scores 10 on
    // "Messenger" + "Facebook" matches from the description "the Send
    // button in the Facebook Messenger composer" and we click the
    // centre of the browser window instead of the actual button.
    // Fix: any Pane / Window / Document / Group / Custom with area
    // ≥ 200,000 px² is structural framing, never a click target.
    const browserPane = elem({
      name: 'Messenger | Facebook - Opera',
      controlType: 'ControlType.Pane',
      x: 0,
      y: 0,
      w: 1442,
      h: 1030
    })
    const result = matchUiaElement(
      [browserPane],
      'the Send button in the Facebook Messenger composer'
    )
    expect(result).toBeNull()
  })

  it('does NOT reject small Panes (small containers can be legitimate targets)', () => {
    // A 200×100 Pane is small enough to be a real interactive region —
    // dropdown panel, popover, etc. Only the LARGE ones are framing.
    const smallPane = elem({
      name: 'Send',
      controlType: 'ControlType.Pane',
      w: 200,
      h: 100
    })
    const result = matchUiaElement([smallPane], 'Send')
    // Should still match — small enough to be a real target. Confidence
    // may be lower than a Button but it shouldn\'t be rejected outright.
    expect(result).not.toBeNull()
  })

  it('prefers a small Button over a similarly-named large Pane', () => {
    // The realistic Messenger scenario: there\'s a browser Pane named
    // "Messenger | Facebook - Opera" (rejected, large) AND a smaller
    // accessible "Send" element inside it. The smaller one must win.
    const browserPane = elem({
      name: 'Messenger | Facebook - Opera',
      controlType: 'ControlType.Pane',
      w: 1442,
      h: 1030
    })
    const sendButton = elem({
      name: 'Send',
      controlType: 'ControlType.Button',
      x: 1380,
      y: 980,
      w: 36,
      h: 36
    })
    const result = matchUiaElement([browserPane, sendButton], 'the Send button on Facebook Messenger')
    expect(result).not.toBeNull()
    expect(result?.element.name).toBe('Send')
    expect(result?.element.controlType).toBe('ControlType.Button')
  })

  it('penalises over-large elements so the tighter target wins on ties', () => {
    // v1.9.3 — even non-container types get a soft penalty above
    // 300×200. A 1000×400 "Send Hero" Button shouldn\'t beat a 60×30
    // "Send" Button when both match the same keyword.
    const heroButton = elem({
      name: 'Send',
      controlType: 'ControlType.Button',
      w: 1000,
      h: 400
    })
    const tightButton = elem({
      name: 'Send',
      controlType: 'ControlType.Button',
      x: 800,
      y: 500,
      w: 60,
      h: 30
    })
    const result = matchUiaElement([heroButton, tightButton], 'Send')
    expect(result?.element.x).toBe(800)
  })

  it('penalises overly long element names so the tightest target wins', () => {
    // "Send" beats "Click here to send your draft message to the
    // selected recipient now" even though both contain "send".
    const result = matchUiaElement(
      [
        elem({
          name: 'Click here to send your draft message to the selected recipient now',
          controlType: 'ControlType.Button'
        }),
        elem({ name: 'Send', controlType: 'ControlType.Button', x: 999 })
      ],
      'Send'
    )
    expect(result?.element.x).toBe(999)
  })
})

describe('parseUiaJson', () => {
  it('parses a normal JSON array from PowerShell', () => {
    const raw = '[{"name":"Send","automationId":"","controlType":"ControlType.Button","x":100,"y":200,"w":60,"h":30}]'
    expect(parseUiaJson(raw)).toEqual([
      {
        name: 'Send',
        automationId: '',
        controlType: 'ControlType.Button',
        x: 100,
        y: 200,
        w: 60,
        h: 30
      }
    ])
  })

  it('wraps PowerShell single-object output in an array', () => {
    // PowerShell\'s ConvertTo-Json doesn\'t wrap a 1-item collection in []
    // by default. Without this tolerance the parser would silently
    // produce an empty array on single-result enumerations.
    const raw = '{"name":"Send","automationId":"","controlType":"ControlType.Button","x":1,"y":2,"w":3,"h":4}'
    expect(parseUiaJson(raw)).toHaveLength(1)
  })

  it('returns [] on empty input, BOM, or invalid JSON', () => {
    expect(parseUiaJson('')).toEqual([])
    expect(parseUiaJson('﻿')).toEqual([])
    expect(parseUiaJson('garbage{not json')).toEqual([])
  })

  it('drops elements with non-numeric bounds', () => {
    // Defensive — PowerShell occasionally emits null/strings for
    // BoundingRectangle fields when the element disappeared mid-walk.
    const raw = '[{"name":"X","x":"oops","y":0,"w":1,"h":1}]'
    expect(parseUiaJson(raw)).toEqual([])
  })
})
