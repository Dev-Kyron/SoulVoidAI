import { afterEach, describe, expect, it } from 'vitest'
import {
  abortAll,
  abortRequest,
  registerAbortable,
  unregisterAbortable,
  __registrySize
} from './abort-registry'

// Locks the contract that powers "Stop kills the tool calls too" — without
// it, vs.ai.abort(requestId) only halted the LLM stream and the in-flight
// web_fetch / run_python / generate_image kept running invisibly.

afterEach(() => {
  // Tests register controllers; clean up so leaks don't carry between cases.
  abortAll()
})

describe('abort-registry', () => {
  it('aborts every controller registered against a single request', () => {
    const llm = new AbortController()
    const fetch = new AbortController()
    const subprocess = new AbortController()
    registerAbortable('req-1', llm)
    registerAbortable('req-1', fetch)
    registerAbortable('req-1', subprocess)

    abortRequest('req-1')

    expect(llm.signal.aborted).toBe(true)
    expect(fetch.signal.aborted).toBe(true)
    expect(subprocess.signal.aborted).toBe(true)
  })

  it('isolates requests — aborting req-1 does NOT abort req-2', () => {
    const a = new AbortController()
    const b = new AbortController()
    registerAbortable('req-1', a)
    registerAbortable('req-2', b)

    abortRequest('req-1')

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })

  it('cleans the entry after abort so subsequent aborts are no-ops', () => {
    const ctrl = new AbortController()
    registerAbortable('req-1', ctrl)
    expect(__registrySize()).toBe(1)
    abortRequest('req-1')
    expect(__registrySize()).toBe(0)
    // Calling again must not throw — registry is gone.
    abortRequest('req-1')
  })

  it('unregisterAbortable removes the entry without aborting', () => {
    const ctrl = new AbortController()
    registerAbortable('req-1', ctrl)
    unregisterAbortable('req-1', ctrl)
    expect(ctrl.signal.aborted).toBe(false)
    expect(__registrySize()).toBe(0)
  })

  it('unregister keeps other controllers for the same request alive', () => {
    const llm = new AbortController()
    const fetch = new AbortController()
    registerAbortable('req-1', llm)
    registerAbortable('req-1', fetch)

    // Fetch completed first — unregister it. LLM is still running.
    unregisterAbortable('req-1', fetch)
    expect(__registrySize()).toBe(1)

    // User clicks Stop — only the still-registered LLM gets aborted.
    abortRequest('req-1')
    expect(llm.signal.aborted).toBe(true)
    expect(fetch.signal.aborted).toBe(false)
  })

  it('abortAll aborts every controller across every request', () => {
    const a = new AbortController()
    const b = new AbortController()
    const c = new AbortController()
    registerAbortable('req-1', a)
    registerAbortable('req-1', b)
    registerAbortable('req-2', c)

    abortAll()

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(c.signal.aborted).toBe(true)
    expect(__registrySize()).toBe(0)
  })

  it('handles a controller that throws on abort gracefully', () => {
    // Defensive: a future controller subclass that throws shouldn't take
    // down the rest of the group.
    const angry = {
      abort: () => {
        throw new Error('I refuse')
      },
      signal: { aborted: false } as AbortSignal
    } as unknown as AbortController
    const calm = new AbortController()
    registerAbortable('req-1', angry)
    registerAbortable('req-1', calm)

    expect(() => abortRequest('req-1')).not.toThrow()
    expect(calm.signal.aborted).toBe(true)
  })
})
