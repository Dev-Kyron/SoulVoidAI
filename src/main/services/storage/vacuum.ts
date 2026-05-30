/**
 * v2.0 — periodic SQLite VACUUM on idle.
 *
 * SQLite leaves deleted-row pages allocated; over months of chat use,
 * the file bloats and reads slow down (paging fragmented data). VACUUM
 * rebuilds the database compactly, but it takes an exclusive lock for
 * the duration of the rewrite — a few hundred ms for tens-of-MB DBs,
 * up to seconds for very large ones. Doing it while the user is mid-
 * chat would freeze incoming saves.
 *
 * Strategy:
 *   - Check every `CHECK_INTERVAL_MS` (default 4h).
 *   - Run VACUUM only if:
 *       (a) at least `MIN_DAYS_BETWEEN_VACUUMS` since the last run, AND
 *       (b) no in-flight work right now (`hasInFlightWork()` is false).
 *   - The "last vacuum at" timestamp persists across restarts via a
 *     small SQLite settings table (created on first call).
 *   - Failures are logged and don't block — VACUUM is opportunistic.
 *
 * The check fires on a single setInterval that starts on app init.
 * Cancel-on-quit lives in the disposeIpc-shaped cleanup wired below.
 */
import { log } from '../logger'
import { hasInFlightWork } from '../abort-registry'
import { db } from './db'

/** How often to wake up and consider running VACUUM. 4h means up to
 *  4h after a candidate window opens before we actually vacuum, which
 *  is fine for a once-a-week background chore. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

/** Minimum days between vacuums. Weekly is enough for typical usage;
 *  heavy users with rapid chat churn might want daily, but the lock
 *  duration trade-off says "default to weekly, the user is unlikely
 *  to notice either way". */
const MIN_DAYS_BETWEEN_VACUUMS = 7

let checkTimer: ReturnType<typeof setInterval> | null = null

/**
 * Tiny settings table — bottom-of-the-barrel key-value store living in
 * the same SQLite file. Used here for `last_vacuum_at`; we could grow
 * it for other persistent main-side counters later. Idempotent
 * creation so the migration story is "open and ensure".
 *
 * Latches once per process so we don't re-issue `CREATE TABLE IF NOT
 * EXISTS` on every get/set — cheap but pointless work given the timer
 * checks `getLastVacuumIso()` every 4h for the rest of the session.
 */
let settingsTableReady = false
function ensureSettingsTable(): void {
  if (settingsTableReady) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  settingsTableReady = true
}

function getLastVacuumIso(): string | null {
  ensureSettingsTable()
  const row = db().prepare(`SELECT value FROM settings WHERE key = 'last_vacuum_at'`).get() as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function setLastVacuumIso(iso: string): void {
  ensureSettingsTable()
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('last_vacuum_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(iso)
}

/**
 * One tick: decide whether to vacuum, run it if so. Exported so the
 * test harness or a future "Vacuum now" Settings button can trigger
 * it without waiting on the interval.
 *
 * Returns the action taken — `'skipped-busy' | 'skipped-recent' |
 * 'vacuumed' | 'failed'` — primarily for logging / future telemetry.
 * Most callers don't need it.
 */
export function maybeVacuum(): 'skipped-busy' | 'skipped-recent' | 'vacuumed' | 'failed' {
  if (hasInFlightWork()) return 'skipped-busy'
  const lastIso = getLastVacuumIso()
  if (lastIso) {
    const lastMs = Date.parse(lastIso)
    if (Number.isFinite(lastMs)) {
      const ageMs = Date.now() - lastMs
      if (ageMs < MIN_DAYS_BETWEEN_VACUUMS * 24 * 60 * 60 * 1000) {
        return 'skipped-recent'
      }
    }
  }
  try {
    const start = Date.now()
    db().exec('VACUUM')
    const elapsedMs = Date.now() - start
    setLastVacuumIso(new Date().toISOString())
    log('info', 'system', `SQLite VACUUM completed in ${elapsedMs}ms.`)
    return 'vacuumed'
  } catch (err) {
    log(
      'warn',
      'system',
      'SQLite VACUUM failed — will retry on the next idle window.',
      err instanceof Error ? err.message : String(err)
    )
    return 'failed'
  }
}

/**
 * Starts the periodic check. Idempotent — calling twice doesn't
 * stack timers. Wire from main/index.ts after the DB is opened.
 */
export function startVacuumSchedule(): void {
  if (checkTimer) return
  checkTimer = setInterval(maybeVacuum, CHECK_INTERVAL_MS)
  // Don't run immediately on boot — startup is the WORST time for a
  // multi-second exclusive lock. Wait at least one tick (CHECK_INTERVAL_MS)
  // before the first opportunity.
}

/** Cancel the timer — called from disposeIpc on shutdown. */
export function stopVacuumSchedule(): void {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}
