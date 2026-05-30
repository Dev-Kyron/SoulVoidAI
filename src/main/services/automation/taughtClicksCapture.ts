/**
 * v2.0 Phase 4 — Hover-to-teach capture flow.
 *
 * The UX problem: the user wants to teach a click, but they need to
 * point at the target inside a DIFFERENT app (Slack, Discord, etc).
 * If we used an in-app crosshair overlay, the user couldn't switch to
 * the target app without losing the capture context. Solution: a
 * GLOBAL hotkey. User clicks "Teach a click" in Settings, switches to
 * the target app, points at the element, presses the hotkey. We then
 * capture cursor position + query UIA at that point + emit the result
 * back to the renderer so the Settings dialog can show what was
 * captured and let the user assign a description.
 *
 * Why globalShortcut rather than a mouse hook:
 *   - mouse hooks need a kernel-level hook or robotjs-style native
 *     module; both add platform-specific build pain
 *   - globalShortcut is built into Electron and works cross-platform
 *   - the hotkey makes the moment of capture explicit + cancellable
 *     (user can move the cursor freely before pressing the key)
 *
 * Lifecycle:
 *   - startCapture() → registers the shortcut, returns immediately
 *   - shortcut fires (or cancelCapture is called) → fires the
 *     onCaptured callback, unregisters
 *   - Idempotent: re-calling startCapture without cancelling first
 *     auto-cancels the previous capture
 */
import { globalShortcut, screen } from 'electron'
import { log } from '../logger'
import { elementAtPoint } from './uia'
import type { UiaElement } from './uia'

/** Hotkey the user presses inside any app to capture the element
 *  under their cursor. Chosen for unlikely collision — F8 is not
 *  bound by most apps and not in the Electron accelerator-reserved
 *  list. We accept the (extremely small) risk that some niche app
 *  uses F8 for something else; the user can cancel via Settings. */
const CAPTURE_HOTKEY = 'F8'

interface ActiveCapture {
  onCaptured: (result: { element: UiaElement | null; cursorX: number; cursorY: number }) => void
  onCancelled: () => void
}

let active: ActiveCapture | null = null
/** Mutex against rapid F8 / key-repeat re-entry. Without it, two
 *  presses in quick succession both pass the `if (!active) return`
 *  check before either has time to unregister, and we spawn two
 *  redundant PowerShell elementAtPoint processes. */
let firing = false

/**
 * Begin a capture flow. Returns true when the hotkey was registered
 * successfully, false when the OS refused (another app owns it).
 * Calling again while a capture is in flight cancels the previous one.
 */
export function startCapture(handlers: ActiveCapture): boolean {
  if (active) cancelCapture()
  const registered = globalShortcut.register(CAPTURE_HOTKEY, () => {
    void onHotkey()
  })
  if (!registered) {
    log(
      'warn',
      'automation',
      `[taught-clicks] failed to register capture hotkey ${CAPTURE_HOTKEY} — another app may own it`
    )
    return false
  }
  active = handlers
  log('info', 'automation', `[taught-clicks] capture armed; press ${CAPTURE_HOTKEY} to capture`)
  return true
}

/**
 * Cancel the in-flight capture without firing a callback. Settings UI
 * calls this on close / dismiss so we don't leak a stuck hotkey.
 */
export function cancelCapture(): void {
  if (!active) return
  globalShortcut.unregister(CAPTURE_HOTKEY)
  const handlers = active
  active = null
  firing = false
  handlers.onCancelled()
  log('info', 'automation', '[taught-clicks] capture cancelled')
}

/** True when a capture is armed. Surfaced to the renderer so the
 *  Settings dialog knows whether to show the "press F8" copy or the
 *  idle state. */
export function isCapturing(): boolean {
  return active !== null
}

/** The hotkey accelerator (e.g. 'F8') — exported so the Settings UI
 *  can show "press F8 to capture" without hard-coding the string. */
export function captureHotkey(): string {
  return CAPTURE_HOTKEY
}

async function onHotkey(): Promise<void> {
  // Mutex first — rapid F8 / key-repeat can fire the handler before
  // we've finished servicing the prior press. Without the guard, both
  // would pass the `if (!active)` check and spawn duplicate PowerShell
  // elementAtPoint processes.
  if (firing || !active) return
  firing = true
  // v2.0 polish — snapshot the handlers BEFORE the elementAtPoint await
  // and verify they're still active after. Previous version captured
  // `const handlers = active` AFTER the await, so a startCapture/cancel
  // racing during the ~300ms PowerShell roundtrip could deliver this
  // capture's element to the NEW capture session's callback (or to a
  // null handlers that we'd then no-op silently).
  const handlers = active
  const cursor = screen.getCursorScreenPoint()
  log(
    'info',
    'automation',
    `[taught-clicks] capture fired at (${cursor.x}, ${cursor.y}) — querying UIA…`
  )
  let element: UiaElement | null = null
  try {
    element = await elementAtPoint(cursor.x, cursor.y)
  } catch (err) {
    log(
      'warn',
      'automation',
      `[taught-clicks] elementAtPoint threw: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // Bail if the capture session changed during the await — the new
  // session will arm its own hotkey + handle its own F8.
  if (active !== handlers) {
    firing = false
    log(
      'info',
      'automation',
      '[taught-clicks] capture session changed during UIA query — dropping stale frame'
    )
    return
  }
  globalShortcut.unregister(CAPTURE_HOTKEY)
  active = null
  firing = false
  if (!handlers) return
  handlers.onCaptured({ element, cursorX: cursor.x, cursorY: cursor.y })
}
