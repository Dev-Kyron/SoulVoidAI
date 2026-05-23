/**
 * Scheduled-task runner. Tasks are persisted in SQLite and ticked once a
 * minute; when one is due, the task's prompt is run headlessly through the
 * normal AI gateway and the result is broadcast to the renderer as a toast +
 * stored as `last_result` for the Settings panel to display.
 *
 * Three schedule kinds:
 *  - `daily` — value is "HH:mm", fires once per day at that local time
 *  - `interval` — value is a number of minutes, fires every N minutes
 *  - `once` — value is an ISO timestamp; auto-disables after firing
 *
 * Scheduling is intentionally simple. The OS isn't doing the work — we are —
 * so the assistant has to be running. That's the right tradeoff for a desktop
 * companion: scheduled prompts feel native to the app rather than living in a
 * separate cron daemon.
 */
import { randomUUID } from 'node:crypto'
import { Notification } from 'electron'
import { db } from '../storage/db'
import { runCompletion } from '../ai'
import { getConfig } from '../storage/config'
import { hasApiKey } from '../storage/keys'
import { PROVIDER_META } from '../ai/types'
import { broadcast } from '../../events'
import { log } from '../logger'
import {
  isQuietNow,
  type ChatRequest,
  type ScheduledTask,
  type ScheduleKind,
  type TaskKind
} from '@shared/types'

export type { ScheduledTask, ScheduleKind, TaskKind }

/** Main-only input shape — `id`/timestamps are server-assigned. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  scheduleValue: string
}

interface TaskRow {
  id: string
  name: string
  prompt: string
  /** v1.5.0+ — 'cron' (default for back-compat) or 'watch'. */
  kind: string
  schedule_kind: string
  schedule_value: string
  enabled: number
  created_at: string
  last_run: string | null
  next_run: string | null
  last_result: string | null
  last_error: string | null
}

const TICK_MS = 60_000

let tickTimer: ReturnType<typeof setInterval> | null = null

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    // Defensive — pre-v1.5 rows that pre-date the column have NULL or
    // missing kind values; treat them as 'cron' (the original behaviour).
    kind: (row.kind as TaskKind) ?? 'cron',
    scheduleKind: row.schedule_kind as ScheduleKind,
    scheduleValue: row.schedule_value,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastRun: row.last_run,
    nextRun: row.next_run,
    lastResult: row.last_result,
    lastError: row.last_error
  }
}

/**
 * Computes the next ISO timestamp at which a task should fire, given the
 * schedule kind/value and the current time. Returns null if the schedule has
 * no future occurrence (e.g. a 'once' task in the past).
 */
export function computeNextRun(
  kind: ScheduleKind,
  value: string,
  now: Date = new Date()
): string | null {
  if (kind === 'once') {
    const target = new Date(value)
    if (Number.isNaN(target.getTime())) return null
    return target.getTime() > now.getTime() ? target.toISOString() : null
  }
  if (kind === 'interval') {
    const minutes = Number(value)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    return new Date(now.getTime() + minutes * 60_000).toISOString()
  }
  if (kind === 'daily') {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match) return null
    const h = Number(match[1])
    const m = Number(match[2])
    if (h > 23 || m > 59) return null
    const next = new Date(now)
    next.setHours(h, m, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  return null
}

/* ------------------------------- crud ---------------------------------- */

export function listTasks(): ScheduledTask[] {
  // Returns CRON tasks only — the existing Settings panel for
  // "Scheduled tasks" shouldn't show watch tasks mixed in. Watch tasks
  // have their own listWatchTasks() surface in services/proactive/.
  const rows = db()
    .prepare(`SELECT * FROM scheduled_tasks WHERE kind = 'cron' ORDER BY created_at DESC`)
    .all() as TaskRow[]
  return rows.map(rowToTask)
}

export function addTask(input: ScheduledTaskInput): ScheduledTask {
  const id = randomUUID()
  const now = new Date().toISOString()
  const next = computeNextRun(input.scheduleKind, input.scheduleValue)
  db()
    .prepare(
      `INSERT INTO scheduled_tasks
       (id, kind, name, prompt, schedule_kind, schedule_value, enabled, created_at, next_run)
       VALUES (?, 'cron', ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, input.name, input.prompt, input.scheduleKind, input.scheduleValue, now, next)
  log('info', 'system', `Added scheduled task "${input.name}" (${input.scheduleKind}).`)
  return rowToTask(
    db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as TaskRow
  )
}

export function removeTask(id: string): void {
  db().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id)
}

export function setEnabled(id: string, enabled: boolean): ScheduledTask | null {
  const row = db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined
  if (!row) return null
  const nextRun = enabled
    ? computeNextRun(row.schedule_kind as ScheduleKind, row.schedule_value)
    : null
  db()
    .prepare(`UPDATE scheduled_tasks SET enabled = ?, next_run = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, nextRun, id)
  return rowToTask(
    db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as TaskRow
  )
}

/**
 * Wipe-and-restore the entire scheduled-tasks table — used by the backup
 * import path to bring a user's schedules over from another machine. Each
 * task's `next_run` is recomputed locally so a stale "next run is in the
 * past" from the exporting machine doesn't cause a firehose of catch-up
 * runs on the importing machine.
 */
export function replaceTasks(tasks: ScheduledTask[]): void {
  // Restore-from-backup path. Only handles cron tasks — watch tasks
  // are restored separately by services/proactive/. Backups created
  // by pre-v1.5 builds don't include the kind column; treat them as
  // cron (the only kind that existed at backup time).
  const database = db()
  const tx = database.transaction(() => {
    database.prepare(`DELETE FROM scheduled_tasks WHERE kind = 'cron'`).run()
    const insert = database.prepare(
      `INSERT INTO scheduled_tasks
       (id, kind, name, prompt, schedule_kind, schedule_value, enabled, created_at, next_run)
       VALUES (?, 'cron', ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const t of tasks) {
      if (!t || typeof t.id !== 'string') continue
      if (t.kind && t.kind !== 'cron') continue // skip non-cron in cron restore path
      const nextRun = t.enabled
        ? computeNextRun(t.scheduleKind, t.scheduleValue)
        : null
      insert.run(
        t.id,
        t.name,
        t.prompt,
        t.scheduleKind,
        t.scheduleValue,
        t.enabled ? 1 : 0,
        t.createdAt ?? new Date().toISOString(),
        nextRun
      )
    }
  })
  tx()
}

/* ----------------------------- execution ------------------------------- */

async function runTaskNow(task: ScheduledTask): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  const providerId = config.activeProvider
  const provider = config.providers[providerId]
  // Don't repeatedly alarm the user with "no key configured" notifications
  // when the active provider hasn't been set up. The task stays scheduled —
  // it'll just no-op until a key arrives.
  if (PROVIDER_META[providerId].needsKey && !hasApiKey(providerId)) {
    return {
      ok: false,
      output: `Active provider (${PROVIDER_META[providerId].label}) has no API key — scheduled task skipped.`
    }
  }
  const req: ChatRequest = {
    requestId: randomUUID(),
    provider: providerId,
    model: provider.model,
    system: config.systemPrompt,
    messages: [{ role: 'user', content: task.prompt }],
    temperature: 0.5
  }
  const controller = new AbortController()
  const outcome = await runCompletion(
    req,
    () => {
      /* discard deltas — this is headless */
    },
    controller.signal
  )
  if (outcome.error) {
    return { ok: false, output: outcome.error }
  }
  return { ok: true, output: outcome.text }
}

/** Runs a task immediately, regardless of its schedule. Used by the UI button. */
export async function runNow(id: string): Promise<ScheduledTask | null> {
  const row = db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined
  if (!row) return null
  const task = rowToTask(row)
  // Reserve `next_run` first so a tick that fires while we're mid-execution
  // doesn't see this row as still due and double-execute it.
  const reservedNext =
    task.scheduleKind === 'once'
      ? null
      : computeNextRun(task.scheduleKind, task.scheduleValue)
  db()
    .prepare(`UPDATE scheduled_tasks SET next_run = ? WHERE id = ?`)
    .run(reservedNext, id)
  await executeAndStore(task)
  // `once` tasks self-delete after firing — the second SELECT must tolerate
  // a missing row, otherwise clicking "Run now" on a one-shot crashes.
  const after = db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined
  return after ? rowToTask(after) : null
}

async function executeAndStore(task: ScheduledTask): Promise<void> {
  const startedAt = new Date().toISOString()
  let result: { ok: boolean; output: string }
  try {
    result = await runTaskNow(task)
  } catch (err) {
    result = { ok: false, output: err instanceof Error ? err.message : 'unknown error' }
  }
  const isOnce = task.scheduleKind === 'once'
  if (isOnce) {
    // `once` rows otherwise stack up forever as greyed-out tombstones. The
    // result is still broadcast (toast + OS notification below) so the user
    // doesn't miss the outcome.
    db().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(task.id)
  } else {
    db()
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run = ?, next_run = ?, last_result = ?, last_error = ?
         WHERE id = ?`
      )
      .run(
        startedAt,
        computeNextRun(task.scheduleKind, task.scheduleValue),
        result.ok ? result.output : null,
        result.ok ? null : result.output,
        task.id
      )
  }

  // Respect DND for the OS-level banner — quiet hours mean quiet hours,
  // including 3am scheduled summaries. The structured log entry still
  // records the run for later review.
  const quiet = isQuietNow(getConfig().appearance.dnd)
  if (!quiet) {
    const notificationBody = result.ok
      ? result.output.slice(0, 240)
      : `Failed: ${result.output.slice(0, 200)}`
    try {
      new Notification({ title: `VoidSoul · ${task.name}`, body: notificationBody }).show()
    } catch {
      /* not all platforms support notifications */
    }
  }
  broadcast('scheduler:task-ran', {
    id: task.id,
    name: task.name,
    ok: result.ok,
    output: result.output,
    // Renderer uses this to decide whether to suppress its own toast.
    suppressed: quiet
  })
  log(
    result.ok ? 'success' : 'warn',
    'system',
    `Scheduled task "${task.name}" ${result.ok ? 'ran' : 'failed'}${quiet ? ' (DND active)' : ''}.`,
    result.output.slice(0, 400)
  )
}

/* -------------------------------- tick --------------------------------- */

async function tick(): Promise<void> {
  const now = new Date().toISOString()
  const due = db()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?`
    )
    .all(now) as TaskRow[]
  if (due.length === 0) return
  // Reserve every due task's next_run first so a slow first task can't keep
  // the others waiting; subsequent ticks see the reservations and skip them.
  const reserve = db().prepare(`UPDATE scheduled_tasks SET next_run = ? WHERE id = ?`)
  const reserveAll = db().transaction((rows: TaskRow[]) => {
    for (const row of rows) {
      const kind = row.schedule_kind as ScheduleKind
      const reservedNext = kind === 'once' ? null : computeNextRun(kind, row.schedule_value)
      reserve.run(reservedNext, row.id)
    }
  })
  reserveAll(due)
  // Run the actual completions in parallel — they're independent and the
  // results are recorded per-task in `executeAndStore`.
  await Promise.all(due.map((row) => executeAndStore(rowToTask(row))))
}

/**
 * After the OS resumes from sleep, the setInterval may have skipped fires
 * for the duration of suspend (Electron pauses timers in that window on
 * most platforms). Run an immediate tick so anything that came due during
 * sleep (a daily 09:00 task while the laptop slept until 09:30) fires
 * shortly after wake instead of waiting up to a minute for the next tick.
 */
function onResume(): void {
  log('info', 'system', 'Power resume — running an immediate scheduler tick.')
  void tick().catch((err) => {
    log('error', 'system', 'Scheduler resume-tick threw', err instanceof Error ? err.message : String(err))
  })
}

export function initScheduler(): void {
  if (tickTimer) return
  // Lazy import to keep this module renderer-import-safe — `electron` is
  // only available in main and the static import would break the tests
  // that exercise computeNextRun via vitest.
  void import('electron').then(({ powerMonitor }) => {
    powerMonitor.on('resume', onResume)
  })
  // Lazy import — proactive subsystem lives in a sibling folder and
  // we only want to pay the cost when the scheduler is actually up.
  // The poll loop calls checkPolledWatchTasks() once per tick for the
  // idle-duration + time-of-day watch types (event-driven watches like
  // task-complete + sentiment-shift dispatch immediately from their
  // emitters, not from this loop).
  void import('../proactive/watchTasks').then(({ checkPolledWatchTasks }) => {
    // Run once immediately on init so the user doesn't wait 60s for
    // the first idle-duration evaluation.
    checkPolledWatchTasks()
  })
  tickTimer = setInterval(() => {
    void import('../proactive/watchTasks').then(({ checkPolledWatchTasks }) => {
      try {
        checkPolledWatchTasks()
      } catch (err) {
        log(
          'error',
          'system',
          'Watch-task poll threw',
          err instanceof Error ? err.message : String(err)
        )
      }
    })
    void tick().catch((err) => {
      log(
        'error',
        'system',
        'Scheduler tick threw',
        err instanceof Error ? err.message : String(err)
      )
    })
  }, TICK_MS)
  log('info', 'system', 'Scheduler started.')
}

export function disposeScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // Pair with the powerMonitor.on('resume', ...) added in initScheduler.
  // Lazy import again — same renderer-safety reasoning as the install side.
  void import('electron').then(({ powerMonitor }) => {
    powerMonitor.off?.('resume', onResume)
  })
}
