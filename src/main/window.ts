/**
 * The floating widget window. A single frameless, transparent, always-on-top
 * window that the renderer grows between two sizes: a compact orb and the full
 * command panel. The window is resized programmatically; the renderer owns the
 * enter/exit animation sequencing.
 */
import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { setMainWindow, registerWindow } from './events'
import { isQuitting } from './lifecycle'
import {
  getConfig,
  setPanelSize,
  setSettingsWindowBounds
} from './services/storage/config'

const COLLAPSED = { width: 76, height: 76 }
const SCREEN_MARGIN = 28
const PANEL_MAX_WIDTH = 760

/**
 * Loads the OS-preferred locale into the Chromium spellchecker so the red
 * squiggle works in chat composers. `app.getPreferredSystemLanguages()`
 * returns BCP-47 codes (e.g. `en-AU`, `de-DE`) which the spellchecker
 * accepts directly; we fall back to `en-US` when the system list is empty
 * or contains nothing Chromium has a dictionary for. Called once per
 * BrowserWindow because spellchecker languages live on the WebContents
 * session, and each window can in principle use a different one.
 *
 * Setting more than one language enables multilingual spellcheck — same
 * behaviour as Chrome's chrome://settings/languages page. We cap at the
 * top two system locales so a globe-trotter with five preferred langs
 * doesn't get a noisy mix of false positives in every direction.
 */
function applySpellCheckerLanguages(win: BrowserWindow): void {
  try {
    const preferred = app.getPreferredSystemLanguages?.() ?? []
    const langs = preferred.slice(0, 2)
    win.webContents.session.setSpellCheckerLanguages(langs.length > 0 ? langs : ['en-US'])
  } catch {
    // Best-effort — a startup race or unsupported locale shouldn't break
    // window creation. The composer still works, just without squiggles.
  }
}

/**
 * Per-style panel sizing. `minWidth`/`minHeight` is the smallest the user may
 * shrink the panel to while the layout stays clean; `width`/`height` is the
 * comfortable size snapped to when that style is switched on. Both are capped
 * to the work area. Advanced needs more room — it carries the radial HUD and
 * the full telemetry grid; Simple is a compact app launcher.
 */
const PANEL_STYLE = {
  simple: { minWidth: 340, minHeight: 420, width: 440, height: 560 },
  advanced: { minWidth: 380, minHeight: 560, width: 472, height: 820 }
} as const

let win: BrowserWindow | null = null
let expanded = false

/**
 * The dedicated Settings window. A second, fully-framed BrowserWindow that
 * loads the renderer entry with `?view=settings` — the React app reads that
 * flag in main.tsx and mounts the SettingsRoot layout instead of the orb.
 * Decoupled from the floating panel so Settings doesn't get cramped inside
 * the always-on-top widget and so the user can keep it open alongside the
 * orb without one stealing focus from the other.
 */
let settingsWin: BrowserWindow | null = null

const SETTINGS_WINDOW = {
  defaultWidth: 880,
  defaultHeight: 660,
  minWidth: 720,
  minHeight: 520
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function createMainWindow(): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea

  win = new BrowserWindow({
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    x: work.x + work.width - COLLAPSED.width - SCREEN_MARGIN,
    y: work.y + work.height - COLLAPSED.height - SCREEN_MARGIN,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // sandbox: true isolates the renderer process from Node — only IPC and
      // contextBridge are reachable. The preload deliberately uses only
      // `electron`'s `contextBridge` and `ipcRenderer` so this flip costs
      // nothing today and slams the door on a future "preload picked up a
      // Node dep no one noticed" foot-gun.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Built-in Chromium spellchecker — gives every chat composer the
      // red squiggle + native context-menu suggestions. Was explicitly
      // off until v1.2.7 because we hadn't wired the dictionary loader
      // and beta testers wouldn't have seen any benefit. Now setSpellChecker
      // Languages() is called below right after the window's session is
      // available, so flipping this to true actually does something.
      spellcheck: true,
      // Default Chromium throttles timers / requestAnimationFrame in
      // hidden BrowserWindows down to ~1Hz. That's catastrophic for the
      // agent loop — when the user closes the panel and walks away,
      // we WANT the loop to keep firing tool calls at full speed.
      // Disabling background throttling keeps a hidden renderer running
      // at normal pace, so a 30-step research task that takes 2 minutes
      // visible takes 2 minutes hidden too.
      backgroundThrottling: false,
      // Streaming TTS plays HTMLAudioElement instances asynchronously
      // after the AI provider responds — Chromium's default autoplay
      // policy can block these `audio.play()` calls because they're not
      // a direct user gesture (the user clicked Send, then we awaited
      // a 4-second SSE stream, then we tried to play). Without this flag
      // the preview button in Voice settings works (direct click) but
      // the real-time spoken replies are silent. Same trick `--autoplay-policy`
      // on Chromium's CLI does, scoped to this BrowserWindow.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applySpellCheckerLanguages(win)

  win.once('ready-to-show', () => win?.show())

  // External links open in the system browser, never inside the widget.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Closing the window hides it to the tray unless the app is truly quitting.
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      win?.hide()
    }
  })

  win.on('closed', () => {
    win = null
  })

  // Remember a user-resized panel so it reopens at the chosen size.
  win.on('resized', () => {
    if (expanded && win) {
      const bounds = win.getBounds()
      setPanelSize(bounds.width, bounds.height)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    if (process.env['VOIDSOUL_DEVTOOLS'] === 'true') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setMainWindow(win)
  return win
}

export function getWindow(): BrowserWindow | null {
  return win
}

export function isExpanded(): boolean {
  return expanded
}

/**
 * Resizes the window between orb and panel, anchored to its bottom-right.
 * The expanded panel is user-resizable within sensible bounds; the orb is not.
 */
export function setExpanded(value: boolean): boolean {
  if (!win) return expanded
  expanded = value

  const work = screen.getDisplayMatching(win.getBounds()).workArea
  let size: { width: number; height: number }

  if (value) {
    const stored = getConfig().panel
    const sizing = PANEL_STYLE[getConfig().appearance.nexusStyle]
    const maxWidth = Math.min(PANEL_MAX_WIDTH, work.width)
    const maxHeight = work.height
    const minWidth = Math.min(sizing.minWidth, maxWidth)
    const minHeight = Math.min(sizing.minHeight, maxHeight)
    win.setMinimumSize(minWidth, minHeight)
    win.setMaximumSize(maxWidth, maxHeight)
    win.setResizable(true)
    size = {
      width: clamp(stored.width || sizing.width, minWidth, maxWidth),
      height: clamp(stored.height || sizing.height, minHeight, maxHeight)
    }
  } else {
    win.setResizable(false)
    win.setMinimumSize(COLLAPSED.width, COLLAPSED.height)
    win.setMaximumSize(0, 0)
    size = COLLAPSED
  }

  const current = win.getBounds()
  const right = current.x + current.width
  const bottom = current.y + current.height
  const x = clamp(right - size.width, work.x, work.x + work.width - size.width)
  const y = clamp(bottom - size.height, work.y, work.y + work.height - size.height)

  win.setBounds({ x, y, width: size.width, height: size.height })
  return expanded
}

/**
 * Re-fits an open panel to the active Nexus style: applies that style's
 * minimum size and snaps the panel to a comfortable height for it, anchored
 * to its bottom-right corner. Called when the user switches layout style.
 */
export function applyPanelStyle(): void {
  if (!win || !expanded) return

  const work = screen.getDisplayMatching(win.getBounds()).workArea
  const sizing = PANEL_STYLE[getConfig().appearance.nexusStyle]
  const maxWidth = Math.min(PANEL_MAX_WIDTH, work.width)
  const maxHeight = work.height
  const minWidth = Math.min(sizing.minWidth, maxWidth)
  const minHeight = Math.min(sizing.minHeight, maxHeight)

  win.setMinimumSize(minWidth, minHeight)
  win.setMaximumSize(maxWidth, maxHeight)

  const current = win.getBounds()
  const width = clamp(current.width, minWidth, maxWidth)
  const height = clamp(sizing.height, minHeight, maxHeight)
  const x = clamp(current.x + current.width - width, work.x, work.x + work.width - width)
  const y = clamp(current.y + current.height - height, work.y, work.y + work.height - height)

  win.setBounds({ x, y, width, height })
  setPanelSize(width, height)
}

export function setAlwaysOnTop(value: boolean): void {
  win?.setAlwaysOnTop(value, value ? 'screen-saver' : 'normal')
}

/** Nudges the window by a screen-pixel delta — used to drag the floating orb. */
export function moveBy(dx: number, dy: number): void {
  if (!win) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
}

export function showWindow(): void {
  if (!win) return
  win.show()
  win.focus()
}

export function hideWindow(): void {
  win?.hide()
}

export function toggleWindow(): void {
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow()
}

/* ---------------------------- Settings window --------------------------- */

/**
 * Opens (or focuses) the Settings window. A separate, framed, resizable
 * BrowserWindow that loads the same renderer entry with `?view=settings` —
 * the SPA branches on that query string and mounts a full-window settings
 * layout rather than the floating orb.
 */
export function openSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }

  const work = screen.getPrimaryDisplay().workArea
  const stored = getConfig().settingsWindow
  const width = stored?.width ?? SETTINGS_WINDOW.defaultWidth
  const height = stored?.height ?? SETTINGS_WINDOW.defaultHeight
  const x = stored?.x ?? Math.round(work.x + (work.width - width) / 2)
  const y = stored?.y ?? Math.round(work.y + (work.height - height) / 2)

  settingsWin = new BrowserWindow({
    width,
    height,
    x: clamp(x, work.x, work.x + work.width - width),
    y: clamp(y, work.y, work.y + work.height - height),
    minWidth: SETTINGS_WINDOW.minWidth,
    minHeight: SETTINGS_WINDOW.minHeight,
    title: 'VoidSoul · Settings',
    // titleBarStyle: 'hidden' drops the OS title bar (icon + "VoidSoul
    // Assistant" caption + File/Edit/View menu) while titleBarOverlay
    // keeps the native minimise / maximise / close buttons as a thin
    // platform-styled overlay in the top-right. autoHideMenuBar belt-
    // and-suspenders the menu away on Windows variants that draw it
    // independently of the title bar. The renderer's header gets an
    // -webkit-app-region: drag strip so the window stays draggable from
    // the top edge despite having no native chrome.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e16', symbolColor: '#94a3b8', height: 36 },
    autoHideMenuBar: true,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    show: false,
    backgroundColor: '#0e0e16',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // sandbox: true isolates the renderer process from Node — only IPC and
      // contextBridge are reachable. The preload deliberately uses only
      // `electron`'s `contextBridge` and `ipcRenderer` so this flip costs
      // nothing today and slams the door on a future "preload picked up a
      // Node dep no one noticed" foot-gun.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Built-in Chromium spellchecker — gives every chat composer the
      // red squiggle + native context-menu suggestions. Was explicitly
      // off until v1.2.7 because we hadn't wired the dictionary loader
      // and beta testers wouldn't have seen any benefit. Now setSpellChecker
      // Languages() is called below right after the window's session is
      // available, so flipping this to true actually does something.
      spellcheck: true,
      // Match the main window's policy — the preview button in Voice
      // settings is direct-gesture so it works without this, but any
      // future async audio path (e.g. a "speak this" link on a doc page)
      // would silently fail otherwise. Keep both windows aligned.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  applySpellCheckerLanguages(settingsWin)
  settingsWin.once('ready-to-show', () => settingsWin?.show())
  registerWindow(settingsWin)

  // External links escape to the system browser — same policy as the panel.
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Persist size/position so reopens remember where the user left it.
  const persistBounds = (): void => {
    if (!settingsWin || settingsWin.isDestroyed()) return
    const b = settingsWin.getBounds()
    setSettingsWindowBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
  }
  settingsWin.on('resized', persistBounds)
  settingsWin.on('moved', persistBounds)

  settingsWin.on('closed', () => {
    settingsWin = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void settingsWin.loadURL(`${devUrl}?view=settings`)
    if (process.env['VOIDSOUL_DEVTOOLS'] === 'true') {
      settingsWin.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    void settingsWin.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'settings' }
    })
  }

  return settingsWin
}

export function closeSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
}
