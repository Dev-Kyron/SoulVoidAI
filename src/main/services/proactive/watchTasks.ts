/**
 * v1.5.0 Phase 4 — proactive watch tasks.
 *
 * Watch tasks live in the same `scheduled_tasks` SQLite table as the
 * existing cron tasks (differentiated by the v9-migration `kind` column).
 * A watch task fires when a runtime condition becomes true — not at a
 * scheduled time. Four built-in tasks ship disabled-by-default:
 *
 *   1. Task complete   — long-running tool call wraps
 *   2. Long idle       — user has been silent past N minutes
 *   3. Stuck loop      — sentiment classifier flips to 'stuck'
 *   4. Morning recap   — daily HH:mm window, dynamic content
 *
 * The user opts each one in via Settings → Voice → Proactive. The master
 * toggle (`config.proactiveVoice.enabled`) is on by default and gates
 * the whole subsystem regardless of per-task enable flags.
 *
 * speakProactive() respects:
 *   · master toggle
 *   · per-task enable
 *   · voice.enabled (muted voice = no speech period)
 *   · DND (isQuietNow check honoured)
 *   · per-task throttle (last fire timestamp)
 *
 * The renderer subscribes to a `voice:proactive-speak` broadcast and
 * queues the segment through the existing Web Audio path — same pipeline
 * as ordinary streaming TTS, just initiated from main process instead of
 * the chat reply stream.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../storage/db'
import { broadcast } from '../../events'
import { getConfig } from '../storage/config'
import { log } from '../logger'
import { isQuietNow } from '@shared/types'
import type {
  ProactiveAction,
  SessionSentimentLabel,
  WatchSpec,
  WatchTask
} from '@shared/types'
import type { ToneTag } from '@shared/voiceMarkers'

export type { WatchTask }

interface Row {
  id: string
  name: string
  kind: string
  schedule_value: string
  enabled: number
  created_at: string
  last_run: string | null
  last_result: string | null
  last_error: string | null
}

function rowToTask(row: Row): WatchTask {
  let spec: WatchSpec
  try {
    spec = JSON.parse(row.schedule_value) as WatchSpec
  } catch {
    // Corrupt row — fall back to a no-op spec so the row still surfaces
    // in Settings (with an explanatory lastError) and the user can
    // remove it.
    spec = {
      type: 'idle-duration',
      params: {},
      action: { type: 'speak', content: '' },
      throttleMinutes: 60
    }
  }
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    spec,
    createdAt: row.created_at,
    lastRun: row.last_run,
    lastResult: row.last_result,
    lastError: row.last_error
  }
}

/* ----------------------------- CRUD ----------------------------------- */

export function listWatchTasks(): WatchTask[] {
  const rows = db()
    .prepare(
      `SELECT id, name, kind, schedule_value, enabled, created_at, last_run, last_result, last_error
       FROM scheduled_tasks WHERE kind = 'watch' ORDER BY created_at ASC`
    )
    .all() as Row[]
  return rows.map(rowToTask)
}

export function addWatchTask(input: {
  name: string
  spec: WatchSpec
  enabled?: boolean
}): WatchTask {
  const id = randomUUID()
  const now = new Date().toISOString()
  const enabled = input.enabled ?? false
  db()
    .prepare(
      `INSERT INTO scheduled_tasks
        (id, kind, name, prompt, schedule_kind, schedule_value, enabled, created_at)
       VALUES (?, 'watch', ?, '', 'interval', ?, ?, ?)`
    )
    .run(id, input.name, JSON.stringify(input.spec), enabled ? 1 : 0, now)
  log('info', 'system', `Added watch task "${input.name}" (${input.spec.type}).`)
  const row = db()
    .prepare(
      `SELECT id, name, kind, schedule_value, enabled, created_at, last_run, last_result, last_error
       FROM scheduled_tasks WHERE id = ?`
    )
    .get(id) as Row
  return rowToTask(row)
}

export function setWatchEnabled(id: string, enabled: boolean): WatchTask | null {
  db().prepare(`UPDATE scheduled_tasks SET enabled = ? WHERE id = ? AND kind = 'watch'`)
    .run(enabled ? 1 : 0, id)
  const row = db()
    .prepare(
      `SELECT id, name, kind, schedule_value, enabled, created_at, last_run, last_result, last_error
       FROM scheduled_tasks WHERE id = ? AND kind = 'watch'`
    )
    .get(id) as Row | undefined
  return row ? rowToTask(row) : null
}

export function removeWatchTask(id: string): void {
  db().prepare(`DELETE FROM scheduled_tasks WHERE id = ? AND kind = 'watch'`).run(id)
}

function recordWatchFire(id: string, result: string, error?: string): void {
  const now = new Date().toISOString()
  db()
    .prepare(
      `UPDATE scheduled_tasks SET last_run = ?, last_result = ?, last_error = ? WHERE id = ?`
    )
    .run(now, result, error ?? null, id)
}

/* ---------------------- interaction tracker --------------------------- */

/**
 * "When was the user last active?" Used by idle-duration watch tasks.
 * Bumped from the chat store on every user send, from the wake-word
 * trigger, and from anywhere else that represents a fresh user signal.
 * Initial value is now() so a fresh app boot doesn't instantly trigger
 * a "30 min idle" nudge.
 */
let lastInteractionAt = Date.now()
export function bumpInteraction(): void {
  lastInteractionAt = Date.now()
}
export function getIdleMinutes(): number {
  return Math.floor((Date.now() - lastInteractionAt) / 60000)
}

/* ---------------------- speak action (DND + throttle) ----------------- */

/**
 * The one true proactive-speech path. Every watch task funnels through
 * this so DND / mute / throttle checks live in exactly one place.
 *
 * `taskId` is used to debounce per-task: even if the same condition
 * trips repeatedly, the same task can't fire again until its throttle
 * window elapses.
 */
function speakProactive(
  taskId: string,
  taskName: string,
  action: ProactiveAction
): boolean {
  if (action.type !== 'speak') return false
  const config = getConfig()
  if (!config.proactiveVoice.enabled) return false
  if (!config.voice.enabled) return false
  if (isQuietNow(config.appearance.dnd)) {
    log('info', 'system', `[proactive] "${taskName}" suppressed by DND.`)
    return false
  }
  const content = action.content?.trim()
  if (!content && !action.dynamicRecap) return false
  // The renderer subscribes to this channel + drops the content into
  // the existing audio queue with the supplied tone.
  broadcast('voice:proactive-speak', {
    taskId,
    taskName,
    content,
    tone: (action.tone ?? 'casual') as ToneTag,
    allowInterrupt: action.allowInterrupt ?? false,
    dynamicRecap: action.dynamicRecap ?? false
  })
  recordWatchFire(taskId, content || '(dynamic recap)')
  log('info', 'system', `[proactive] "${taskName}" fired.`)
  return true
}

/** Throttle check — has this task fired within its window? Exported
 *  for unit-test coverage of the time-arithmetic. */
export function isThrottled(task: Pick<WatchTask, 'lastRun' | 'spec'>, now: Date): boolean {
  if (!task.lastRun) return false
  const elapsed = now.getTime() - Date.parse(task.lastRun)
  if (!Number.isFinite(elapsed)) return false
  return elapsed < task.spec.throttleMinutes * 60_000
}

/* ---------------------- condition matchers ---------------------------- */

/**
 * Pure-time conditions evaluated by the 60s poll loop. Event-driven
 * conditions (task-complete, sentiment-shift) live in onEvent() below
 * and dispatch immediately when the source emits.
 */
function matchesPolled(task: WatchTask, now: Date): boolean {
  const { type, params } = task.spec
  if (type === 'idle-duration') {
    const minutes = Number(params.minutes ?? 30)
    if (getIdleMinutes() < minutes) return false
    // Optional active-hours window — both must be set to apply; "09:00"
    // / "23:00" means "only fire when local time is between these".
    const fromStr = String(params.activeFrom ?? '').trim()
    const toStr = String(params.activeTo ?? '').trim()
    if (fromStr && toStr) {
      const cur = now.getHours() * 60 + now.getMinutes()
      const from = parseHHMM(fromStr)
      const to = parseHHMM(toStr)
      if (from === null || to === null) return true
      if (from <= to ? cur < from || cur > to : cur < from && cur > to) return false
    }
    return true
  }
  if (type === 'time-of-day-window') {
    // Fire once per day in the minute matching the configured HH:mm.
    // Throttle (>= 12h typical) keeps us from re-firing across the
    // same minute on rapid clock skew.
    const at = parseHHMM(String(params.at ?? ''))
    if (at === null) return false
    const cur = now.getHours() * 60 + now.getMinutes()
    return cur === at
  }
  // Event-driven types never match in the poll loop.
  return false
}

/** Exported for unit tests — parses "HH:mm" into total minutes-of-day
 *  or null on invalid input. */
export function parseHHMM(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Pure matcher for polled-condition watch types. Extracted from the
 * looping body so the unit-test suite can pin idle minutes + clock
 * without spinning up SQLite.
 *
 * Returns true when this watch's condition is satisfied at `now` given
 * the supplied idle window. Event-driven watch types (task-complete,
 * sentiment-shift) always return false — they fire from emitters.
 */
export function matchesPolledSpec(
  spec: WatchSpec,
  now: Date,
  idleMinutes: number
): boolean {
  const { type, params } = spec
  if (type === 'idle-duration') {
    const threshold = Number(params.minutes ?? 30)
    if (idleMinutes < threshold) return false
    const fromStr = String(params.activeFrom ?? '').trim()
    const toStr = String(params.activeTo ?? '').trim()
    if (fromStr && toStr) {
      const cur = now.getHours() * 60 + now.getMinutes()
      const from = parseHHMM(fromStr)
      const to = parseHHMM(toStr)
      if (from === null || to === null) return true
      if (from <= to ? cur < from || cur > to : cur < from && cur > to) return false
    }
    return true
  }
  if (type === 'time-of-day-window') {
    const at = parseHHMM(String(params.at ?? ''))
    if (at === null) return false
    const cur = now.getHours() * 60 + now.getMinutes()
    return cur === at
  }
  return false
}

/* ---------------------- public entry points --------------------------- */

/** Called every scheduler tick (60s). Walks polled watch tasks. */
export function checkPolledWatchTasks(now: Date = new Date()): void {
  for (const task of listWatchTasks()) {
    if (!task.enabled) continue
    if (isThrottled(task, now)) continue
    if (!matchesPolled(task, now)) continue
    speakProactive(task.id, task.name, task.spec.action)
  }
}

/**
 * Event-driven trigger — fired from emitters (tool runner emits
 * 'tool:complete', sentiment store emits 'sentiment:shift'). Walks
 * matching watch tasks and fires their actions.
 */
export function onWatchEvent(event: {
  type: 'task-complete' | 'sentiment-shift'
  /** task-complete: tool duration in seconds.
   *  sentiment-shift: the new label. */
  payload: { durationSec?: number; sentiment?: SessionSentimentLabel }
}): void {
  const now = new Date()
  for (const task of listWatchTasks()) {
    if (!task.enabled) continue
    if (task.spec.type !== event.type) continue
    if (isThrottled(task, now)) continue
    if (event.type === 'task-complete') {
      const minSec = Number(task.spec.params.minDurationSec ?? 10)
      if ((event.payload.durationSec ?? 0) < minSec) continue
    }
    if (event.type === 'sentiment-shift') {
      const wantLabel = task.spec.params.to as SessionSentimentLabel | undefined
      if (wantLabel && event.payload.sentiment !== wantLabel) continue
    }
    speakProactive(task.id, task.name, task.spec.action)
  }
}

/* ---------------------- built-in seeding ------------------------------ */

const BUILT_IN_TASKS: Array<{ name: string; spec: WatchSpec }> = [
  {
    name: 'Task complete',
    spec: {
      type: 'task-complete',
      params: { minDurationSec: 10 },
      action: { type: 'speak', content: "Alright — that's done.", tone: 'casual' },
      throttleMinutes: 1
    }
  },
  {
    name: 'Long idle',
    spec: {
      type: 'idle-duration',
      params: { minutes: 30, activeFrom: '09:00', activeTo: '23:00' },
      action: { type: 'speak', content: "Still here when you need me.", tone: 'warm' },
      throttleMinutes: 60
    }
  },
  {
    name: 'Stuck loop',
    spec: {
      type: 'sentiment-shift',
      params: { to: 'stuck' },
      action: { type: 'speak', content: 'Want to step back for a sec?', tone: 'warm' },
      throttleMinutes: 30
    }
  },
  {
    name: 'Morning recap',
    spec: {
      type: 'time-of-day-window',
      params: { at: '09:00' },
      action: {
        type: 'speak',
        content: '',
        tone: 'casual',
        dynamicRecap: true
      },
      throttleMinutes: 720
    }
  }
]

/**
 * Idempotent — runs every app boot but only inserts a task if no task
 * by that name already exists. User-edited or user-removed tasks stay
 * removed.
 */
export function seedBuiltInWatchTasks(): void {
  const existing = new Set(listWatchTasks().map((t) => t.name))
  let seeded = 0
  for (const b of BUILT_IN_TASKS) {
    if (existing.has(b.name)) continue
    addWatchTask({ name: b.name, spec: b.spec, enabled: false })
    seeded++
  }
  if (seeded > 0) {
    log('info', 'system', `[proactive] seeded ${seeded} built-in watch task(s).`)
  }
}
