/**
 * Vector store. SQLite-backed: one row per embedded chunk, vectors stored as
 * Float32 BLOBs (~4× smaller than JSON arrays). Each record carries the model
 * that produced it — search-time comparison only happens within a single
 * model's vector space.
 *
 * Two sources of records:
 *   - `source = 'chat'`: a message in a chat thread (`thread_id` set).
 *   - `source = 'file'`: a text chunk from an indexed file
 *     (`file_path` + `chunk_index` set).
 *
 * Storage migrates the previous JSON file (`embeddings.json`) on first boot.
 */
import { db, ingestLegacyJson, vectorToBlob, blobToVector } from '../storage/db'

export interface EmbeddingRecord {
  /** Primary key. For chat: message id. For files: `${path}#${chunkIndex}`. */
  messageId: string
  /** 'chat' or 'file'. Older callers omit it; we treat absent as 'chat'. */
  source?: 'chat' | 'file'
  /** Present for chat records; absent for file records. */
  threadId?: string | null
  /** Present for file records: absolute file path. */
  filePath?: string | null
  /** Present for file records: 0-based chunk index within the file. */
  chunkIndex?: number | null
  vector: number[]
  preview: string
  createdAt: string
  /** Chat records: 'user' | 'assistant'. File records: 'file'. */
  role: 'user' | 'assistant' | 'file'
  /**
   * The model that produced this vector. Stored so we never compare vectors
   * across embedding models (different dimensions / spaces are meaningless).
   */
  model: string
}

/**
 * Per-source caps. Trim is partitioned by source so a big file-RAG sweep can't
 * push out the user's chat history — without this, indexing a 20k-file project
 * would FIFO out the oldest chat embeddings (which are irreplaceable, unlike
 * file chunks which can be re-extracted from disk).
 *
 * The chat cap matches the old global cap so chat-only users see no change.
 * The file cap is larger because file vectors are recoverable — losing them
 * just costs a re-index, not history.
 */
let MAX_CHAT_RECORDS = 50_000
let MAX_FILE_RECORDS = 200_000

/**
 * Test-only hook for shrinking the caps so per-source trim behaviour can be
 * verified without inserting hundreds of thousands of rows. No-op in
 * production builds — Electron sets NODE_ENV=production for packaged
 * releases, so even if production code accidentally called this it can't
 * affect the live caps.
 */
export function __setEmbeddingCapsForTesting(caps: { chat?: number; file?: number }): void {
  if (process.env.NODE_ENV === 'production') return
  if (caps.chat !== undefined) MAX_CHAT_RECORDS = caps.chat
  if (caps.file !== undefined) MAX_FILE_RECORDS = caps.file
}

interface Row {
  id: string
  source: string
  thread_id: string | null
  file_path: string | null
  chunk_index: number | null
  role: string
  preview: string
  created_at: string
  model: string
  vector: Buffer
}

function rowToRecord(row: Row): EmbeddingRecord {
  return {
    messageId: row.id,
    source: (row.source === 'file' ? 'file' : 'chat'),
    threadId: row.thread_id,
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    role: row.role as EmbeddingRecord['role'],
    preview: row.preview,
    createdAt: row.created_at,
    model: row.model,
    vector: blobToVector(row.vector)
  }
}

let migrated = false

/** Idempotent one-shot ingest of the legacy JSON embedding store. */
function ensureMigrated(): void {
  if (migrated) return
  migrated = true
  ingestLegacyJson<{ records?: EmbeddingRecord[] }>('embeddings', (parsed) => {
    if (!parsed?.records?.length) return
    addEmbeddings(parsed.records)
  })
}

export function getEmbeddings(): EmbeddingRecord[] {
  ensureMigrated()
  const rows = db().prepare(`SELECT * FROM embeddings`).all() as Row[]
  return rows.map(rowToRecord)
}

/** Streams records to the caller without materialising the full list. */
export function forEachEmbedding(visit: (record: EmbeddingRecord) => void): void {
  ensureMigrated()
  const stmt = db().prepare(`SELECT * FROM embeddings`)
  for (const row of stmt.iterate() as IterableIterator<Row>) visit(rowToRecord(row))
}

export function hasEmbeddingFor(messageId: string): boolean {
  ensureMigrated()
  const row = db()
    .prepare(`SELECT 1 FROM embeddings WHERE id = ? LIMIT 1`)
    .get(messageId)
  return Boolean(row)
}

/**
 * Adds (or replaces) a batch of records, deduped by id. When a source's cap
 * is hit we drop the strictly oldest records IN THAT SOURCE (by created_at) —
 * partitioned trim ensures a file-RAG sweep can't push out chat history.
 */
export function addEmbeddings(records: EmbeddingRecord[]): void {
  if (records.length === 0) return
  ensureMigrated()
  const handle = db()
  const insert = handle.prepare(`
    INSERT INTO embeddings (id, source, thread_id, file_path, chunk_index, role, preview, created_at, model, vector)
    VALUES (@id, @source, @thread_id, @file_path, @chunk_index, @role, @preview, @created_at, @model, @vector)
    ON CONFLICT(id) DO UPDATE SET
      source      = excluded.source,
      thread_id   = excluded.thread_id,
      file_path   = excluded.file_path,
      chunk_index = excluded.chunk_index,
      role        = excluded.role,
      preview     = excluded.preview,
      created_at  = excluded.created_at,
      model       = excluded.model,
      vector      = excluded.vector
  `)
  // Source-scoped trim: only deletes within the named bucket. The schema
  // declares `source NOT NULL DEFAULT 'chat'` from v1, so a plain `source = ?`
  // comparison is safe AND lets the planner use the composite
  // (model, source) index — wrapping in COALESCE would force a full scan.
  const trimBySource = handle.prepare(`
    DELETE FROM embeddings
    WHERE id IN (
      SELECT id FROM embeddings
      WHERE source = @source
      ORDER BY created_at ASC
      LIMIT @overflow
    )
  `)
  const tx = handle.transaction((batch: EmbeddingRecord[]) => {
    for (const r of batch) {
      insert.run({
        id: r.messageId,
        source: r.source ?? 'chat',
        thread_id: r.threadId ?? null,
        file_path: r.filePath ?? null,
        chunk_index: r.chunkIndex ?? null,
        role: r.role,
        preview: r.preview,
        created_at: r.createdAt,
        model: r.model,
        vector: vectorToBlob(r.vector)
      })
    }
  })
  tx(records)

  // Trim outside the insert transaction so a 50k-vector backfill doesn't pay
  // for a GROUP BY on every batch. Only check the source(s) this batch
  // actually touched — a pure file-index sweep doesn't need to recount chat.
  const touched = new Set<'chat' | 'file'>()
  for (const r of records) touched.add(r.source ?? 'chat')
  const counts = countBySource()
  if (touched.has('chat') && counts.chat > MAX_CHAT_RECORDS) {
    trimBySource.run({ source: 'chat', overflow: counts.chat - MAX_CHAT_RECORDS })
  }
  if (touched.has('file') && counts.file > MAX_FILE_RECORDS) {
    trimBySource.run({ source: 'file', overflow: counts.file - MAX_FILE_RECORDS })
  }
}

export function removeByThread(threadId: string): void {
  ensureMigrated()
  db().prepare(`DELETE FROM embeddings WHERE thread_id = ?`).run(threadId)
}

export function removeByIds(ids: string[]): void {
  if (ids.length === 0) return
  ensureMigrated()
  const handle = db()
  const stmt = handle.prepare(`DELETE FROM embeddings WHERE id = ?`)
  const tx = handle.transaction((batch: string[]) => {
    for (const id of batch) stmt.run(id)
  })
  tx(ids)
}

export function removeByFilePath(path: string): void {
  ensureMigrated()
  db().prepare(`DELETE FROM embeddings WHERE file_path = ?`).run(path)
}

export function removeByFolder(folder: string): void {
  ensureMigrated()
  // Two issues to dodge: LIKE wildcards in the user's path (`_` is common in
  // Windows folder names, `%` is rare but legal), and `C:\proj` swallowing
  // `C:\projects`. Escape SQL wildcards and append a path separator so the
  // match is "folder + separator + anything", never "folder + sibling chars".
  const escaped = folder.replace(/[\\%_]/g, (m) => `\\${m}`)
  const sep = folder.includes('\\') ? '\\' : '/'
  db()
    .prepare(
      `DELETE FROM embeddings WHERE source = 'file' AND file_path LIKE ? ESCAPE '\\'`
    )
    .run(`${escaped}${sep}%`)
}

export function clearEmbeddings(): void {
  ensureMigrated()
  db().prepare(`DELETE FROM embeddings`).run()
}

/**
 * Deletes every embedding row whose model is NOT the supplied current model.
 * Used after the user switches embedding providers — old-model rows are
 * unreachable to cosine-search (the worker filters by model) AND they keep
 * counting against the per-source caps, so removing them frees both index
 * space and disk. Returns the number of rows removed for telemetry.
 */
export function removeNonCurrentModel(currentModel: string): number {
  ensureMigrated()
  const result = db()
    .prepare(`DELETE FROM embeddings WHERE model != ?`)
    .run(currentModel)
  return Number(result.changes ?? 0)
}

export function countEmbeddings(): number {
  ensureMigrated()
  const row = db().prepare(`SELECT COUNT(*) AS c FROM embeddings`).get() as { c: number }
  return row.c
}

/** Per-source row counts. Uses the plain `source` column so the planner can
 *  use the (model, source) composite index rather than full-scanning. */
export function countBySource(): { chat: number; file: number } {
  ensureMigrated()
  const rows = db()
    .prepare(`SELECT source, COUNT(*) AS c FROM embeddings GROUP BY source`)
    .all() as Array<{ source: string; c: number }>
  let chat = 0
  let file = 0
  for (const r of rows) {
    if (r.source === 'file') file = r.c
    else chat = r.c
  }
  return { chat, file }
}
