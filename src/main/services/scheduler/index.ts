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
import { runDeepResearch } from '../automation/deepResearch'
import { createThread, saveThread } from '../storage/history'
import { showWindow } from '../../window'
import {
  isQuietNow,
  type ChatMessage,
  type ChatRequest,
  type ScheduledTask,
  type ScheduleKind,
  type TaskKind,
  type TaskMode
} from '@shared/types'

export type { ScheduledTask, ScheduleKind, TaskKind, TaskMode }

/** Main-only input shape — `id`/timestamps are server-assigned. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  scheduleValue: string
  /** v2.0 — execution mode. Defaults to `'prompt'` (the original
   *  behaviour) so any caller that didn't update gets back-compat. */
  mode?: TaskMode
}

interface TaskRow {
  id: string
  name: string
  prompt: string
  /** v1.5.0+ — 'cron' (default for back-compat) or 'watch'. */
  kind: string
  /** v2.0 — 'prompt' (default) or 'research'. NULL for rows that
   *  pre-date the v10 migration; rowToTask coerces to 'prompt'. */
  mode: string | null
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
    // Pre-v2 rows pre-date the mode column; coerce NULL to 'prompt' (the
    // original execution behaviour). Unknown future values also fall back
    // to 'prompt' so a downgrade can't accidentally fire research.
    mode: row.mode === 'research' ? 'research' : 'prompt',
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
/**
 * v2.0 — small random jitter applied to recurring schedules so multiple
 * tasks configured for the same instant (three "every 5min" tasks all
 * created in the same minute, or two "daily 09:00" tasks) don't
 * thundering-herd onto the AI provider at the exact same wall-clock
 * tick. The jitter is intentionally small (under a minute for daily,
 * 15s for interval) so the user's "every 5 min" expectation still
 * reads as accurate.
 *
 * `once` tasks get NO jitter — the user specified a precise instant
 * and we honour it. `random` is injectable for tests.
 */
function applyJitter(baseMs: number, kind: ScheduleKind, random: () => number): number {
  if (kind === 'once') return baseMs
  // Uniform ± window. `interval` users tolerate seconds; `daily` users
  // tolerate a minute. Subtracting `* 2 - 1` shifts [0,1) → [-1,1).
  const windowMs = kind === 'interval' ? 15_000 : 60_000
  return baseMs + Math.round((random() * 2 - 1) * windowMs)
}

export function computeNextRun(
  kind: ScheduleKind,
  value: string,
  now: Date = new Date(),
  random: () => number = Math.random
): string | null {
  if (kind === 'once') {
    const target = new Date(value)
    if (Number.isNaN(target.getTime())) return null
    return target.getTime() > now.getTime() ? target.toISOString() : null
  }
  if (kind === 'interval') {
    const minutes = Number(value)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    const baseMs = now.getTime() + minutes * 60_000
    return new Date(applyJitter(baseMs, kind, random)).toISOString()
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
    return new Date(applyJitter(next.getTime(), kind, random)).toISOString()
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
  const mode: TaskMode = input.mode === 'research' ? 'research' : 'prompt'
  db()
    .prepare(
      `INSERT INTO scheduled_tasks
       (id, kind, mode, name, prompt, schedule_kind, schedule_value, enabled, created_at, next_run)
       VALUES (?, 'cron', ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, mode, input.name, input.prompt, input.scheduleKind, input.scheduleValue, now, next)
  log(
    'info',
    'system',
    `Added scheduled task "${input.name}" (${input.scheduleKind}${mode === 'research' ? ', research' : ''}).`
  )
  return rowToTask(db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as TaskRow)
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
  return rowToTask(db().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as TaskRow)
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
       (id, kind, mode, name, prompt, schedule_kind, schedule_value, enabled, created_at, next_run)
       VALUES (?, 'cron', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const t of tasks) {
      if (!t || typeof t.id !== 'string') continue
      if (t.kind && t.kind !== 'cron') continue // skip non-cron in cron restore path
      const nextRun = t.enabled ? computeNextRun(t.scheduleKind, t.scheduleValue) : null
      // Pre-v2 backups don't carry `mode` — default missing/unknown
      // values to 'prompt' so the restored task fires the original way.
      const mode: TaskMode = t.mode === 'research' ? 'research' : 'prompt'
      insert.run(
        t.id,
        mode,
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

/** Result shape shared by both execution modes. `threadId` is only set
 *  by the research path — it deep-links the OS notification to the
 *  newly-materialised chat thread carrying the synthesised brief. */
interface RunOutcome {
  ok: boolean
  output: string
  threadId?: string
}

async function runPromptTask(task: ScheduledTask, signal: AbortSignal): Promise<RunOutcome> {
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
  const outcome = await runCompletion(
    req,
    () => {
      /* discard deltas — this is headless */
    },
    signal
  )
  if (outcome.error) {
    return { ok: false, output: outcome.error }
  }
  return { ok: true, output: outcome.text }
}

/**
 * Module-level set of in-flight AbortControllers — one per executing task.
 * Lets `disposeScheduler` cancel everything currently mid-pipeline (deep
 * research synthesis call, long fetch, etc) at app quit so a research run
 * can't outlive the renderer it was meant to brief.
 */
const inFlight = new Set<AbortController>()

/**
 * Module-level keep-alive set for OS notifications carrying click
 * handlers. Electron's `Notification` instance must stay reachable from
 * JS for as long as the OS keeps the toast visible — Windows Action
 * Centre can hold a banner for hours and V8 GC will happily reap the
 * local `notification` const long before the user clicks, silently
 * breaking the brief deep-link. We drop the reference on `close` /
 * `click` / `failed` so the set drains.
 */
const liveNotifications = new Set<Notification>()

/**
 * Research-mode runner. Drives the deep-research pipeline (plan → search →
 * fetch → synthesise → cite), then materialises a fresh chat thread
 * carrying both the original topic (as the user message) and the
 * synthesised markdown brief (as the assistant message). The returned
 * `threadId` is what the notification click handler uses to deep-link
 * straight to the brief — without it the user would have to scroll
 * the sidebar hunting for "Research: …".
 *
 * Title strategy: the task's user-set `name` already represents the
 * user's mental shortcut ("Morning AI news roundup"), so we reuse it
 * verbatim. The user message body holds the full `prompt` (the actual
 * topic the model researched) so the brief reads naturally as a
 * question-and-answer exchange when opened.
 *
 * Failure semantics mirror prompt mode: deep_research returns
 * `{ ok: false, error }` rather than throwing, so a bad provider key /
 * search outage flows through to the OS notification as a normal
 * scheduled-task failure rather than crashing the scheduler tick.
 */
async function runResearchTask(task: ScheduledTask, signal: AbortSignal): Promise<RunOutcome> {
  // Mirror prompt mode's provider-key guard — deep_research's internal
  // plan/synthesise calls will fail at the LLM call anyway, but doing the
  // search + fetch work first wastes bandwidth, search-API quota, and
  // produces a confusing "401 from $provider" error in the notification
  // when the actual problem is "no key configured".
  const config = getConfig()
  const providerId = config.activeProvider
  if (PROVIDER_META[providerId].needsKey && !hasApiKey(providerId)) {
    return {
      ok: false,
      output: `Active provider (${PROVIDER_META[providerId].label}) has no API key — scheduled research skipped.`
    }
  }
  const result = await runDeepResearch({ topic: task.prompt, depth: 'deep', signal })
  if (!result.ok) {
    return { ok: false, output: result.error ?? 'Deep research failed with no error message.' }
  }
  const briefMarkdown = (result.output ?? '').trim()
  // Empty synthesis is a soft failure — the model returned ok but no
  // content (provider hiccup, filter, whitespace-only reply). Don't
  // materialise an empty thread the user would open and find blank.
  if (!briefMarkdown) {
    return {
      ok: false,
      output: 'Deep research produced an empty brief — no content to save.'
    }
  }
  // Materialise the brief into a chat thread the user can open later.
  // `setActive: false` is critical — without it createThread would flip
  // the persisted active-thread pointer to this brand-new brief, silently
  // hijacking whatever conversation the user is in the middle of. The
  // brief shows up in the sidebar on the next refresh; the user picks it
  // up only when they click the notification or the sidebar entry.
  const thread = createThread(task.name || 'Scheduled research', { setActive: false })
  const now = new Date().toISOString()
  const messages: ChatMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      content: task.prompt,
      createdAt: now
    },
    {
      id: randomUUID(),
      role: 'assistant',
      content: briefMarkdown,
      createdAt: now
    }
  ]
  const saved = saveThread(thread.id, messages, null)
  if (!saved) {
    // A concurrent createThread/MAX_THREADS trim could conceivably drop
    // the row between create and save (the trim guard makes this very
    // unlikely, but the race is bounded only by the SQLite single-writer
    // serialisation). Surface as failure rather than silently broadcast
    // a threadId pointing at a deleted row.
    return {
      ok: false,
      output: 'Brief synthesis succeeded but the thread row vanished before the save landed.'
    }
  }
  log(
    'success',
    'system',
    `deep_research: brief landed in thread "${thread.title}" (${briefMarkdown.length.toLocaleString()} chars)`
  )
  return { ok: true, output: briefMarkdown, threadId: thread.id }
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
    task.scheduleKind === 'once' ? null : computeNextRun(task.scheduleKind, task.scheduleValue)
  db().prepare(`UPDATE scheduled_tasks SET next_run = ? WHERE id = ?`).run(reservedNext, id)
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
  // One controller per task fire — registered in the module-level set so
  // disposeScheduler() can abort every in-flight run at app quit. Both
  // runPromptTask and runResearchTask consume the signal (deep_research
  // threads it through every sub-step; runCompletion forwards it to the
  // provider's fetch).
  const controller = new AbortController()
  inFlight.add(controller)
  let result: RunOutcome
  try {
    result =
      task.mode === 'research'
        ? await runResearchTask(task, controller.signal)
        : await runPromptTask(task, controller.signal)
  } catch (err) {
    result = { ok: false, output: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    inFlight.delete(controller)
  }
  const isOnce = task.scheduleKind === 'once'
  if (isOnce) {
    // `once` rows otherwise stack up forever as greyed-out tombstones. The
    // result is still broadcast (toast + OS notification below) so the user
    // doesn't miss the outcome.
    db().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(task.id)
  } else {
    // Research mode's `output` is the full synthesised markdown brief — up
    // to ~50k chars at deep depth. Stuffing that into last_result would
    // bloat the row + the Settings panel's "last result" preview for no
    // benefit (the brief lives in its own chat thread). Store a compact
    // pointer instead so the panel can render "Brief saved to a thread"
    // without re-fetching the markdown.
    const storedResult = result.ok
      ? task.mode === 'research'
        ? 'Brief saved to a new chat thread.'
        : result.output
      : null
    db()
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run = ?, next_run = ?, last_result = ?, last_error = ?
         WHERE id = ?`
      )
      .run(
        startedAt,
        computeNextRun(task.scheduleKind, task.scheduleValue),
        storedResult,
        result.ok ? null : result.output,
        task.id
      )
  }

  // Respect DND for the OS-level banner — quiet hours mean quiet hours,
  // including 3am scheduled summaries. The structured log entry still
  // records the run for later review.
  const quiet = isQuietNow(getConfig().appearance.dnd)
  if (!quiet) {
    // Research notifications get a different body + a click handler that
    // deep-links to the thread. Prompt-mode notifications keep their
    // original "first 240 chars of the reply" preview so existing users
    // see no behaviour change.
    const isResearchBrief = result.ok && task.mode === 'research' && !!result.threadId
    const notificationBody = result.ok
      ? isResearchBrief
        ? 'Your brief is ready — click to open the thread.'
        : result.output.slice(0, 240)
      : `Failed: ${result.output.slice(0, 200)}`
    try {
      const notification = new Notification({
        title: `VoidSoul · ${task.name}`,
        body: notificationBody
      })
      // Hold a strong reference until the OS retires the toast.
      // Without this Windows Action Centre can keep the banner around
      // for minutes-to-hours while V8 GC quietly reaps the local
      // `notification` const, breaking the click handler silently.
      liveNotifications.add(notification)
      const drop = (): void => {
        liveNotifications.delete(notification)
      }
      notification.once('close', drop)
      notification.once('failed', drop)
      if (isResearchBrief) {
        // Closure captures the freshly-allocated threadId so the click
        // handler always opens the right brief — even if another research
        // task fires moments later. showWindow() raises the main window
        // before the broadcast lands so the renderer has a focused frame
        // to swap threads in. Wrapped in try/catch — by the time the user
        // clicks, the main BrowserWindow may have been destroyed (Cmd+Q
        // mid-banner), in which case showWindow throws "Object has been
        // destroyed" and propagates as an uncaughtException with no
        // surface for the user to see what went wrong.
        const threadId = result.threadId as string
        const briefTaskName = task.name
        notification.on('click', () => {
          try {
            showWindow()
            broadcast('scheduler:open-brief', { threadId, taskName: briefTaskName })
          } catch (err) {
            log(
              'warn',
              'system',
              'Scheduler brief notification click handler threw',
              err instanceof Error ? err.message : String(err)
            )
          } finally {
            drop()
          }
        })
      } else {
        // Non-research notifications still need to be released after
        // click so the set drains under sustained scheduler usage.
        notification.once('click', drop)
      }
      notification.show()
    } catch {
      /* not all platforms support notifications */
    }
  }
  // Strip the (potentially 50KB) markdown brief from the broadcast for
  // research mode — the renderer only needs the threadId to deep-link,
  // and the brief lives in its own thread. Prompt-mode keeps the
  // original behaviour so the toast preview text is unchanged.
  const broadcastOutput =
    result.ok && task.mode === 'research' && result.threadId
      ? 'Brief saved to a new chat thread.'
      : result.output
  broadcast('scheduler:task-ran', {
    id: task.id,
    name: task.name,
    ok: result.ok,
    output: broadcastOutput,
    // Renderer uses this to decide whether to suppress its own toast.
    suppressed: quiet,
    // Present on a successful research run; renderer switches the toast
    // into a clickable "View brief" variant when set, and reloads the
    // sidebar so the new thread shows up immediately.
    threadId: result.threadId
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
    log(
      'error',
      'system',
      'Scheduler resume-tick threw',
      err instanceof Error ? err.message : String(err)
    )
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
  //
  // v2.0 polish — resolve the import ONCE and cache the function
  // reference. Previous version re-issued `void import('../proactive/...')`
  // on every 60s tick; ESM keeps the resolved module in its loader cache
  // but each call still allocates a Promise and walks the cache map.
  // 1440 wasted Promise allocations/day with no upside.
  let pollWatchTasks: (() => void) | null = null
  void import('../proactive/watchTasks').then(({ checkPolledWatchTasks }) => {
    pollWatchTasks = checkPolledWatchTasks
    // Run once immediately on init so the user doesn't wait 60s for
    // the first idle-duration evaluation.
    checkPolledWatchTasks()
  })
  tickTimer = setInterval(() => {
    if (pollWatchTasks) {
      try {
        pollWatchTasks()
      } catch (err) {
        log(
          'error',
          'system',
          'Watch-task poll threw',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
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
  // Cancel every in-flight task — deep_research's plan/synthesise calls
  // and runCompletion both honour the signal, so this kills outstanding
  // provider fetches at quit rather than letting them run on past the
  // process's natural lifetime and emit notifications against a torn-down
  // window. Clearing the set lets the AbortControllers GC.
  for (const controller of inFlight) controller.abort()
  inFlight.clear()
  // Drop any held notification refs; the OS owns the toasts now, but
  // we no longer need to keep their click closures alive after dispose.
  liveNotifications.clear()
  // Pair with the powerMonitor.on('resume', ...) added in initScheduler.
  // Lazy import again — same renderer-safety reasoning as the install side.
  void import('electron').then(({ powerMonitor }) => {
    powerMonitor.off?.('resume', onResume)
  })
}
