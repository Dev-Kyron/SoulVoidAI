import { describe, expect, it } from 'vitest'
import { isThrottled, matchesPolledSpec, parseHHMM } from './watchTasks'
import type { WatchSpec } from '@shared/types'

const speakAction = { type: 'speak' as const, content: 'hi' }

function spec(partial: Partial<WatchSpec> & { type: WatchSpec['type'] }): WatchSpec {
  return {
    type: partial.type,
    params: partial.params ?? {},
    action: partial.action ?? speakAction,
    throttleMinutes: partial.throttleMinutes ?? 30
  }
}

describe('parseHHMM', () => {
  it('parses a canonical HH:mm string', () => {
    expect(parseHHMM('09:00')).toBe(540)
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('23:59')).toBe(1439)
  })

  it('accepts a single-digit hour', () => {
    // "9:30" is the kind of input a user would actually type in Settings.
    expect(parseHHMM('9:30')).toBe(570)
  })

  it('rejects out-of-range values', () => {
    expect(parseHHMM('24:00')).toBeNull()
    expect(parseHHMM('25:00')).toBeNull()
    expect(parseHHMM('12:60')).toBeNull()
  })

  it('rejects malformed strings', () => {
    expect(parseHHMM('9:5')).toBeNull() // minutes must be 2 digits
    expect(parseHHMM('abc')).toBeNull()
    expect(parseHHMM('')).toBeNull()
    expect(parseHHMM('09:00:00')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(parseHHMM('  09:00  ')).toBe(540)
  })
})

describe('isThrottled', () => {
  const baseSpec = spec({ type: 'idle-duration', throttleMinutes: 60 })
  const now = new Date('2026-05-24T12:00:00.000Z')

  it('returns false when the task has never fired', () => {
    expect(isThrottled({ lastRun: null, spec: baseSpec }, now)).toBe(false)
  })

  it('returns true when last run is inside the throttle window', () => {
    // 30 min ago, throttle window is 60 min — still cooling down.
    const lastRun = new Date(now.getTime() - 30 * 60_000).toISOString()
    expect(isThrottled({ lastRun, spec: baseSpec }, now)).toBe(true)
  })

  it('returns false when last run is outside the throttle window', () => {
    // 2 hours ago, throttle window is 60 min — window has elapsed.
    const lastRun = new Date(now.getTime() - 120 * 60_000).toISOString()
    expect(isThrottled({ lastRun, spec: baseSpec }, now)).toBe(false)
  })

  it('returns false at the exact throttle boundary', () => {
    // elapsed === throttleMinutes * 60_000 → not strictly less, so allowed.
    const lastRun = new Date(now.getTime() - 60 * 60_000).toISOString()
    expect(isThrottled({ lastRun, spec: baseSpec }, now)).toBe(false)
  })

  it('returns false for an unparseable lastRun timestamp', () => {
    // Defensive — corrupt row shouldn't permanently suppress the task.
    expect(isThrottled({ lastRun: 'not-a-date', spec: baseSpec }, now)).toBe(false)
  })
})

describe('matchesPolledSpec — idle-duration', () => {
  const now = new Date('2026-05-24T12:00:00.000Z') // noon local-ish

  it('does not fire below the idle threshold', () => {
    const s = spec({ type: 'idle-duration', params: { minutes: 30 } })
    expect(matchesPolledSpec(s, now, 10)).toBe(false)
  })

  it('fires at or above the idle threshold', () => {
    const s = spec({ type: 'idle-duration', params: { minutes: 30 } })
    expect(matchesPolledSpec(s, now, 30)).toBe(true)
    expect(matchesPolledSpec(s, now, 45)).toBe(true)
  })

  it('defaults the threshold to 30 minutes when params.minutes is missing', () => {
    const s = spec({ type: 'idle-duration', params: {} })
    expect(matchesPolledSpec(s, now, 29)).toBe(false)
    expect(matchesPolledSpec(s, now, 30)).toBe(true)
  })

  it('respects the active-hours window (inside)', () => {
    const s = spec({
      type: 'idle-duration',
      params: { minutes: 10, activeFrom: '09:00', activeTo: '23:00' }
    })
    // The matcher reads from the supplied Date's local time. We construct
    // a Date whose local components are inside the window regardless of
    // the host TZ by using the Date constructor's local-time form.
    const localNoon = new Date(2026, 4, 24, 12, 0, 0) // 12:00 local
    expect(matchesPolledSpec(s, localNoon, 60)).toBe(true)
  })

  it('respects the active-hours window (outside)', () => {
    const s = spec({
      type: 'idle-duration',
      params: { minutes: 10, activeFrom: '09:00', activeTo: '17:00' }
    })
    const lateNight = new Date(2026, 4, 24, 23, 30, 0) // 23:30 local
    expect(matchesPolledSpec(s, lateNight, 60)).toBe(false)
  })

  it('ignores a malformed active-hours window and still fires', () => {
    const s = spec({
      type: 'idle-duration',
      params: { minutes: 10, activeFrom: 'abc', activeTo: 'def' }
    })
    expect(matchesPolledSpec(s, now, 60)).toBe(true)
  })
})

describe('matchesPolledSpec — time-of-day-window', () => {
  it('fires only in the exact configured minute', () => {
    const s = spec({ type: 'time-of-day-window', params: { at: '09:00' } })
    const at = new Date(2026, 4, 24, 9, 0, 0)
    const before = new Date(2026, 4, 24, 8, 59, 0)
    const after = new Date(2026, 4, 24, 9, 1, 0)
    expect(matchesPolledSpec(s, at, 0)).toBe(true)
    expect(matchesPolledSpec(s, before, 0)).toBe(false)
    expect(matchesPolledSpec(s, after, 0)).toBe(false)
  })

  it('returns false for an unparseable "at" value', () => {
    const s = spec({ type: 'time-of-day-window', params: { at: '99:99' } })
    expect(matchesPolledSpec(s, new Date(2026, 4, 24, 9, 0, 0), 0)).toBe(false)
  })
})

describe('matchesPolledSpec — event-driven types', () => {
  it('returns false for task-complete (only fires via emitter)', () => {
    const s = spec({ type: 'task-complete' })
    expect(matchesPolledSpec(s, new Date(), 99999)).toBe(false)
  })

  it('returns false for sentiment-shift (only fires via emitter)', () => {
    const s = spec({ type: 'sentiment-shift' })
    expect(matchesPolledSpec(s, new Date(), 99999)).toBe(false)
  })
})
