/**
 * v2.0 — tests for the announce slice + pushToast → announce bridge added
 * for the a11y batch (#174). The slice is small but load-bearing: every
 * toast in the app now routes through it, and the seq monotonic counter
 * is what makes the LiveRegion's key-bump trick work.
 *
 * Pure state test — no DOM, no React. Resets the store between cases so
 * earlier announcements / toasts don't leak across.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useUiStore } from './useUiStore'

describe('useUiStore — announce slice', () => {
  beforeEach(() => {
    // Drop any toasts/announcements left over from a previous test. We
    // don't reset the entire store (would clear queue handlers etc.);
    // just the surfaces these tests touch.
    useUiStore.setState({
      toasts: [],
      announcePolite: null,
      announceAssertive: null
    })
  })

  it('starts with both announcement slots empty', () => {
    const state = useUiStore.getState()
    expect(state.announcePolite).toBeNull()
    expect(state.announceAssertive).toBeNull()
  })

  it('writes polite announcements to announcePolite by default', () => {
    useUiStore.getState().announce('Saved.')
    const state = useUiStore.getState()
    expect(state.announcePolite?.text).toBe('Saved.')
    expect(state.announceAssertive).toBeNull()
  })

  it('routes assertive priority to announceAssertive', () => {
    useUiStore.getState().announce('Quota exceeded', 'assertive')
    const state = useUiStore.getState()
    expect(state.announceAssertive?.text).toBe('Quota exceeded')
    expect(state.announcePolite).toBeNull()
  })

  it('increments seq monotonically across announcements', () => {
    useUiStore.getState().announce('first')
    const firstSeq = useUiStore.getState().announcePolite?.seq ?? -1
    useUiStore.getState().announce('second')
    const secondSeq = useUiStore.getState().announcePolite?.seq ?? -1
    expect(secondSeq).toBeGreaterThan(firstSeq)
  })

  it('shares the seq counter across polite + assertive channels', () => {
    // Both channels increment the same monotonic counter — that way a
    // future LiveRegion that prefers the most-recent announcement (across
    // priorities) can compare seqs without ambiguity. Locked here so a
    // future split-counter refactor surfaces.
    useUiStore.getState().announce('polite one')
    const politeSeq = useUiStore.getState().announcePolite?.seq ?? -1
    useUiStore.getState().announce('assertive one', 'assertive')
    const assertiveSeq = useUiStore.getState().announceAssertive?.seq ?? -1
    expect(assertiveSeq).toBeGreaterThan(politeSeq)
  })

  it('trims whitespace and drops empty / whitespace-only announcements', () => {
    useUiStore.getState().announce('   ')
    expect(useUiStore.getState().announcePolite).toBeNull()
    useUiStore.getState().announce('')
    expect(useUiStore.getState().announcePolite).toBeNull()
    // The seq SHOULDN'T have advanced for the dropped calls — otherwise
    // the LiveRegion would key-bump on no-op announcements.
    useUiStore.getState().announce('real')
    const polite = useUiStore.getState().announcePolite
    expect(polite?.text).toBe('real')
  })

  it('trims surrounding whitespace from announcement text', () => {
    useUiStore.getState().announce('  hello  ')
    expect(useUiStore.getState().announcePolite?.text).toBe('hello')
  })

  it('bumps seq even when announcing identical text twice', () => {
    // The whole point of seq is to make the LiveRegion's key-bump trick
    // work for repeat strings. If a future refactor short-circuited
    // identical text, the LiveRegion wouldn't re-announce "Saved." twice
    // in a row.
    useUiStore.getState().announce('Saved.')
    const firstSeq = useUiStore.getState().announcePolite?.seq ?? -1
    useUiStore.getState().announce('Saved.')
    const secondSeq = useUiStore.getState().announcePolite?.seq ?? -1
    expect(secondSeq).toBeGreaterThan(firstSeq)
  })
})

describe('useUiStore — pushToast → announce bridge', () => {
  // The toasts use window.setTimeout for auto-dismiss; with happy-dom
  // those would otherwise leak and bleed into later tests. Faking
  // timers gives us deterministic control + an explicit afterEach
  // to advance + restore real timers.
  beforeEach(() => {
    vi.useFakeTimers()
    useUiStore.setState({
      toasts: [],
      announcePolite: null,
      announceAssertive: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mirrors info toasts to the polite announce channel', () => {
    useUiStore.getState().pushToast('info', 'Synced.')
    const state = useUiStore.getState()
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0].message).toBe('Synced.')
    expect(state.announcePolite?.text).toBe('Synced.')
    expect(state.announceAssertive).toBeNull()
  })

  it('mirrors success toasts to the polite channel', () => {
    useUiStore.getState().pushToast('success', 'Done.')
    expect(useUiStore.getState().announcePolite?.text).toBe('Done.')
    expect(useUiStore.getState().announceAssertive).toBeNull()
  })

  it('escalates error toasts to the assertive channel', () => {
    // Error toasts must INTERRUPT — they're the only path that bypasses
    // the polite queue. SR users mashing through assistant replies
    // need to hear "Provider failed" immediately, not after the current
    // reply finishes announcing.
    useUiStore.getState().pushToast('error', 'Network down.')
    const state = useUiStore.getState()
    expect(state.announceAssertive?.text).toBe('Network down.')
    expect(state.announcePolite).toBeNull()
  })

  it('still pushes the visible toast even when text is whitespace-only', () => {
    // pushToast and announce have separate empty-string semantics — the
    // visual toast renders even if the announce path drops the empty
    // message (this is intentional; a caller that pushes "" wants the
    // visual confirmation, just nothing to read aloud).
    useUiStore.getState().pushToast('info', '   ')
    expect(useUiStore.getState().toasts).toHaveLength(1)
    expect(useUiStore.getState().announcePolite).toBeNull()
  })
})
