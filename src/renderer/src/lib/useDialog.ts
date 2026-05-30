/**
 * Two small a11y helpers shared by every modal dialog in the app —
 * `HelpDialog`, `ShareDialog`, `ThreadOverridesDialog`, `CanvasDialog`,
 * `TourOverlay`, `FirstRunBanner`. Both close the gap the audit flagged:
 * dialogs had no Esc binding, no focus trap, and no aria-modal semantics,
 * so keyboard users couldn't dismiss them and screen readers treated them
 * as inline panels.
 *
 * Usage:
 * ```tsx
 * function HelpDialog({ onClose }) {
 *   const ref = useRef<HTMLDivElement>(null)
 *   useDialog(ref, onClose)
 *   return <div ref={ref} role="dialog" aria-modal="true" aria-label="Help">
 * }
 * ```
 *
 * The hook handles three concerns in one place:
 *  - Esc key closes via the supplied callback (only when no input/textarea
 *    inside the dialog has focus — Esc should clear an autocomplete first).
 *  - Tab/Shift-Tab cycles focus within the dialog's focusable descendants.
 *  - On mount, focus moves to the first focusable inside the dialog (or
 *    the dialog container if none); on unmount, focus restores to whatever
 *    held it before open.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function getFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // Filter out elements that are present in the DOM but not actually
    // reachable — display:none / visibility:hidden subtrees, etc.
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

export function useDialog(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  options?: { autoFocus?: boolean; open?: boolean }
): void {
  const autoFocus = options?.autoFocus !== false
  // v2.0 — explicit `open` opt-in for the pattern where the dialog body
  // is conditionally rendered INSIDE a long-lived parent (e.g. the
  // Overlays' approval modals). Default `true` matches the historical
  // contract where consumers mount/unmount the dialog themselves — those
  // call sites don't pass `open` and behave as before. New call sites
  // that pass `open: false` get a clean no-op until the dialog opens,
  // then run setup once; on close the cleanup runs once (focus restore
  // + listener removal). Without this opt-in, a mid-prompt re-render
  // (e.g. queueLength updates) would re-run the effect and STEAL focus
  // back to the first focusable, disrupting the user mid-Tab.
  const open = options?.open !== false
  useEffect(() => {
    if (!open) return
    const dialog = ref.current
    if (!dialog) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    if (autoFocus) {
      // Defer to next tick so any in-flight focus changes settle first.
      const focusables = getFocusables(dialog)
      const target = focusables[0] ?? dialog
      // tabindex -1 on container so it can be programmatically focused
      // even though it's not in the normal tab order.
      if (target === dialog && !dialog.hasAttribute('tabindex')) {
        dialog.setAttribute('tabindex', '-1')
      }
      target.focus({ preventScroll: true })
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Let inputs handle their own Esc first (e.g., to clear a value).
        // We only close when focus is on a non-input element OR a value-less
        // input — matches the common pattern in macOS native apps.
        const active = document.activeElement
        const isTextInput =
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        if (isTextInput && active.value) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      // Focus trap. Find focusables fresh each press in case the dialog's
      // content changed (collapsible sections, dynamic forms).
      const focusables = getFocusables(dialog)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    // Capture so we run before any inner key handlers (e.g. a textarea's
    // shift-enter listener doesn't get to swallow our Esc).
    document.addEventListener('keydown', onKeyDown, true)
    return (): void => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Restore focus to wherever it was before — but only if the element
      // is still in the DOM (the dialog might have been opened from a
      // button that's since unmounted).
      if (previouslyFocused && document.body.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus({ preventScroll: true })
        } catch {
          /* element no longer focusable */
        }
      }
    }
  }, [ref, onClose, autoFocus, open])
}
