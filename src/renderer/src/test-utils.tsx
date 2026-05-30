/**
 * v2.0 — minimal renderer-side test harness.
 *
 * Pre-2.0 the only renderer-side test was `useDraftField.test.ts` which
 * hand-rolled its own react-dom/client mount + Probe component. That
 * pattern works for hooks but is painful for components with effects /
 * async render. This file centralises the boilerplate so component
 * tests can focus on assertions instead of plumbing.
 *
 * Why not `@testing-library/react`: would be the obvious answer but
 * adding a dep just for this one batch felt premature when we already
 * have happy-dom + react-dom/client. If component test coverage grows
 * past ~5 files, swap to `@testing-library/react`'s `render` and
 * `screen` — the helpers below have parallel semantics so the
 * migration is search-and-replace.
 *
 * Usage:
 *   const { unmount, container } = mountComponent(<MyThing />)
 *   await waitForAsyncEffects()
 *   expect(container.querySelector('button')?.textContent).toBe('Save')
 *   unmount()
 */
/// <reference lib="dom" />
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

export interface MountedComponent {
  container: HTMLDivElement
  root: Root
  unmount: () => void
  rerender: (next: ReactElement) => void
}

/**
 * Mounts a React element into a fresh detached div and returns helpers
 * for inspection + cleanup. Always wraps in `act` so React's effects /
 * state updates land before the function returns.
 */
export function mountComponent(element: ReactElement): MountedComponent {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
    rerender: (next: ReactElement) => {
      act(() => {
        root.render(next)
      })
    }
  }
}

/**
 * Drains microtasks + a macrotask tick so async useEffect bodies
 * (`useEffect(() => { void asyncWork() }, [])`) get a chance to
 * resolve before the test asserts. Wrap with `await act(...)` so the
 * subsequent setState calls don't trigger React's act warning.
 */
export async function waitForAsyncEffects(): Promise<void> {
  await act(async () => {
    // Two micro-flushes catch the common `await x; setState(...)` pattern;
    // the macrotask covers anything queued via window.setTimeout(0).
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  })
}

/**
 * Synchronously fires a click on the element. Wraps in `act` so React
 * flushes the resulting render before returning. Throws if the element
 * is null — turns "the button isn't where I expected" into a fast,
 * loud failure instead of a confusing "TypeError: cannot read 'click'".
 */
export function click(element: Element | null): void {
  if (!element) throw new Error('click: target element is null')
  act(() => {
    ;(element as HTMLElement).click()
  })
}
