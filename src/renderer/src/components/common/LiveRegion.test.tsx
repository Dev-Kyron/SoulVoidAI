/**
 * v2.0 — tests for the global screen-reader announcer. The component is
 * the linchpin of the a11y batch (#174): if it stops re-announcing
 * duplicate strings, or if it accidentally announces the same text
 * twice, screen-reader users get a worse experience than sighted ones.
 *
 * The seq-key trick (rendering inside `<span key={seq}>` so an identical
 * string still produces a freshly inserted DOM node) is the bit most
 * likely to silently regress under future refactors — locked down here.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { mountComponent, type MountedComponent } from '../../test-utils'
import { LiveRegion } from './LiveRegion'
import { useUiStore } from '../../store/useUiStore'

describe('LiveRegion', () => {
  let mounted: MountedComponent | null = null

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    // Reset the announcer slots so a stale announcement from a previous
    // test doesn't leak into the next one's initial-render assertion.
    useUiStore.setState({ announcePolite: null, announceAssertive: null })
  })

  it('renders two visually-hidden live regions with correct ARIA roles', () => {
    mounted = mountComponent(createElement(LiveRegion))
    const polite = mounted.container.querySelector('[role="status"]')
    const assertive = mounted.container.querySelector('[role="alert"]')
    expect(polite).not.toBeNull()
    expect(assertive).not.toBeNull()
    expect(polite?.getAttribute('aria-live')).toBe('polite')
    expect(assertive?.getAttribute('aria-live')).toBe('assertive')
    // Both regions should be `aria-atomic="true"` so AT engines read the
    // full announcement text rather than diffing word-by-word.
    expect(polite?.getAttribute('aria-atomic')).toBe('true')
    expect(assertive?.getAttribute('aria-atomic')).toBe('true')
    // Visually hidden — `sr-only` (Tailwind) keeps them in the a11y tree
    // without affecting layout. We don't assert the exact class string
    // (Tailwind class compiles vary) but DO assert it's not empty.
    expect(polite?.className.length).toBeGreaterThan(0)
  })

  it('renders the announcement text in the polite region', () => {
    mounted = mountComponent(createElement(LiveRegion))
    mounted.rerender(createElement(LiveRegion))
    // Push through the store so the seq counter behaves like production.
    useUiStore.getState().announce('Saved.')
    mounted.rerender(createElement(LiveRegion))
    const polite = mounted.container.querySelector('[role="status"]')
    expect(polite?.textContent).toBe('Saved.')
    // Nothing in the assertive slot — polite announce should not leak.
    const assertive = mounted.container.querySelector('[role="alert"]')
    expect(assertive?.textContent ?? '').toBe('')
  })

  it('routes assertive announcements to the alert region', () => {
    mounted = mountComponent(createElement(LiveRegion))
    useUiStore.getState().announce('Quota exceeded', 'assertive')
    mounted.rerender(createElement(LiveRegion))
    const assertive = mounted.container.querySelector('[role="alert"]')
    expect(assertive?.textContent).toBe('Quota exceeded')
    // Polite slot stays empty so the same message isn't double-announced.
    const polite = mounted.container.querySelector('[role="status"]')
    expect(polite?.textContent ?? '').toBe('')
  })

  it('re-announces an identical string via key bump (the seq trick)', () => {
    mounted = mountComponent(createElement(LiveRegion))
    useUiStore.getState().announce('Saved.')
    mounted.rerender(createElement(LiveRegion))
    const firstNode = mounted.container.querySelector('[role="status"] > span')
    expect(firstNode?.textContent).toBe('Saved.')

    // Same text again. Without the seq-key, AT engines would see the
    // DOM text as unchanged and skip the re-read. The component renders
    // the text inside `<span key={seq}>` so each announce yields a
    // fresh node — locked here by asserting the node identity changes.
    useUiStore.getState().announce('Saved.')
    mounted.rerender(createElement(LiveRegion))
    const secondNode = mounted.container.querySelector('[role="status"] > span')
    expect(secondNode?.textContent).toBe('Saved.')
    expect(secondNode).not.toBe(firstNode)
  })

  it('renders nothing inside the regions before any announcement', () => {
    mounted = mountComponent(createElement(LiveRegion))
    const polite = mounted.container.querySelector('[role="status"]')
    const assertive = mounted.container.querySelector('[role="alert"]')
    expect(polite?.textContent ?? '').toBe('')
    expect(assertive?.textContent ?? '').toBe('')
  })
})
