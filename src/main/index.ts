/**
 * VoidSoul Assistant — main process entry point.
 *
 * Boots a single-instance tray application: creates the floating widget
 * window, the system tray, registers the IPC surface and applies persisted
 * appearance settings.
 */
import { app, BrowserWindow, globalShortcut, session } from 'electron'
import { createMainWindow, getWindow, showWindow } from './window'
import { createTray, startAgentProgressPolling, stopAgentProgressPolling } from './tray'
import { registerIpc, applyAppearance, disposeIpc } from './ipc'
import { getConfig } from './services/storage/config'
import { loadPlugins } from './services/plugins/plugins'
import { initMcp, disposeMcp } from './services/mcp/manager'
import { refreshAllModels } from './services/ai'
import { autoDetectAndAdopt } from './services/ai/detect'
import { closeDb } from './services/storage/db'
import { disposeWorker } from './services/rag-worker'
import { initScheduler, disposeScheduler } from './services/scheduler'
import { initUpdater } from './services/updater'
import { stopScreenAwareness } from './services/screen/awareness'
import { isGranted } from './services/permissions/permissions'
import { broadcast, requestFlushPending } from './events'
import { loadDotEnv } from './env'
import { log } from './services/logger'

const SUMMON_SHORTCUT = 'CommandOrControl+Shift+Space'
/**
 * Spotlight-style global hotkey — opens the Quick AI overlay from anywhere.
 * Modelled after Raycast's quick-AI input: one-shot answer, no chat thread,
 * no provider config needed. The hotkey works whether the panel is visible
 * or hidden; the renderer summons the panel if collapsed.
 */
const QUICK_AI_SHORTCUT = 'CommandOrControl+Shift+J'

if (!app.requestSingleInstanceLock()) {
  // Another instance is already running — hand focus to it and exit.
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getWindow()
    if (win) showWindow()
  })

  app.whenReady().then(() => {
    loadDotEnv()
    loadPlugins()
    registerIpc()
    createMainWindow()
    createTray()
    // Headless agent-progress feed — reads agent_checkpoints every 4s
    // and reflects live runs on the tray tooltip + menu. Keeps the user
    // informed even when the panel is hidden, which is the whole point
    // of letting the loop run with backgroundThrottling disabled.
    startAgentProgressPolling()
    applyAppearance(getConfig().appearance)

    // Microphone capture is gated on VoidSoul's own "microphone" permission.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' && isGranted('microphone'))
    })
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === 'media' && isGranted('microphone')
    )

    // Global hotkey: summon a hidden widget, otherwise toggle the panel.
    globalShortcut.register(SUMMON_SHORTCUT, () => {
      const win = getWindow()
      if (win && !win.isVisible()) {
        showWindow()
        broadcast('widget:summon', 'expand')
      } else {
        broadcast('widget:summon', 'toggle')
      }
    })

    // Quick AI hotkey: always show the panel + open the overlay. Reuses
    // showWindow() so a tray-resident user can summon Quick AI directly
    // from inside any other app — Raycast paradigm.
    globalShortcut.register(QUICK_AI_SHORTCUT, () => {
      const win = getWindow()
      if (win && !win.isVisible()) showWindow()
      broadcast('quick-ai:open', undefined)
    })

    log('info', 'system', 'VoidSoul Assistant started.')

    // Connect to any configured MCP servers in the background — slow servers
    // must not delay UI readiness, so we fire and forget.
    void initMcp()

    // Probe localhost for Ollama / LM Studio. If a local daemon is running and
    // the user has no working remote provider, switch the active provider to
    // it automatically — turns "download, paste 5 keys, then chat" into just
    // "download and chat" for users who already run a local model server.
    void autoDetectAndAdopt()

    // Discover any new models that landed since the last launch — surfaces a
    // toast and "NEW" badge in the model picker. Best-effort; silent on error.
    void refreshAllModels()

    // Scheduled-task runner ticks once a minute and fires due prompts headlessly.
    initScheduler()

    // Auto-updater — silently checks GitHub Releases on boot and notifies
    // the renderer when a new version is available / downloaded. No-op in
    // unpackaged dev. See `services/updater/index.ts` + `electron-builder.yml`
    // `publish:` block for the source-of-truth on which repo it queries.
    initUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
        applyAppearance(getConfig().appearance)
      }
    })
  })

  // The widget lives in the tray — closing the window does not quit the app.
  app.on('window-all-closed', () => {
    /* intentionally left running; quit happens from the tray menu */
  })

  /**
   * Async-aware shutdown. MCP servers spawn child processes and the worker
   * thread holds its own SQLite handle — both need a moment to wind down
   * cleanly. We let the *first* before-quit run async cleanup (with a hard
   * timeout) and only then re-trigger the real quit.
   */
  let shuttingDown = false
  app.on('before-quit', (event) => {
    // Re-entry guard before any cleanup runs — `app.quit()` re-fires the
    // event after our async work resolves, and running disposeIpc / the
    // sync teardown twice would clear in-flight controllers a second time
    // (and trip any future I/O the cleanup callbacks might add).
    if (shuttingDown) return
    shuttingDown = true
    stopScreenAwareness()
    stopAgentProgressPolling()
    disposeScheduler()
    event.preventDefault()
    const FLUSH_BUDGET_MS = 1500
    const SHUTDOWN_BUDGET_MS = 3500
    const HARD_EXIT_BUDGET_MS = 6000
    // Flush every renderer's debounced state to disk BEFORE tearing down
    // IPC — otherwise the most recent chat turn could be lost if the user
    // quits during the 1.2s save-debounce window. After flush we move on
    // to the existing cleanup regardless (renderer might be hung).
    //
    // Wrapped in try/catch/finally: an uncaught throw inside the cleanup
    // block used to leave app.quit() unreached and the app a hung process
    // the user had to kill from Task Manager. A hard process.exit() backs
    // up the soft quit if the cleanup itself wedges past the budget.
    const hardExitTimer = setTimeout(() => {
      // Failsafe — log to stderr (no log file write, IPC may be torn down)
      // and force-exit. Better than leaving a zombie app behind.
      // eslint-disable-next-line no-console
      console.error('[shutdown] cleanup exceeded budget; forcing process.exit(1)')
      process.exit(1)
    }, HARD_EXIT_BUDGET_MS)
    hardExitTimer.unref?.()
    void (async () => {
      try {
        await requestFlushPending(FLUSH_BUDGET_MS)
        disposeIpc()
        await Promise.race([
          Promise.all([disposeMcp(), disposeWorker()]),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS))
        ])
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[shutdown] cleanup threw:', err)
      } finally {
        clearTimeout(hardExitTimer)
        app.quit()
      }
    })()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    // Close the main-side SQLite handle last, after the worker (which holds
    // a separate read handle on the same WAL DB) has had a chance to wind
    // down. Belt-and-braces: process exit would close the OS handle anyway.
    closeDb()
  })
}
