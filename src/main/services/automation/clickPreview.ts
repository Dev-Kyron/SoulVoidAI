/**
 * v1.8.0 — click-preview HUD window.
 *
 * A small (~280×180) frameless transparent always-on-top BrowserWindow
 * positioned over the predicted click target. The ring at the top-centre
 * of the window sits exactly on the click coordinates (window.x = targetX -
 * RING_OFFSET_X), so the user sees what Soul is about to click before it
 * happens.
 *
 * Lifecycle: `requestPreview()` opens the window with a fresh token and
 * returns a Promise that resolves to the user's decision (`'go'` after the
 * countdown, `'cancel'` if they hit Esc or Cancel). The window's renderer
 * (ClickPreviewRoot.tsx) sends `vs.clickPreview.resolve(token, decision)`
 * which lands here via IPC and settles the awaiting Promise. We close the
 * window from the main side regardless of who initiated the decision so
 * the renderer can't leak a window if it crashes mid-flow.
 */
import { BrowserWindow, globalShortcut, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Preview window dimensions. The ring renders at (RING_OFFSET_X, RING_OFFSET_Y) in window-local coords so it overlaps the click target when the window is positioned at (targetX - RING_OFFSET_X, targetY - RING_OFFSET_Y). v1.8.1 — widened slightly so the caption sits comfortably under longer descriptions. */
const WIN_WIDTH = 320
const WIN_HEIGHT = 220
const RING_OFFSET_X = 160
const RING_OFFSET_Y = 56

export type PreviewDecision = 'go' | 'cancel'

export interface PreviewRequest {
  /** Click target in LOGICAL display pixels (not raw screenshot pixels). */
  x: number
  y: number
  /** Short description shown in the HUD ("the Send button"). */
  description: string
  /** Self-reported model confidence 0-1, displayed as a hint. */
  confidence: number
  /** Countdown seconds before auto-go. 3 is the default we tuned in scoping. */
  seconds: number
}

interface Pending {
  win: BrowserWindow
  resolve: (decision: PreviewDecision) => void
  timer: NodeJS.Timeout
}

const PENDING = new Map<string, Pending>()

/**
 * Opens the preview HUD and returns a Promise that settles when the user
 * resolves (Cancel) or the countdown elapses (Go). Closing the window via
 * any other path (e.g. user X-ed it from a debugger) resolves to 'cancel'.
 *
 * Multiple preview windows can't overlap usefully — opening a new one
 * cancels any prior pending preview first.
 */
export function requestPreview(req: PreviewRequest): Promise<PreviewDecision> {
  cancelAllPending()
  const token = randomUUID()
  const work = screen.getPrimaryDisplay().workArea

  // Position the window so its ring overlaps (req.x, req.y). Clamp into the
  // work area so the HUD never spawns off-screen on multi-monitor edge cases.
  const winX = Math.max(work.x, Math.min(req.x - RING_OFFSET_X, work.x + work.width - WIN_WIDTH))
  const winY = Math.max(work.y, Math.min(req.y - RING_OFFSET_Y, work.y + work.height - WIN_HEIGHT))

  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: Math.round(winX),
    y: Math.round(winY),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The HUD has no audio, but matching the rest of our windows keeps the
      // session config consistent if a future iteration wants a "click" SFX.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  // screen-saver level so the HUD floats above fullscreen apps the user is
  // about to click into (e.g. Gmail in Edge fullscreen). Without this, the
  // preview is invisible — and clicking blind defeats the whole feature.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // v1.8.1 — register Esc as a global shortcut for the lifetime of THIS
  // preview. We use globalShortcut (not a per-window keydown handler)
  // because the window is shown with showInactive() below, so it never
  // takes keyboard focus — without globalShortcut, Esc would land on
  // whatever app the user was already in, not on us. Unregistered in
  // settle() so we don't permanently capture Esc system-wide.
  try {
    globalShortcut.register('Escape', () => settle(token, 'cancel'))
  } catch {
    // Esc was already bound (very unlikely — we unregister on settle).
    // Cancel button + auto-go still work, so this is non-fatal.
  }

  // 7-second safety hard-stop: if the renderer crashes or the IPC never
  // arrives, we still resolve and close the window. Generous vs the 3s
  // default countdown to allow user-extended cancellation flows we may
  // add later (e.g. "+2s" button) without flooring the safety net.
  const timer = setTimeout(
    () => {
      settle(token, 'cancel')
    },
    (req.seconds + 4) * 1000
  )

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const query = {
    view: 'click-preview',
    token,
    description: req.description,
    confidence: String(req.confidence),
    seconds: String(req.seconds),
    ringX: String(RING_OFFSET_X),
    ringY: String(RING_OFFSET_Y)
  }
  if (devUrl) {
    const params = new URLSearchParams(query).toString()
    void win.loadURL(`${devUrl}?${params}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
  // v1.8.1 — showInactive() instead of show(): the preview overlays the
  // target without stealing focus from the app the user is about to
  // click into. Without this, the preview window steals focus → the
  // first real click on the target only re-focuses that app and the
  // button never receives the click event. Esc handled by globalShortcut
  // above since we no longer have keyboard focus.
  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    // Window gone before settle ran — treat as cancel so the awaiting
    // Promise can't hang forever. Idempotent: if settle already fired
    // PENDING no longer has the entry.
    settle(token, 'cancel')
  })

  return new Promise<PreviewDecision>((resolve) => {
    PENDING.set(token, { win, resolve, timer })
  })
}

/** IPC handler entry point — called from `clickPreview:resolve` to settle
 *  the awaiting preview. No-op for unknown tokens (stale resolves arrive
 *  after a cancel from elsewhere). */
export function resolvePreview(token: string, decision: PreviewDecision): void {
  settle(token, decision)
}

function settle(token: string, decision: PreviewDecision): void {
  const pending = PENDING.get(token)
  if (!pending) return
  PENDING.delete(token)
  clearTimeout(pending.timer)
  // Release Esc back to other apps. We always-on register/unregister per
  // preview so multiple overlapping previews can't double-bind it.
  try {
    globalShortcut.unregister('Escape')
  } catch {
    /* nothing useful to do */
  }
  pending.resolve(decision)
  if (!pending.win.isDestroyed()) {
    // close() fires the `closed` handler we attached above, which calls
    // settle() again — but PENDING.delete above makes that second call a
    // safe no-op.
    pending.win.close()
  }
}

/** Internal: cancel any previously-pending preview so a new one can take
 *  ownership of the screen. Used at the start of requestPreview. */
function cancelAllPending(): void {
  for (const token of Array.from(PENDING.keys())) {
    settle(token, 'cancel')
  }
}
