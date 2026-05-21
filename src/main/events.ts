/**
 * Lightweight event bus for pushing messages from main-process services to
 * every active renderer. Multiple windows can be open at once (the floating
 * panel plus the dedicated Settings window); broadcast fans out to all of
 * them so state changes stay in sync across surfaces.
 */
import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null
const extraWindows = new Set<BrowserWindow>()

/** The floating-panel window. Tracked separately because it has lifecycle
 * privileges (tray bookkeeping, summon-hotkey targeting) that other windows
 * don't share. Additional windows go through `registerWindow`. */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

/**
 * Registers an additional BrowserWindow (e.g. the dedicated Settings window)
 * so broadcasts reach it too. Auto-unregisters on 'closed'.
 */
export function registerWindow(win: BrowserWindow): void {
  extraWindows.add(win)
  win.on('closed', () => {
    extraWindows.delete(win)
  })
}

/**
 * Sends `channel` to every active renderer. Safe to call before windows
 * exist. Pass `exceptSenderId` (typically `event.sender.id` inside an IPC
 * handler) to skip the originating window — used to avoid a second render
 * pass when that window already updated via the IPC return value.
 */
export function broadcast(channel: string, payload?: unknown, exceptSenderId?: number): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id !== exceptSenderId) {
    mainWindow.webContents.send(channel, payload)
  }
  for (const w of extraWindows) {
    if (!w.isDestroyed() && w.webContents.id !== exceptSenderId) {
      w.webContents.send(channel, payload)
    }
  }
}

/* ------------------------ flush-pending handshake ------------------------ */

/**
 * Bidirectional "flush before quit" handshake. Main fires `app:flush-pending`
 * to every renderer with a unique token; each renderer flushes its debounced
 * state and calls `history.flushAllAck(token)` to release the corresponding
 * promise. Resolves when every targeted window has ack'd, or after the
 * supplied timeout — whichever comes first.
 */
const pendingFlushes = new Map<string, () => void>()

let flushTokenCounter = 0
function nextFlushToken(): string {
  flushTokenCounter += 1
  return `flush-${Date.now()}-${flushTokenCounter}`
}

export function requestFlushPending(timeoutMs: number): Promise<void> {
  const targets: Array<{ token: string; promise: Promise<void> }> = []
  const send = (win: BrowserWindow): void => {
    const token = nextFlushToken()
    const promise = new Promise<void>((resolve) => {
      pendingFlushes.set(token, resolve)
    })
    targets.push({ token, promise })
    win.webContents.send('app:flush-pending', token)
  }
  if (mainWindow && !mainWindow.isDestroyed()) send(mainWindow)
  for (const w of extraWindows) {
    if (!w.isDestroyed()) send(w)
  }
  if (targets.length === 0) return Promise.resolve()

  // Hard timeout — a hung renderer must not block the quit budget. Cleans
  // up any unresolved tokens so a late ack doesn't leak a callback.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      for (const t of targets) pendingFlushes.delete(t.token)
      resolve()
    }, timeoutMs)
    void Promise.all(targets.map((t) => t.promise)).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Called from the `history:flush-all-ack` IPC handler. */
export function resolvePendingFlush(token: string): void {
  const resolve = pendingFlushes.get(token)
  if (!resolve) return
  pendingFlushes.delete(token)
  resolve()
}
