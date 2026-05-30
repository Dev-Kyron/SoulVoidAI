/**
 * VoidSoul AI Companion — main process entry point.
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
import { startExtensionBridge, stopExtensionBridge } from './services/extension-bridge/server'
import { refreshAllModels } from './services/ai'
import { autoDetectAndAdopt } from './services/ai/detect'
import { closeDb } from './services/storage/db'
import { disposeWorker } from './services/rag-worker'
import { initScheduler, disposeScheduler } from './services/scheduler'
import { initSync, disposeSync } from './services/sync/engine'
import { initUpdater } from './services/updater'
import { stopScreenAwareness } from './services/screen/awareness'
import { isGranted } from './services/permissions/permissions'
import { broadcast, requestFlushPending } from './events'
import { loadDotEnv } from './env'
import { log } from './services/logger'
import { pauseAllRunningCheckpoints } from './services/storage/agent-checkpoints'

const SUMMON_SHORTCUT = 'CommandOrControl+Shift+Space'
/**
 * Spotlight-style global hotkey — opens the Quick AI overlay from anywhere.
 * Modelled after Raycast's quick-AI input: one-shot answer, no chat thread,
 * no provider config needed. The hotkey works whether the panel is visible
 * or hidden; the renderer summons the panel if collapsed.
 */
const QUICK_AI_SHORTCUT = 'CommandOrControl+Shift+J'
/**
 * v2.0 — Conversational voice mode global hotkey. Tap to start a
 * Jarvis-style hands-free session from anywhere; tap again to exit.
 * Distinct from QUICK_AI_SHORTCUT (one-shot quick answer) and SUMMON
 * (panel toggle) — voice mode is a *session*, not a one-shot.
 */
const CONVERSATION_SHORTCUT = 'CommandOrControl+Shift+V'

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

    // v2.0 — Conversation mode hotkey. Same showWindow pattern as
    // Quick AI so a tray-only user can start the voice loop from
    // anywhere; the renderer's store toggles in/out on each press.
    globalShortcut.register(CONVERSATION_SHORTCUT, () => {
      const win = getWindow()
      if (win && !win.isVisible()) showWindow()
      broadcast('conversation:toggle', undefined)
    })

    log('info', 'system', 'VoidSoul AI Companion started.')

    // Connect to any configured MCP servers in the background — slow servers
    // must not delay UI readiness, so we fire and forget.
    void initMcp()

    // v2.0 — browser-extension bridge. Off by default; only spin up the
    // local IPC server when the user has explicitly enabled it from
    // Settings → Tools → Browser Extension. Stale-socket cleanup happens
    // inside startExtensionBridge so a previous unclean exit doesn't
    // wedge the bind.
    if (getConfig().browserExtension?.enabled) {
      void startExtensionBridge().catch((err) => {
        log(
          'error',
          'system',
          'Browser-extension bridge failed to start',
          err instanceof Error ? err.message : String(err)
        )
      })
    }

    // Probe localhost for Ollama / LM Studio. If a local daemon is running and
    // the user has no working remote provider, switch the active provider to
    // it automatically — turns "download, paste 5 keys, then chat" into just
    // "download and chat" for users who already run a local model server.
    void autoDetectAndAdopt()

    // Discover any new models that landed since the last launch — surfaces a
    // toast and "NEW" badge in the model picker. Best-effort; silent on error.
    void refreshAllModels()

    // Scheduled-task runner ticks once a minute and fires due prompts headlessly.
    // The same tick loop now also evaluates v1.5.0 proactive watch tasks
    // (idle-duration + time-of-day) — they live in services/proactive/.
    initScheduler()

    // v2.0 — E2E cross-device sync. No-op if the user hasn't paired
    // this device with a vault. Boots a 60s push/pull loop when paired.
    void initSync()

    // v1.5.0 — seed the 4 built-in watch tasks (Task complete, Long idle,
    // Stuck loop, Morning recap). All ship disabled-by-default; user
    // opts in via Settings → Voice → Proactive. Idempotent — re-running
    // on each boot is fine because seedBuiltInWatchTasks() skips names
    // that already exist.
    void import('./services/proactive/watchTasks').then(({ seedBuiltInWatchTasks }) => {
      seedBuiltInWatchTasks()
    })

    // v1.7 — start the screen-watch loop. No-op if config.screenWatch.enabled
    // is false (default), so this is safe to run unconditionally. The loop
    // re-arms itself on config changes via config:set-screen-watch IPC.
    void import('./services/proactive/screenWatch').then(({ startScreenWatch }) => {
      startScreenWatch()
    })

    // Auto-updater — silently checks GitHub Releases on boot and notifies
    // the renderer when a new version is available / downloaded. No-op in
    // unpackaged dev. See `services/updater/index.ts` + `electron-builder.yml`
    // `publish:` block for the source-of-truth on which repo it queries.
    initUpdater()

    // v2.0 — opportunistic SQLite VACUUM. Wakes every few hours, runs
    // only when no chat / tool / agent step is in flight, and only if
    // the last vacuum was over a week ago. Keeps the chat DB compact
    // for users with long history. See storage/vacuum.ts for the
    // throttling rationale.
    void import('./services/storage/vacuum').then(({ startVacuumSchedule }) => {
      startVacuumSchedule()
    })

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
    // v2.0 polish — the screen-watch loop ALSO has its own setInterval
    // (separate from screenAwareness's). Without this stop, the
    // interval kept firing past closeDb(), and any vision tick reading
    // getConfig() through the closing SQLite handle crashed shutdown.
    void import('./services/proactive/screenWatch').then(({ stopScreenWatch }) => {
      stopScreenWatch()
    })
    stopAgentProgressPolling()
    disposeScheduler()
    // v2.0 round 10 — disposeSync() is async and the previous
    // fire-and-forget pattern let app.quit() race past the in-flight
    // push/pull. A debounced push that fired right before the user hit
    // Quit could half-write a chunk; the partial blob's mtime then made
    // it the LWW winner on the peer's next pull, clobbering newer
    // edits on the other device. Awaited inside the Promise.race below
    // (alongside disposeMcp / disposeWorker / stopExtensionBridge) so
    // the 3.5 s shutdown budget applies uniformly.
    const syncDisposal = disposeSync()
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
        // Promote any 'running' agent checkpoints to 'paused' BEFORE we
        // tear down IPC and shut the renderer. The user clicked Quit on
        // purpose — the runs aren't crashes, they're paused-by-intent.
        // On next launch the recovery banner frames them accordingly
        // and a resume from 'paused' reads cleanly.
        try {
          const paused = pauseAllRunningCheckpoints()
          if (paused > 0) {
            log('info', 'system', `Paused ${paused} in-flight agent run(s) for graceful shutdown.`)
          }
        } catch (err) {
          log(
            'warn',
            'system',
            'Failed to pause in-flight agent runs before shutdown',
            err instanceof Error ? err.message : String(err)
          )
        }
        disposeIpc()
        await Promise.race([
          // v2.0 — also tear down the browser-extension bridge so a stale
          // socket file doesn't survive into the next launch. The bridge
          // server unbinds + closes all native-host connections inside
          // its own dispose, with no further I/O after that.
          // v2.0 round 10 — syncDisposal awaited here so an in-flight
          // sync push/pull settles before SQLite closes (see disposeSync
          // call above for why this matters).
          Promise.all([
            disposeMcp(),
            disposeWorker(),
            stopExtensionBridge(),
            syncDisposal.catch(() => {})
          ]),
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
