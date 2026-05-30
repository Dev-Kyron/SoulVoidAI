/**
 * v2.0 — global screen-reader announcer. Mounts once per window (panel
 * and Settings each get their own instance) and subscribes to the UI
 * store's two announcement slots. Every push to those slots remounts
 * the inner span (via `key={seq}`) so assistive-tech engines see a
 * freshly inserted text node — without that bump, announcing the
 * same string twice in a row (e.g. two "Saved." toasts back to back)
 * would be a no-op because the DOM text wouldn't have changed.
 *
 * Two regions, two priorities:
 *  - polite (status):  queued behind whatever else the screen reader
 *    is reading. Used by toasts, stream completion, ambient updates.
 *  - assertive (alert): interrupts. Reserved for error toasts and
 *    safety-critical modal opens (permission, shell approval, etc.).
 *
 * The visual layer is `sr-only` (Tailwind built-in) — clip-path +
 * 1×1 pixel positioned offscreen, so it never affects layout but
 * stays in the accessibility tree.
 */
import { useUiStore } from '../../store/useUiStore'

export function LiveRegion(): JSX.Element {
  const polite = useUiStore((s) => s.announcePolite)
  const assertive = useUiStore((s) => s.announceAssertive)

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite && <span key={polite.seq}>{polite.text}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive && <span key={assertive.seq}>{assertive.text}</span>}
      </div>
    </>
  )
}
