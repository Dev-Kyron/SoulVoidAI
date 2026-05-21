import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basename, createLock, relativeTime } from './utils'

describe('createLock', () => {
  it('starts unlocked', () => {
    const lock = createLock()
    expect(lock.isLocked).toBe(false)
  })

  it('grants the first acquirer and denies subsequent ones until release', () => {
    const lock = createLock()
    expect(lock.tryAcquire()).toBe(true)
    expect(lock.isLocked).toBe(true)
    expect(lock.tryAcquire()).toBe(false)
    expect(lock.tryAcquire()).toBe(false)
    lock.release()
    expect(lock.isLocked).toBe(false)
    expect(lock.tryAcquire()).toBe(true)
  })

  it('release is idempotent', () => {
    const lock = createLock()
    lock.release()
    lock.release()
    expect(lock.isLocked).toBe(false)
    expect(lock.tryAcquire()).toBe(true)
  })
})

// `basename` is the renderer's POSIX/Windows-tolerant path helper used in
// chat attachments + thread titles. Lives in utils because Node's
// `path.basename` isn't available without bundling polyfills.
describe('basename', () => {
  it('returns the final segment of a POSIX path', () => {
    expect(basename('/home/user/file.txt')).toBe('file.txt')
    expect(basename('/file.txt')).toBe('file.txt')
  })
  it('returns the final segment of a Windows path', () => {
    expect(basename('C:\\Users\\Kyron\\notes.md')).toBe('notes.md')
    expect(basename('D:\\file.txt')).toBe('file.txt')
  })
  it('handles mixed separators', () => {
    expect(basename('C:\\proj/src\\file.ts')).toBe('file.ts')
  })
  it('returns the input when there is no separator', () => {
    expect(basename('plain.txt')).toBe('plain.txt')
    expect(basename('no-extension')).toBe('no-extension')
  })
  it('falls back to the input when split yields empty (trailing separator)', () => {
    // Trailing separators produce an empty final segment; the helper falls
    // back to the input so attachments labelled as folders still get a name.
    expect(basename('/path/to/')).toBe('/path/to/')
    expect(basename('C:\\folder\\')).toBe('C:\\folder\\')
  })
})

// `relativeTime` powers thread summaries and message timestamps. The
// thresholds are user-visible — locking them prevents accidental copy drift.
describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "today" for anything under 24 hours', () => {
    expect(relativeTime('2026-06-15T11:55:00.000Z')).toBe('today')
    expect(relativeTime('2026-06-14T13:00:00.000Z')).toBe('today')
  })

  it('returns "Nd ago" for 1-6 days', () => {
    expect(relativeTime('2026-06-14T12:00:00.000Z')).toBe('1d ago')
    expect(relativeTime('2026-06-09T13:00:00.000Z')).toBe('5d ago')
  })

  it('returns "Nw ago" for 7-29 days', () => {
    expect(relativeTime('2026-06-08T12:00:00.000Z')).toBe('1w ago')
    expect(relativeTime('2026-05-25T12:00:00.000Z')).toBe('3w ago')
  })

  it('falls back to a date label for 30+ days', () => {
    // 60 days ago → April 16 — locale-formatted as "Apr 16" in en
    const out = relativeTime('2026-04-16T12:00:00.000Z')
    expect(out).toMatch(/Apr\s*16|16\s*Apr/)
  })
})
