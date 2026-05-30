/**
 * Persistent chat history, SQLite-backed. One row per thread plus one row per
 * message keyed by `(thread_id, position)`. Each message keeps its full JSON
 * representation so non-content fields (attachments, tool calls, streaming
 * markers) round-trip without a wider schema change.
 *
 * On first boot we ingest the legacy `history.json` (both pre-threaded and
 * threaded shapes) into the tables and archive the file so it doesn't get
 * re-applied on the next launch.
 */
import { randomUUID } from 'node:crypto'
import { db, ingestLegacyJson } from './db'
import { getConfig } from './config'
import { indexMessages, removeByThread, clearEmbeddings } from '../embeddings'
import { log } from '../logger'
import {
  WELCOME_MESSAGE_ID,
  type ChatMessage,
  type ChatRole,
  type ChatThread,
  type HistorySummary,
  type MessageSearchHit,
  type ModeId,
  type ThreadSummary
} from '@shared/types'

interface HistoryFile {
  threads: ChatThread[]
  activeThreadId: string | null
}

/** Legacy shape from the pre-threaded codebase. */
interface LegacyHistory {
  messages?: ChatMessage[]
  summary?: HistorySummary | null
}

const MAX_MESSAGES_PER_THREAD = 500
const MAX_THREADS = 100

function sanitiseMessages(messages: ChatMessage[]): ChatMessage[] {
  return (messages ?? [])
    .filter((m): m is ChatMessage => Boolean(m && m.id !== WELCOME_MESSAGE_ID && !m.streaming))
    .slice(-MAX_MESSAGES_PER_THREAD)
}

interface ThreadRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  pinned: number
  summary: string | null
  pinned_mode: string | null
  pinned_system_prompt: string | null
  project_id: string | null
}

function rowToThread(t: ThreadRow, messages: ChatMessage[]): ChatThread {
  return {
    id: t.id,
    title: t.title,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    pinned: Boolean(t.pinned),
    messages,
    summary: t.summary ? (JSON.parse(t.summary) as HistorySummary) : null,
    pinnedMode: (t.pinned_mode as ModeId | null) ?? null,
    pinnedSystemPrompt: t.pinned_system_prompt ?? null,
    projectId: t.project_id ?? null
  }
}

function loadMessages(threadId: string): ChatMessage[] {
  const rows = db()
    .prepare(`SELECT json FROM messages WHERE thread_id = ? ORDER BY position ASC`)
    .all(threadId) as { json: string }[]
  // Skip-and-log corrupt rows individually instead of throwing the whole load.
  // One bad message used to crash thread open, leaving the user with an empty
  // history they couldn't recover from.
  const out: ChatMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    try {
      out.push(JSON.parse(rows[i].json) as ChatMessage)
    } catch (err) {
      log(
        'warn',
        'system',
        `Skipped corrupt message row ${i} in thread ${threadId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return out
}

/* --------------------------------- writes --------------------------------- */

function writeThreadRow(thread: ChatThread): void {
  db()
    .prepare(
      `INSERT INTO threads
         (id, title, created_at, updated_at, pinned, summary,
          pinned_mode, pinned_system_prompt)
       VALUES (@id, @title, @created_at, @updated_at, @pinned, @summary,
               @pinned_mode, @pinned_system_prompt)
       ON CONFLICT(id) DO UPDATE SET
         title                = excluded.title,
         updated_at           = excluded.updated_at,
         pinned               = excluded.pinned,
         summary              = excluded.summary,
         pinned_mode          = excluded.pinned_mode,
         pinned_system_prompt = excluded.pinned_system_prompt`
    )
    .run({
      id: thread.id,
      title: thread.title,
      created_at: thread.createdAt,
      updated_at: thread.updatedAt,
      pinned: thread.pinned ? 1 : 0,
      summary: thread.summary ? JSON.stringify(thread.summary) : null,
      pinned_mode: thread.pinnedMode ?? null,
      pinned_system_prompt: thread.pinnedSystemPrompt ?? null
    })
}

/**
 * Diff-and-upsert per-message write. The naive path of DELETE-then-INSERT-all
 * costs ~hundreds of statements every 1.2s on a 500-message thread during an
 * active conversation. Instead, in one transaction:
 *
 *  1. Snapshot existing rows for this thread (id + position + json).
 *  2. DELETE every row whose id is no longer in the new list (handles trims
 *     and shrinks).
 *  3. UPSERT each new message, but only when the JSON changed OR its row
 *     moved to a new position. `ON CONFLICT(id)` keeps a moved message a
 *     single row — no orphan duplicates.
 *
 * Common case (appending one assistant turn): zero deletes + one upsert.
 */
interface ExistingRow {
  id: string
  position: number
  json: string
}

function writeThreadMessages(threadId: string, messages: ChatMessage[]): void {
  const handle = db()
  const tx = handle.transaction((thread: string, msgs: ChatMessage[]) => {
    const existing = handle
      .prepare(`SELECT id, position, json FROM messages WHERE thread_id = ?`)
      .all(thread) as ExistingRow[]
    const existingById = new Map<string, ExistingRow>(existing.map((r) => [r.id, r]))
    const newIds = new Set(msgs.map((m) => m.id))

    // (1) Drop rows whose id is no longer in the new list. ON CONFLICT(id)
    // below handles position changes for surviving rows without needing
    // any per-position delete pass.
    const dropById = handle.prepare(`DELETE FROM messages WHERE id = ?`)
    for (const row of existing) {
      if (!newIds.has(row.id)) dropById.run(row.id)
    }

    // (2) Upsert each new message, skipping rows where the JSON and position
    // are both unchanged.
    const upsert = handle.prepare(`
      INSERT INTO messages (id, thread_id, role, content, created_at, position, json)
      VALUES (@id, @thread_id, @role, @content, @created_at, @position, @json)
      ON CONFLICT(id) DO UPDATE SET
        thread_id  = excluded.thread_id,
        role       = excluded.role,
        content    = excluded.content,
        created_at = excluded.created_at,
        position   = excluded.position,
        json       = excluded.json
    `)
    msgs.forEach((m, idx) => {
      const prior = existingById.get(m.id)
      const json = JSON.stringify(m)
      if (prior && prior.position === idx && prior.json === json) return
      upsert.run({
        id: m.id,
        thread_id: thread,
        role: m.role,
        content: m.content ?? '',
        created_at: m.createdAt ?? new Date().toISOString(),
        position: idx,
        json
      })
    })
  })
  tx(threadId, messages)
}

/* --------------------------- one-shot migration --------------------------- */

let migrated = false

function importLegacy(file: HistoryFile | LegacyHistory | undefined): void {
  if (!file) return
  if (Array.isArray((file as HistoryFile).threads)) {
    const f = file as HistoryFile
    for (const t of f.threads) {
      const messages = sanitiseMessages(t.messages)
      writeThreadRow({ ...t, messages, summary: t.summary ?? null })
      writeThreadMessages(t.id, messages)
    }
    if (f.activeThreadId) setActiveThreadInternal(f.activeThreadId)
    return
  }
  // Pre-threaded shape — promote to a single "Original chat" thread.
  const legacy = file as LegacyHistory
  const messages = sanitiseMessages(legacy.messages ?? [])
  if (messages.length === 0) return
  const id = randomUUID()
  const now = new Date().toISOString()
  writeThreadRow({
    id,
    title: 'Original chat',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messages,
    summary: legacy.summary ?? null
  })
  writeThreadMessages(id, messages)
  setActiveThreadInternal(id)
}

function ensureMigrated(): void {
  if (migrated) return
  migrated = true
  ingestLegacyJson<HistoryFile | LegacyHistory>('history', (parsed) => importLegacy(parsed))
}

/* -------------------------- active-thread bookkeeping -------------------- */

function setActiveThreadInternal(id: string): void {
  db()
    .prepare(
      `INSERT INTO meta(key, value) VALUES('active_thread', @id)
         ON CONFLICT(key) DO UPDATE SET value = @id`
    )
    .run({ id })
}

function getActiveThreadInternal(): string | null {
  const row = db().prepare(`SELECT value FROM meta WHERE key = 'active_thread'`).get() as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/* ----------------------------- public API ------------------------------- */

interface SummaryRow extends ThreadRow {
  message_count: number
  last_message_at: string | null
  preview: string | null
}

function rowToSummary(row: SummaryRow): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: Boolean(row.pinned),
    summary: row.summary ? (JSON.parse(row.summary) as HistorySummary) : null,
    messageCount: row.message_count,
    preview: (row.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    pinnedMode: (row.pinned_mode as ModeId | null) ?? null,
    pinnedSystemPrompt: row.pinned_system_prompt ?? null,
    projectId: row.project_id ?? null
  }
}

/**
 * Lightweight thread list — no message bodies. Cheap to ship over IPC and to
 * hold in renderer memory; the active thread's messages are fetched lazily
 * via `getThreadMessages`.
 *
 * The preview is the first user message's content (or any first message
 * fallback) so the sidebar can show a one-line teaser without round-tripping.
 */
export function getHistorySummaries(): {
  summaries: ThreadSummary[]
  activeThreadId: string | null
} {
  ensureMigrated()
  const rows = db()
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM messages WHERE thread_id = t.id) AS message_count,
              (SELECT MAX(created_at) FROM messages WHERE thread_id = t.id) AS last_message_at,
              (SELECT content
                 FROM messages
                WHERE thread_id = t.id AND role = 'user' AND content <> ''
                ORDER BY position ASC LIMIT 1) AS preview
       FROM threads t
       ORDER BY pinned DESC, updated_at DESC`
    )
    .all() as SummaryRow[]
  const summaries = rows.map(rowToSummary)
  let activeThreadId = getActiveThreadInternal()
  if (!activeThreadId || !summaries.some((s) => s.id === activeThreadId)) {
    activeThreadId = summaries[0]?.id ?? null
  }
  return { summaries, activeThreadId }
}

/** Returns just the message log for one thread, in position order. */
export function getThreadMessages(threadId: string): ChatMessage[] {
  ensureMigrated()
  return loadMessages(threadId)
}

/** Loads a single thread's summary by id — used by all summary-returning mutators. */
export function summaryFor(threadId: string): ThreadSummary | null {
  const row = db()
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM messages WHERE thread_id = t.id) AS message_count,
              (SELECT MAX(created_at) FROM messages WHERE thread_id = t.id) AS last_message_at,
              (SELECT content
                 FROM messages
                WHERE thread_id = t.id AND role = 'user' AND content <> ''
                ORDER BY position ASC LIMIT 1) AS preview
       FROM threads t
       WHERE t.id = ?`
    )
    .get(threadId) as SummaryRow | undefined
  return row ? rowToSummary(row) : null
}

/**
 * Searches every message across every thread by case-insensitive substring.
 * Replaces the renderer's old "iterate all in-memory threads" path so the
 * sidebar doesn't need to keep every message resident.
 *
 * Hard-capped to 200 hits — search is interactive and the user is going to
 * refine the query anyway.
 */
export function searchMessages(query: string): MessageSearchHit[] {
  ensureMigrated()
  const trimmed = query.trim()
  if (!trimmed) return []
  // SQLite LIKE is case-insensitive for ASCII by default; lower() the query
  // and the column to handle a wider range cheaply without FTS overhead.
  const needle = `%${trimmed.toLowerCase()}%`
  const rows = db()
    .prepare(
      `SELECT m.id        AS message_id,
              m.thread_id  AS thread_id,
              m.role       AS role,
              m.content    AS content,
              m.created_at AS created_at,
              t.title      AS thread_title
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
       WHERE LOWER(m.content) LIKE ?
       ORDER BY m.created_at DESC
       LIMIT 200`
    )
    .all(needle) as Array<{
    message_id: string
    thread_id: string
    role: string
    content: string
    created_at: string
    thread_title: string
  }>
  return rows.map((row) => {
    const idx = row.content.toLowerCase().indexOf(trimmed.toLowerCase())
    const start = Math.max(0, idx - 40)
    const end = Math.min(row.content.length, idx + trimmed.length + 80)
    const snippet =
      (start > 0 ? '…' : '') +
      row.content.slice(start, end).replace(/\s+/g, ' ').trim() +
      (end < row.content.length ? '…' : '')
    return {
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      messageId: row.message_id,
      role: row.role as ChatRole,
      createdAt: row.created_at,
      snippet
    }
  })
}

/**
 * Legacy full-history accessor — preserves the old `{ threads, activeThreadId }`
 * shape (each thread with its full messages array). Kept for the backup /
 * sync path which still needs the complete dataset to serialise.
 */
export function getHistory(): HistoryFile {
  ensureMigrated()
  const threadRows = db()
    .prepare(`SELECT * FROM threads ORDER BY updated_at DESC`)
    .all() as ThreadRow[]
  const threads = threadRows.map((row) => rowToThread(row, loadMessages(row.id)))
  let activeThreadId = getActiveThreadInternal()
  if (!activeThreadId || !threads.some((t) => t.id === activeThreadId)) {
    activeThreadId = threads[0]?.id ?? null
  }
  return { threads, activeThreadId }
}

/** Saves an entire thread (replacing its messages + summary). */
export function saveThread(
  threadId: string,
  messages: ChatMessage[],
  summary?: HistorySummary | null
): ThreadSummary | null {
  ensureMigrated()
  const existing = db().prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId) as
    | ThreadRow
    | undefined
  if (!existing) return null

  const trimmed = sanitiseMessages(messages)
  // Row update + message diff in one transaction — otherwise a write failure
  // after the row bump leaves `updated_at`/`summary` advanced for messages
  // that never actually landed, and the summary-reuse cache treats the
  // stale recap as fresh forever.
  db().transaction(() => {
    writeThreadRow({
      id: existing.id,
      title: existing.title,
      createdAt: existing.created_at,
      updatedAt: new Date().toISOString(),
      pinned: Boolean(existing.pinned),
      messages: trimmed,
      summary: summary ?? null,
      // Carry the existing pinned overrides forward — saveThread only touches
      // messages + summary; per-thread mode/prompt are mutated via their own
      // setters (`setThreadMode` / `setThreadSystemPrompt`).
      pinnedMode: (existing.pinned_mode as ModeId | null) ?? null,
      pinnedSystemPrompt: existing.pinned_system_prompt ?? null
    })
    writeThreadMessages(threadId, trimmed)
  })()

  // Quietly index any new messages so RAG can recall them later. Best-effort;
  // gated on the toggle so users who don't want it don't pay the API cost.
  if (getConfig().chat.rag) {
    const inputs = trimmed
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
      .map((m) => ({
        id: m.id,
        threadId,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        createdAt: m.createdAt
      }))
    void indexMessages(inputs).catch((err: unknown) => {
      log(
        'warn',
        'rag',
        'Background indexing failed (best-effort, chat continues)',
        err instanceof Error ? err.message : String(err)
      )
    })
  }
  return summaryFor(threadId)
}

/**
 * Adds a new empty thread.
 *
 * Default behaviour (used by the chat sidebar's "+" button) flips the
 * persisted active-thread pointer to the new id — that's the right call
 * for an interactive create-and-jump-in workflow.
 *
 * Headless callers (v2.0 scheduled research bridge being the first) pass
 * `setActive: false` so a background thread materialisation does NOT
 * silently steal the user's in-flight conversation focus. The new thread
 * shows up in the sidebar on next refresh; the user picks it up only when
 * they explicitly click in.
 *
 * The MAX_THREADS trim also respects `setActive: false` and the current
 * active thread — without this guard a background trim could evict the
 * exact conversation the user is mid-typing in.
 */
export function createThread(title?: string, opts: { setActive?: boolean } = {}): ThreadSummary {
  ensureMigrated()
  const id = randomUUID()
  const now = new Date().toISOString()
  writeThreadRow({
    id,
    title: title?.trim() || 'New chat',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messages: [],
    summary: null
  })
  const shouldSetActive = opts.setActive !== false
  if (shouldSetActive) setActiveThreadInternal(id)

  // Trim to MAX_THREADS — drop the oldest (by updatedAt) unpinned threads.
  // The currently-active thread is excluded so a background createThread
  // call (scheduler brief landing while the user has 100 threads open) can't
  // evict the conversation they're actively reading; the just-created thread
  // is also excluded so concurrent ticks racing the trim don't undo each
  // other's work.
  const overflow =
    (db().prepare(`SELECT COUNT(*) AS c FROM threads`).get() as { c: number }).c - MAX_THREADS
  if (overflow > 0) {
    const activeId = getActiveThreadInternal()
    const stale = db()
      .prepare(
        `SELECT id FROM threads
         WHERE pinned = 0 AND id != ? AND (? IS NULL OR id != ?)
         ORDER BY updated_at ASC LIMIT ?`
      )
      .all(id, activeId, activeId, overflow) as { id: string }[]
    for (const s of stale) deleteThread(s.id)
  }
  // A just-created thread always has a summary; the non-null assertion is
  // safe because we just wrote it.
  return summaryFor(id) as ThreadSummary
}

/** Renames a thread; returns the updated summary, or null if it wasn't found. */
export function renameThread(id: string, title: string): ThreadSummary | null {
  ensureMigrated()
  const info = db()
    .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || 'Untitled', new Date().toISOString(), id)
  if (info.changes === 0) return null
  return summaryFor(id)
}

/** Removes a thread; if it was active, falls back to the most recent. */
export function deleteThread(id: string): {
  summaries: ThreadSummary[]
  activeThreadId: string | null
} {
  ensureMigrated()
  const handle = db()
  const tx = handle.transaction(() => {
    handle.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(id)
    handle.prepare(`DELETE FROM threads WHERE id = ?`).run(id)
    if (getActiveThreadInternal() === id) {
      const fallback = handle
        .prepare(`SELECT id FROM threads ORDER BY updated_at DESC LIMIT 1`)
        .get() as { id: string } | undefined
      if (fallback) setActiveThreadInternal(fallback.id)
      else handle.prepare(`DELETE FROM meta WHERE key = 'active_thread'`).run()
    }
  })
  tx()
  removeByThread(id)
  return getHistorySummaries()
}

/** Toggles a thread's pinned flag; returns the updated summary or null. */
export function setThreadPinned(id: string, pinned: boolean): ThreadSummary | null {
  ensureMigrated()
  const info = db()
    .prepare(`UPDATE threads SET pinned = ?, updated_at = ? WHERE id = ?`)
    .run(pinned ? 1 : 0, new Date().toISOString(), id)
  if (info.changes === 0) return null
  return summaryFor(id)
}

/**
 * Sets (or clears, with `null`) a thread's pinned mode override. When set,
 * the chat pipeline uses this mode instead of `config.activeMode` — fresh
 * "story so far" summaries get computed in that mode's voice too.
 */
export function setThreadMode(id: string, mode: ModeId | null): ThreadSummary | null {
  ensureMigrated()
  const info = db()
    .prepare(`UPDATE threads SET pinned_mode = ?, updated_at = ? WHERE id = ?`)
    .run(mode, new Date().toISOString(), id)
  if (info.changes === 0) return null
  return summaryFor(id)
}

/** Sets (or clears, with `null`) a thread's pinned system prompt override. */
export function setThreadSystemPrompt(id: string, prompt: string | null): ThreadSummary | null {
  ensureMigrated()
  const info = db()
    .prepare(`UPDATE threads SET pinned_system_prompt = ?, updated_at = ? WHERE id = ?`)
    .run(prompt && prompt.trim() ? prompt : null, new Date().toISOString(), id)
  if (info.changes === 0) return null
  return summaryFor(id)
}

export function setActiveThread(id: string): void {
  ensureMigrated()
  const present = db().prepare(`SELECT 1 FROM threads WHERE id = ?`).get(id)
  if (present) setActiveThreadInternal(id)
}

/** Wipes a thread's messages + summary but leaves the thread itself listed. */
export function clearThread(id: string): ThreadSummary | null {
  ensureMigrated()
  removeByThread(id)
  return saveThread(id, [], null)
}

/** Drops every thread and starts fresh. */
export function clearAllThreads(): {
  summaries: ThreadSummary[]
  activeThreadId: string | null
} {
  ensureMigrated()
  const handle = db()
  const tx = handle.transaction(() => {
    handle.prepare(`DELETE FROM messages`).run()
    handle.prepare(`DELETE FROM threads`).run()
    handle.prepare(`DELETE FROM meta WHERE key = 'active_thread'`).run()
  })
  tx()
  clearEmbeddings()
  return { summaries: [], activeThreadId: null }
}

/** Replaces the whole history (used by backup import). */
export function replaceHistory(file: HistoryFile | LegacyHistory): HistoryFile {
  ensureMigrated()
  const handle = db()
  // Wipe + ingest in a single transaction so a malformed bundle can't leave
  // the database half-emptied.
  const tx = handle.transaction((payload: HistoryFile | LegacyHistory) => {
    handle.prepare(`DELETE FROM messages`).run()
    handle.prepare(`DELETE FROM threads`).run()
    handle.prepare(`DELETE FROM meta WHERE key = 'active_thread'`).run()
    importLegacy(payload)
  })
  try {
    tx(file)
  } catch (err) {
    log(
      'error',
      'system',
      'replaceHistory rolled back — bundle parse failed mid-import',
      err instanceof Error ? err.message : String(err)
    )
    throw err
  }
  return getHistory()
}
