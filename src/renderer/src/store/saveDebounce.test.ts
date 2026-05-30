/**
 * Regression tests for the per-thread save debounce. We don't test the
 * Zustand store directly (jsdom + bridge stubs would dominate the suite);
 * instead we exercise the same Map-of-timer pattern in isolation. The shape
 * matches `useChatStore.ts` closely enough to catch the bugs the refactor
 * was meant to fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface PendingSave {
  threadId: string
  payload: string
}

function createSaver(
  write: (s: PendingSave) => void,
  debounceMs = 1200
): {
  schedule: (threadId: string, payload: string) => void
  flush: (threadId: string) => void
  invalidate: () => void
  pendingCount: () => number
} {
  const slots = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; payload: PendingSave; gen: number }
  >()
  let gen = 0
  return {
    schedule(threadId, payload) {
      const existing = slots.get(threadId)
      if (existing) clearTimeout(existing.timer)
      const snapshot: PendingSave = { threadId, payload }
      const myGen = gen
      const timer = setTimeout(() => {
        const slot = slots.get(threadId)
        slots.delete(threadId)
        if (!slot) return
        if (slot.gen !== gen) return
        if (myGen !== gen) return
        write(slot.payload)
      }, debounceMs)
      slots.set(threadId, { timer, payload: snapshot, gen: myGen })
    },
    flush(threadId) {
      const slot = slots.get(threadId)
      if (!slot) return
      clearTimeout(slot.timer)
      slots.delete(threadId)
      if (slot.gen !== gen) return
      write(slot.payload)
    },
    invalidate() {
      gen++
      for (const slot of slots.values()) clearTimeout(slot.timer)
      slots.clear()
    },
    pendingCount: () => slots.size
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('per-thread save debounce', () => {
  it('writes once after the debounce window when no further schedules arrive', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'first')
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(1200)
    expect(writes).toEqual([{ threadId: 'A', payload: 'first' }])
  })

  it('coalesces rapid schedules into a single write', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'one')
    vi.advanceTimersByTime(200)
    s.schedule('A', 'two')
    vi.advanceTimersByTime(200)
    s.schedule('A', 'three')
    vi.advanceTimersByTime(1200)
    expect(writes).toEqual([{ threadId: 'A', payload: 'three' }])
  })

  it('keeps per-thread pending saves independent', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'A1')
    vi.advanceTimersByTime(600)
    s.schedule('B', 'B1')
    expect(s.pendingCount()).toBe(2)
    // A's timer fires first (it was scheduled 600ms earlier).
    vi.advanceTimersByTime(600)
    expect(writes).toEqual([{ threadId: 'A', payload: 'A1' }])
    vi.advanceTimersByTime(600)
    expect(writes).toEqual([
      { threadId: 'A', payload: 'A1' },
      { threadId: 'B', payload: 'B1' }
    ])
  })

  it('flush(threadId) writes that thread immediately and clears its timer', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'urgent')
    s.flush('A')
    expect(writes).toEqual([{ threadId: 'A', payload: 'urgent' }])
    // Subsequent timer firing must not double-write.
    vi.advanceTimersByTime(2000)
    expect(writes).toHaveLength(1)
  })

  it('flush of a thread with nothing pending is a no-op', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.flush('A')
    expect(writes).toEqual([])
  })

  it('invalidate cancels every pending write across all threads', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'A1')
    s.schedule('B', 'B1')
    s.schedule('C', 'C1')
    s.invalidate()
    vi.advanceTimersByTime(5000)
    expect(writes).toEqual([])
    // After invalidation, new schedules work normally.
    s.schedule('A', 'A2')
    vi.advanceTimersByTime(1200)
    expect(writes).toEqual([{ threadId: 'A', payload: 'A2' }])
  })

  it('a save scheduled before invalidate does not land after it', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'old')
    vi.advanceTimersByTime(600)
    s.invalidate()
    // Stale snapshot's timer was already cleared by invalidate; this catches
    // the gen-mismatch path too.
    vi.advanceTimersByTime(600)
    expect(writes).toEqual([])
  })

  it('rapid thread switch pattern: edit A, switch to B (flush A), edit B', () => {
    const writes: PendingSave[] = []
    const s = createSaver((p) => writes.push(p))
    s.schedule('A', 'A typed')
    // Simulate a thread switch — flush A's pending save right now.
    s.flush('A')
    expect(writes).toEqual([{ threadId: 'A', payload: 'A typed' }])
    // Now editing in B schedules its own save.
    s.schedule('B', 'B typed')
    vi.advanceTimersByTime(1200)
    expect(writes).toEqual([
      { threadId: 'A', payload: 'A typed' },
      { threadId: 'B', payload: 'B typed' }
    ])
  })
})
