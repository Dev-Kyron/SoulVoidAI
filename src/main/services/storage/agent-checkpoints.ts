/**
 * Persistent agent-loop checkpoints.
 *
 * The renderer's agent loop writes a row when a multi-step run starts,
 * UPDATEs that row on every step with the latest turns + invocations +
 * step counter, then finalises it to a terminal status when the loop
 * exits (paused / completed / failed / aborted).
 *
 * The stored `turns` and `invocations` are diagnostic snapshots, not
 * provider-replayable input. The renderer strips image data URLs to
 * the literal placeholder `[image]` before persisting (see
 * `sanitiseTurnsForCheckpoint` in useChatStore) — this keeps SQLite
 * blobs lean over long visual-agent runs but means a future tool
 * reading checkpoint state directly can't feed it back to a provider
 * verbatim. Resume runs always rebuild fresh turns from the thread's
 * message history rather than from these stored bytes.
 *
 * Why this exists:
 *   - Sustained 1-hour runs need to survive a crash, sleep, or restart
 *     without the user losing every minute of progress.
 *   - The step-cap "type continue to resume" UX needs a place to store
 *     the in-flight context across user sessions, not just in renderer
 *     memory.
 *   - The headless / tray-progress story (B4) reads the same rows to
 *     report status without the panel being open.
 *
 * On boot, any row still at `running` is treated as a crash-recovery
 * candidate (the loop was mid-step when something killed the process).
 * The recovery UI offers to resume or discard.
 *
 * Pruning: terminal rows older than 30 days are deleted lazily on each
 * call to `listStaleRunning` so the table doesn't accumulate orphaned
 * history forever.
 */
import { db } from './db'
import { log } from '../logger'
import type {
  AgentCheckpoint,
  AgentCheckpointCreate,
  AgentCheckpointStatus,
  AgentCheckpointUpdate,
  ChatTurn,
  ToolInvocation,
  ProviderId
} from '@shared/types'

interface Row {
  request_id: string
  thread_id: string
  user_message_id: string
  assistant_message_id: string
  provider_id: string
  model_id: string
  system_prompt: string
  turns_json: string
  invocations_json: string
  step: number
  status: string
  failure: string | null
  created_at: string
  updated_at: string
}

/**
 * Tolerant JSON parser — corrupt persisted JSON should never crash the
 * whole agent system. Bad payloads degrade to empty arrays so the
 * resume flow can still load the row's other fields.
 */
function safeParse<T>(json: string, fallback: T, label: string): T {
  try {
    return JSON.parse(json) as T
  } catch (err) {
    log(
      'warn',
      'system',
      `agent-checkpoints: corrupt ${label} JSON — falling back to default`,
      err instanceof Error ? err.message : String(err)
    )
    return fallback
  }
}

function rowToCheckpoint(row: Row): AgentCheckpoint {
  return {
    requestId: row.request_id,
    threadId: row.thread_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    providerId: row.provider_id as ProviderId,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    turns: safeParse<ChatTurn[]>(row.turns_json, [], 'turns'),
    invocations: safeParse<ToolInvocation[]>(row.invocations_json, [], 'invocations'),
    step: row.step,
    status: row.status as AgentCheckpointStatus,
    failure: row.failure,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Insert the initial checkpoint when an agent loop starts. The row is
 * stamped status='running'; subsequent step updates only touch the
 * mutable fields (step, turns_json, invocations_json, updated_at).
 *
 * Uses INSERT OR IGNORE rather than INSERT OR REPLACE so a second
 * create with the same requestId can't accidentally resurrect a row
 * that has already been finalised. If that race ever happens (e.g.
 * a runaway resume re-using a stale requestId), the second create is
 * silently dropped and the existing terminal status survives.
 *
 * UUID requestIds collide with cosmological-event probability, so the
 * "two creates" scenario almost only matters for retry loops in dev,
 * where the safer behaviour is "leave the old row alone".
 */
export function createCheckpoint(input: AgentCheckpointCreate): void {
  const now = new Date().toISOString()
  db()
    .prepare(
      `INSERT OR IGNORE INTO agent_checkpoints
         (request_id, thread_id, user_message_id, assistant_message_id,
          provider_id, model_id, system_prompt, turns_json,
          invocations_json, step, status, failure, created_at, updated_at)
       VALUES
         (@request_id, @thread_id, @user_message_id, @assistant_message_id,
          @provider_id, @model_id, @system_prompt, @turns_json,
          @invocations_json, 0, 'running', NULL, @created_at, @updated_at)`
    )
    .run({
      request_id: input.requestId,
      thread_id: input.threadId,
      user_message_id: input.userMessageId,
      assistant_message_id: input.assistantMessageId,
      provider_id: input.providerId,
      model_id: input.modelId,
      system_prompt: input.systemPrompt,
      turns_json: JSON.stringify(input.turns),
      invocations_json: '[]',
      created_at: now,
      updated_at: now
    })
}

/**
 * Mid-loop update — bumps step + accumulated state. Called after each
 * agent step lands. Fire-and-forget from the renderer's perspective;
 * persistence happens synchronously on the main side (better-sqlite3 is
 * non-async) so the write completes before the next IPC tick.
 */
export function updateCheckpoint(requestId: string, patch: AgentCheckpointUpdate): void {
  db()
    .prepare(
      `UPDATE agent_checkpoints
       SET step = @step,
           turns_json = @turns_json,
           invocations_json = @invocations_json,
           updated_at = @updated_at
       WHERE request_id = @request_id
         AND status = 'running'`
    )
    .run({
      request_id: requestId,
      step: patch.step,
      turns_json: JSON.stringify(patch.turns),
      invocations_json: JSON.stringify(patch.invocations),
      updated_at: new Date().toISOString()
    })
}

/**
 * Mark the loop as finished — terminal status (paused / completed /
 * failed / aborted). After this call, the row is never updated again
 * (the `status = 'running'` guard on updateCheckpoint prevents that).
 */
export function finalizeCheckpoint(
  requestId: string,
  status: Exclude<AgentCheckpointStatus, 'running'>,
  failure: string | null = null
): void {
  db()
    .prepare(
      `UPDATE agent_checkpoints
       SET status = @status,
           failure = @failure,
           updated_at = @updated_at
       WHERE request_id = @request_id`
    )
    .run({
      request_id: requestId,
      status,
      failure,
      updated_at: new Date().toISOString()
    })
}

/**
 * Lightweight SELECT — every row currently at status='running', sorted
 * newest-first. No side-effects. Used by the tray's progress poll which
 * fires every few seconds and shouldn't trigger a full prune sweep that
 * often.
 */
export function getRunningCheckpoints(): AgentCheckpoint[] {
  const rows = db()
    .prepare(
      `SELECT * FROM agent_checkpoints
       WHERE status = 'running'
       ORDER BY updated_at DESC`
    )
    .all() as Row[]
  return rows.map(rowToCheckpoint)
}

/**
 * Fetch every row still marked `running` on app boot — these are the
 * crash-recovery candidates. Sorted newest-first so the UI shows the
 * most recent first if the user has multiple unfinished loops.
 *
 * Side-effects (best-effort; failures don't block the read):
 *   1. Prune terminal rows older than 30 days so the table doesn't
 *      grow forever from completed history.
 *   2. Prune `running` rows older than 7 days as phantoms — these are
 *      almost certainly crash artefacts the user no longer cares
 *      about. Without this, a user who crashes-and-ignores 50 times
 *      ends up with a 50-pill recovery banner on every launch.
 *
 * The boot-time variant of getRunningCheckpoints — same query, but
 * paired with the prune so the panel-mount path is the natural place
 * for the table to self-maintain.
 */
export function listStaleRunning(): AgentCheckpoint[] {
  try {
    const terminalCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const phantomCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    db()
      .prepare(
        `DELETE FROM agent_checkpoints
         WHERE (status != 'running' AND updated_at < @terminalCutoff)
            OR (status = 'running' AND updated_at < @phantomCutoff)`
      )
      .run({ terminalCutoff, phantomCutoff })
  } catch (err) {
    log(
      'warn',
      'system',
      'agent-checkpoints: pruning sweep failed',
      err instanceof Error ? err.message : String(err)
    )
  }
  return getRunningCheckpoints()
}

/** Single-checkpoint lookup. Used by the resume flow once the user picks one. */
export function getCheckpoint(requestId: string): AgentCheckpoint | null {
  const row = db()
    .prepare(`SELECT * FROM agent_checkpoints WHERE request_id = ?`)
    .get(requestId) as Row | undefined
  return row ? rowToCheckpoint(row) : null
}

/**
 * Delete a checkpoint by requestId. Called when the user dismisses a
 * recovery prompt, or when the renderer has fully resumed and persisted
 * the work elsewhere (so the row is no longer needed).
 */
export function deleteCheckpoint(requestId: string): void {
  db().prepare(`DELETE FROM agent_checkpoints WHERE request_id = ?`).run(requestId)
}

/**
 * Graceful-shutdown helper. Promotes every row still at status='running'
 * to status='paused' in a single UPDATE — the user clicked Quit while
 * agent loops were live, but that's a deliberate stop, not a crash.
 * Marking the rows 'paused' lets the recovery UI on the next launch
 * frame them as "you stopped this on purpose, resume?" instead of
 * "looks like something crashed". Phantom-running prune logic stays
 * unaffected since this only runs on a real before-quit.
 *
 * Returns the count of rows it touched so the shutdown sequence can
 * log how many runs were caught mid-flight.
 */
export function pauseAllRunningCheckpoints(): number {
  const now = new Date().toISOString()
  const result = db()
    .prepare(
      `UPDATE agent_checkpoints
       SET status = 'paused',
           failure = 'Paused on app quit — resume to continue.',
           updated_at = ?
       WHERE status = 'running'`
    )
    .run(now)
  return Number(result.changes ?? 0)
}
