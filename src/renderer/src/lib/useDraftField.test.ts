/// <reference lib="dom" />
// Tell React it's inside an act-compatible test runner so the warning
// noise about `act(...)` doesn't pollute the test output.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useDraftField, type DraftField } from './useDraftField'

// Locks the contract that the cross-window snap-back bug actually doesn't
// recur. Every assertion here corresponds to a real failure mode the agent
// audit surfaced.
//
// `@testing-library/react` isn't installed (single dep for one test file is
// not worth it), so we mount the hook inside a tiny probe component via
// `react-dom/client` and surface the latest hook return value through a
// captured ref. happy-dom (already a devDep) provides the document/Root.

let container: HTMLDivElement
let root: Root

/**
 * Mounts a tiny Probe component that calls the hook and exposes the live
 * hook return value via a getter (`probe.current`) so each test reads the
 * latest value after rerenders, not a snapshot from mount time.
 */
function mount<T>(
  initialSource: T,
  commit: (next: T) => void | Promise<void>,
  debounceMs?: number
): {
  readonly current: DraftField<T>
  rerender: (next: T) => void
  unmount: () => void
} {
  const captured = { current: null as unknown as DraftField<T> }
  let setSource: (next: T) => void = () => {}

  function Probe({ source }: { source: T }): null {
    const field = useDraftField({ source, commit, debounceMs })
    captured.current = field
    return null
  }

  // Use React directly rather than the require() trick — avoids the
  // require/import dance in ESM tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react')
  function Wrapper(): React.ReactElement {
    const [source, setS] = React.useState(initialSource)
    setSource = setS
    return createElement(Probe, { source })
  }

  act(() => {
    root.render(createElement(Wrapper))
  })
  return {
    // Getter — reads the ref every access so rerenders are observed.
    get current(): DraftField<T> {
      return captured.current
    },
    rerender: (next) => {
      act(() => setSource(next))
    },
    unmount: () => {
      act(() => root.unmount())
    }
  }
}

describe('useDraftField', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    try {
      act(() => root.unmount())
    } catch {
      /* already unmounted by the test */
    }
    container.remove()
    vi.useRealTimers()
  })

  it('starts with the source value', () => {
    const commit = vi.fn()
    const probe = mount('hello', commit)
    expect(probe.current.value).toBe('hello')
    expect(commit).not.toHaveBeenCalled()
  })

  it('re-syncs from source when the user is NOT editing', () => {
    const commit = vi.fn()
    const probe = mount<string>('first', commit)
    expect(probe.current.value).toBe('first')
    probe.rerender('second')
    expect(probe.current.value).toBe('second')
  })

  it('does NOT snap back to source while the user is editing — the headline bug', () => {
    // Headline scenario: user types, broadcast lands carrying pre-edit value,
    // the hook must keep the user's draft.
    const commit = vi.fn()
    const probe = mount<string>('persisted', commit)
    act(() => probe.current.onChange('user-typed-this'))
    expect(probe.current.value).toBe('user-typed-this')
    probe.rerender('persisted')
    expect(probe.current.value).toBe('user-typed-this')
  })

  it('keeps the draft even when broadcasts carry a different value (last-writer-wins)', () => {
    const commit = vi.fn()
    const probe = mount<string>('A', commit)
    act(() => probe.current.onChange('user-typing'))
    probe.rerender('B-from-other-window')
    expect(probe.current.value).toBe('user-typing')
  })

  it('commits after the debounce window elapses', () => {
    const commit = vi.fn()
    const probe = mount<string>('', commit, 200)
    act(() => probe.current.onChange('typed'))
    expect(commit).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(commit).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('typed')
  })

  it('rapid edits coalesce into a single commit', () => {
    const commit = vi.fn()
    const probe = mount<string>('', commit, 100)
    act(() => probe.current.onChange('a'))
    act(() => probe.current.onChange('ab'))
    act(() => probe.current.onChange('abc'))
    act(() => {
      vi.advanceTimersByTime(101)
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('abc')
  })

  it('onBlur flushes the pending draft immediately', () => {
    const commit = vi.fn()
    const probe = mount<string>('', commit, 5000)
    act(() => probe.current.onChange('blurred'))
    expect(commit).not.toHaveBeenCalled()
    act(() => probe.current.onBlur())
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('blurred')
  })

  it('onBlur is a no-op when nothing has changed', () => {
    const commit = vi.fn()
    const probe = mount('unchanged', commit)
    act(() => probe.current.onBlur())
    expect(commit).not.toHaveBeenCalled()
  })

  it('flushes on unmount if a draft is pending', () => {
    const commit = vi.fn()
    const probe = mount<string>('', commit, 9999)
    act(() => probe.current.onChange('pending-on-unmount'))
    expect(commit).not.toHaveBeenCalled()
    probe.unmount()
    expect(commit).toHaveBeenCalledWith('pending-on-unmount')
  })
})
