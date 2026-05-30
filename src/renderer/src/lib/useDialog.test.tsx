/**
 * v2.0 — tests for the shared dialog hook. Every modal in the app
 * depends on this hook for Esc-to-close, Tab focus trap, and focus
 * restoration on unmount; a regression here breaks keyboard navigation
 * across every dialog at once.
 *
 * The `open` parameter is the most recent addition (#174 polish) and
 * the most likely to silently regress — the parent-mounted-but-body-
 * conditional pattern in Overlays' three approval dialogs depends on
 * the effect re-running when `open` transitions, and on the auto-focus
 * NOT re-firing on every re-render while open. Both are locked here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, useRef } from 'react'
import type { ReactNode } from 'react'
import { mountComponent, type MountedComponent } from '../test-utils'
import { useDialog } from './useDialog'

/**
 * Test harness component — exercises useDialog with controllable props.
 * Renders two focusable buttons inside the dialog ref so we can assert
 * which one auto-focuses and how Tab cycles. The `open` prop lets us
 * flip the gate and verify the effect re-runs.
 */
function DialogHarness({
  onClose,
  open,
  autoFocus
}: {
  onClose: () => void
  open?: boolean
  autoFocus?: boolean
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose, { open, autoFocus })
  return createElement(
    'div',
    {
      ref: dialogRef,
      role: 'dialog',
      'aria-label': 'Test dialog',
      'data-testid': 'dialog'
    },
    createElement('button', { type: 'button', 'data-testid': 'first', id: 'first-btn' }, 'First'),
    createElement('button', { type: 'button', 'data-testid': 'last', id: 'last-btn' }, 'Last')
  ) as ReactNode as JSX.Element
}

function pressKey(
  target: Element | Document,
  key: string,
  options: { shiftKey?: boolean } = {}
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false
  })
  return target.dispatchEvent(event)
}

describe('useDialog', () => {
  let mounted: MountedComponent | null = null
  // Stash a focusable element OUTSIDE the dialog so we can verify focus
  // restoration on unmount lands back on it (the typical real-world
  // case: a button opens the dialog → dialog gets focus → close →
  // focus returns to the openerButton).
  //
  // NB: we deliberately avoid `id="opener"` here — happy-dom auto-promotes
  // elements with an id onto the window object, and `window.opener` is a
  // built-in getter-only field. Setting it throws under happy-dom.
  let openerButton: HTMLButtonElement

  beforeEach(() => {
    openerButton = document.createElement('button')
    openerButton.textContent = 'Opener'
    openerButton.id = 'openerButton'
    document.body.appendChild(openerButton)
    openerButton.focus()
  })

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    openerButton.remove()
  })

  it('auto-focuses the first focusable element inside the dialog on mount', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose }))
    const first = mounted.container.querySelector('[data-testid="first"]') as HTMLButtonElement
    expect(document.activeElement).toBe(first)
  })

  it('skips auto-focus when autoFocus is false', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose, autoFocus: false }))
    // Focus should still be on the openerButton that we focused in beforeEach.
    expect(document.activeElement).toBe(openerButton)
  })

  it('Esc fires onClose when focus is on a non-input', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose }))
    pressKey(document, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Tab from the last focusable wraps back to the first', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose }))
    const last = mounted.container.querySelector('[data-testid="last"]') as HTMLButtonElement
    const first = mounted.container.querySelector('[data-testid="first"]') as HTMLButtonElement
    last.focus()
    pressKey(document, 'Tab')
    expect(document.activeElement).toBe(first)
  })

  it('Shift-Tab from the first focusable wraps back to the last', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose }))
    const first = mounted.container.querySelector('[data-testid="first"]') as HTMLButtonElement
    const last = mounted.container.querySelector('[data-testid="last"]') as HTMLButtonElement
    first.focus()
    pressKey(document, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('restores focus to the previously-focused element on unmount', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose }))
    // Dialog grabbed focus from the openerButton.
    const first = mounted.container.querySelector('[data-testid="first"]') as HTMLButtonElement
    expect(document.activeElement).toBe(first)
    mounted.unmount()
    mounted = null
    expect(document.activeElement).toBe(openerButton)
  })

  it('does NOT attach listeners when open=false', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose, open: false }))
    pressKey(document, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT steal auto-focus when open=false', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose, open: false }))
    // Opener should still hold focus — the dialog body is technically
    // rendered but the effect bailed on the open gate.
    expect(document.activeElement).toBe(openerButton)
  })

  it('attaches listeners when open transitions false → true', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose, open: false }))
    expect(document.activeElement).toBe(openerButton)

    // Flip the gate. The effect must re-run because `open` is in its
    // deps array — this was the bug the polish pass closed (parent-
    // mounted dialog with conditional body never wired its listeners).
    mounted.rerender(createElement(DialogHarness, { onClose, open: true }))
    pressKey(document, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not re-steal focus on benign re-renders while open', () => {
    const onClose = vi.fn()
    mounted = mountComponent(createElement(DialogHarness, { onClose, open: true }))
    const first = mounted.container.querySelector('[data-testid="first"]') as HTMLButtonElement
    const last = mounted.container.querySelector('[data-testid="last"]') as HTMLButtonElement
    expect(document.activeElement).toBe(first)

    // User Tabbed to the last button. A benign parent re-render that
    // doesn't change ANY useDialog dep (onClose stable, open still true)
    // must NOT re-fire the effect and steal focus back to `first`. This
    // is the autoFocus-stealing-on-rerender bug from the polish-pass
    // audit; locked here so a future refactor that drops the `open`
    // dep memoisation surfaces.
    last.focus()
    mounted.rerender(createElement(DialogHarness, { onClose, open: true }))
    expect(document.activeElement).toBe(last)
  })

  it('Esc on a text input with a value does NOT fire onClose', () => {
    // Lets the input handle Esc first (clearing an autocomplete etc.)
    // — matches macOS native dialog behavior.
    const onClose = vi.fn()
    mounted = mountComponent(
      createElement(() => {
        const ref = useRef<HTMLDivElement>(null)
        useDialog(ref, onClose)
        return createElement(
          'div',
          { ref, role: 'dialog', 'aria-label': 'Input dialog' },
          createElement('input', {
            type: 'text',
            defaultValue: 'typed text',
            'data-testid': 'input'
          })
        ) as ReactNode as JSX.Element
      })
    )
    const input = mounted.container.querySelector('[data-testid="input"]') as HTMLInputElement
    input.focus()
    pressKey(document, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Esc on an empty text input DOES fire onClose', () => {
    const onClose = vi.fn()
    mounted = mountComponent(
      createElement(() => {
        const ref = useRef<HTMLDivElement>(null)
        useDialog(ref, onClose)
        return createElement(
          'div',
          { ref, role: 'dialog', 'aria-label': 'Empty input dialog' },
          createElement('input', {
            type: 'text',
            defaultValue: '',
            'data-testid': 'empty-input'
          })
        ) as ReactNode as JSX.Element
      })
    )
    const input = mounted.container.querySelector('[data-testid="empty-input"]') as HTMLInputElement
    input.focus()
    pressKey(document, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
