/**
 * Optional continuous screen awareness. When enabled, the active window is
 * polled on an interval and broadcast to the renderer so the assistant can
 * reference what the user is currently doing. This is opt-in and gated by the
 * Screen Capture permission — it never runs silently.
 *
 * v2.0 — added semantic awareness handoff. When the user opts in to the
 * `semantic` flag (Settings → Appearance → "Semantic screen awareness"),
 * each window-title change additionally schedules a debounced screenshot
 * + OCR run via `semanticAwareness.ts`. The baseline title broadcast
 * stays as-is so existing consumers (chat UI chip, NexusView) keep
 * working unchanged.
 */
import { BrowserWindow } from 'electron'
import { getActiveWindow } from './activeWindow'
import { broadcast } from '../../events'
import { isGranted } from '../permissions/permissions'
import { log } from '../logger'
import { noteWindowChange, setSemanticAwareness } from './semanticAwareness'
import type { ActiveWindowInfo } from '@shared/types'

const POLL_INTERVAL_MS = 4000

let timer: NodeJS.Timeout | null = null
let last = ''
let semanticOn = false
// v2.0 polish — guard against overlapping polls. getActiveWindow shells out
// to a PowerShell/native call that can occasionally take longer than the
// interval (window driver hangs, AV scanning the process). Without this,
// every late return would queue another poll behind it; under sustained
// hangs the queue grows unbounded.
let pollInFlight = false

/**
 * v2.0 round-6 perf — true when every VoidSoul BrowserWindow is hidden
 * (tray-only / panel collapsed / minimised to system tray). In that
 * state the active-window title hasn't been a useful signal for any
 * subscriber for at least one render cycle; firing the native call (a
 * shell to PowerShell on Windows that AV can stretch past 100ms) every
 * 4s burns battery for zero benefit.
 *
 * `getAllWindows` returns ALL windows incl. hidden ones; `isVisible`
 * checks the actual show state. We also treat zero windows as "hidden"
 * which covers the brief startup window before any has mounted.
 */
function appBackgrounded(): boolean {
  try {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) return true
    return windows.every((w) => !w.isVisible())
  } catch {
    // BrowserWindow not available (shouldn't happen in main) — assume
    // foregrounded so we don't accidentally permanently disable the loop.
    return false
  }
}

async function poll(): Promise<void> {
  if (pollInFlight) return
  // v2.0 round-6 perf — skip the native call when nothing in the app is
  // visible. The next visibility change wakes the loop via the
  // `browser-window-focus` event below (registered once at module load).
  if (appBackgrounded()) return
  pollInFlight = true
  try {
    const info = await getActiveWindow()
    // v2.0 polish — re-check enabled state AFTER the await. The user can
    // toggle awareness off during the (sometimes slow) getActiveWindow
    // call; without this guard the in-flight result would still
    // broadcast + reset `last` + schedule an OCR via noteWindowChange,
    // leaking events past opt-out and reintroducing the exact dead-
    // letter class the v2.0 round-1 fix solved on the OCR side.
    if (!timer) return
    const fingerprint = `${info.process}::${info.title}`
    if (fingerprint !== last) {
      last = fingerprint
      broadcast('screen:active-window', info satisfies ActiveWindowInfo)
      // v2.0 — hand off to semantic awareness when enabled. The module
      // debounces internally so rapid alt-tab doesn't trigger N captures.
      if (semanticOn) noteWindowChange(info)
    }
  } catch (err) {
    log(
      'warn',
      'screen',
      `[awareness] poll failed: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    pollInFlight = false
  }
}

// v2.0 round-6 perf — wake the loop the instant a VoidSoul window
// re-shows. Otherwise the user could un-hide the panel and wait up
// to 4s for the title to refresh because the tick was skipped while
// hidden. Listener attached lazily on first enable, removed when the
// loop is fully stopped.
let focusListenerAttached = false
function ensureFocusListener(): void {
  if (focusListenerAttached) return
  // `app.on('browser-window-focus')` fires for any window in any state;
  // the cheap `appBackgrounded` check inside poll() means firing too
  // often costs nothing.
  void import('electron').then(({ app }) => {
    if (focusListenerAttached) return
    focusListenerAttached = true
    app.on('browser-window-focus', () => {
      if (timer) void poll()
    })
    app.on('browser-window-show' as never, () => {
      if (timer) void poll()
    })
  })
}

export function setScreenAwareness(enabled: boolean): boolean {
  if (enabled && !isGranted('screenCapture')) {
    log('warn', 'screen', 'Screen awareness needs the Screen Capture permission.')
    return false
  }
  if (enabled && !timer) {
    ensureFocusListener()
    void poll()
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    log('info', 'screen', 'Continuous screen awareness enabled.')
  } else if (!enabled && timer) {
    clearInterval(timer)
    timer = null
    last = ''
    log('info', 'screen', 'Continuous screen awareness disabled.')
    // Coarse loop went off → semantic loop has nothing to react to.
    // Disable it too to keep both states consistent.
    if (semanticOn) {
      semanticOn = setSemanticAwareness(false)
    }
  }
  return enabled
}

/**
 * v2.0 — toggle the semantic enrichment. No-op when the coarse
 * awareness loop is off (semantic needs window-change events from
 * `poll()` to do its thing — turning semantic on without the coarse
 * loop would just leak the enabled flag silently).
 */
export function setSemanticScreenAwareness(value: boolean): boolean {
  if (value && !timer) {
    log(
      'warn',
      'screen',
      'Semantic awareness requested but coarse awareness is off — enable screen awareness first.'
    )
    semanticOn = false
    return false
  }
  semanticOn = setSemanticAwareness(value)
  return semanticOn
}

export function stopScreenAwareness(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (semanticOn) {
    semanticOn = setSemanticAwareness(false)
  }
}
