/**
 * Auto-update orchestration. Wraps `electron-updater` so the rest of the
 * app talks to a small, typed surface and so the implementation choice
 * (GitHub Releases via the `publish` block in `electron-builder.yml`) is
 * isolated here.
 *
 * Behaviour:
 *  - On app ready the updater silently checks for a new release.
 *  - Status transitions (`checking`, `available`, `not-available`, `downloading`,
 *    `downloaded`, `error`) are broadcast to every renderer over the
 *    `updater:status` event so the UI can show a toast + a "restart to
 *    update" affordance in Settings → About.
 *  - The user can trigger a manual check via `updater:check` IPC.
 *  - When a download is ready the user clicks "restart now" which calls
 *    `quitAndInstall` — restart replaces the binary in-place on Windows;
 *    on macOS this requires a signed build (notify-only otherwise; the
 *    user has to download manually).
 *
 * Dev-mode safety: `electron-updater` refuses to run when `app.isPackaged`
 * is false. We early-out so dev sessions don't spam errors.
 */
import { app } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { broadcast } from '../../events'
import { log } from '../logger'

/**
 * Status surfaced to the renderer. Mirrors electron-updater's lifecycle but
 * keeps the shape app-specific so we don't leak the underlying API.
 */
export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; checkedAt: string }
  | { kind: 'available'; version: string; releaseNotes: string | null }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

let currentStatus: UpdaterStatus = { kind: 'idle' }
let initialised = false

function setStatus(next: UpdaterStatus): void {
  currentStatus = next
  broadcast('updater:status', next)
}

export function getUpdaterStatus(): UpdaterStatus {
  return currentStatus
}

/**
 * Trigger a check. Resolves the freshly-computed status so callers can
 * surface a one-shot toast ("No update available" / "Update found").
 * Idempotent — concurrent checks short-circuit and reuse the in-flight one.
 */
export async function checkForUpdates(): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    // electron-updater does nothing useful in dev. Surface a friendly
    // status so the Settings button shows "dev build" instead of error.
    setStatus({ kind: 'not-available', checkedAt: new Date().toISOString() })
    return currentStatus
  }
  if (currentStatus.kind === 'checking' || currentStatus.kind === 'downloading') {
    return currentStatus
  }
  setStatus({ kind: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update check failed.'
    setStatus({ kind: 'error', message })
    log('warn', 'system', 'Update check failed', message)
  }
  return currentStatus
}

/**
 * Restarts the app and replaces the binary with the downloaded update.
 * No-op if no update is ready. On macOS without a signed build this still
 * fires but the OS rejects the silent install — the unsigned-Mac path is
 * notify-only by design.
 */
export function quitAndInstall(): void {
  if (currentStatus.kind !== 'downloaded') return
  // Pass `isSilent=true, isForceRunAfter=true` — common indie default:
  // restart without an additional installer wizard, relaunch the app.
  autoUpdater.quitAndInstall(true, true)
}

/**
 * Wire up the updater. Called once during main process boot. Subsequent
 * calls are no-ops so a future "settings hot-reload" can't double-bind
 * the event handlers.
 */
export function initUpdater(): void {
  if (initialised) return
  initialised = true

  // No-op in unpackaged dev. We still want to be able to read the status
  // so the renderer doesn't blank out the About panel.
  if (!app.isPackaged) {
    log('info', 'system', 'Updater idle — dev mode (unpackaged).')
    return
  }

  // We surface our own UI ("update ready, restart to apply") so the OS
  // notification would be a duplicate.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ kind: 'checking' }))

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const notes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes
              .map((n) => n.note)
              .filter(Boolean)
              .join('\n')
          : null
    setStatus({ kind: 'available', version: info.version, releaseNotes: notes })
    log('info', 'system', `Update available: v${info.version}`)
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({ kind: 'not-available', checkedAt: new Date().toISOString() })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setStatus({
      kind: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: Math.round(progress.bytesPerSecond)
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus({ kind: 'downloaded', version: info.version })
    log('success', 'system', `Update downloaded: v${info.version} — restart to apply.`)
  })

  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    setStatus({ kind: 'error', message })
    log('warn', 'system', 'Updater error', message)
  })

  // Initial silent check. Wrapped in setTimeout so it doesn't block the
  // boot tick — the network can be slow and we want the UI to come up first.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      const message = err instanceof Error ? err.message : 'Update check failed.'
      setStatus({ kind: 'error', message })
      log('warn', 'system', 'Initial update check failed', message)
    })
  }, 4000)
}
