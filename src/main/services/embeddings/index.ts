/**
 * RAG index public API. Wraps the SQLite-backed vector store and the embedding
 * provider:
 *  - `indexMessages`: embed any messages we haven't seen yet, then store them.
 *  - `indexFileChunks`: same shape but for file-source records.
 *  - `searchSimilar`: cosine-similarity over the records matching the
 *    currently-preferred embedding model. Returns chat + file hits.
 *  - `backfillFromThreads`: one-shot indexing of the user's existing chat
 *    history so RAG can recall older conversations the moment it's enabled.
 *    Tracks progress on a module-level counter the renderer can poll.
 *
 * All functions are best-effort: failures return zero / empty results rather
 * than throwing, so RAG never blocks the primary chat flow.
 */
import {
  addEmbeddings,
  clearEmbeddings,
  countBySource,
  countEmbeddings,
  distinctModelCount,
  hasEmbeddingFor,
  listChunkMetaForFile,
  listFileSummaries,
  removeByFilePath,
  removeByFolder,
  removeByIds,
  removeByThread,
  removeNonCurrentModel,
  type EmbeddingMeta,
  type EmbeddingRecord
} from './store'
import { embedTexts, embeddingsAvailable, preferredModel } from './provider'
import { cosineSearch } from '../rag-worker'
import {
  WELCOME_MESSAGE_ID,
  type ChatThread,
  type VectorStoreChunkRow,
  type VectorStoreFileSummary,
  type VectorStoreQueryTrace,
  type VectorStoreStats
} from '@shared/types'

const BATCH_SIZE = 50

export interface SearchHit {
  /** For chat: message id. For files: `${path}#${chunkIndex}`. */
  messageId: string
  source: 'chat' | 'file'
  /** Present for chat hits. */
  threadId?: string | null
  /** Present for file hits. */
  filePath?: string | null
  chunkIndex?: number | null
  preview: string
  role: 'user' | 'assistant' | 'file'
  createdAt: string
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number
}

export interface RagStatus {
  available: boolean
  indexed: number
  /** Active backfill progress, if one is running. */
  backfill?: { done: number; total: number }
}

let backfillProgress: { done: number; total: number } | null = null
let backfillRunning = false

export function getStatus(): RagStatus {
  return {
    available: embeddingsAvailable(),
    indexed: countEmbeddings(),
    ...(backfillProgress ? { backfill: { ...backfillProgress } } : {})
  }
}

interface ChatIndexInput {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
}

/** Embeds and stores any chat messages that aren't already in the index. */
export async function indexMessages(messages: ChatIndexInput[]): Promise<number> {
  if (messages.length === 0) return 0
  const fresh = messages.filter((m) => m.content.trim().length > 0 && !hasEmbeddingFor(m.id))
  if (fresh.length === 0) return 0

  let total = 0
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const batch = fresh.slice(i, i + BATCH_SIZE)
    const result = await embedTexts(batch.map((m) => m.content))
    if (!result) return total
    const records: EmbeddingRecord[] = batch.map((m, idx) => ({
      messageId: m.id,
      source: 'chat',
      threadId: m.threadId,
      vector: result.vectors[idx],
      preview: m.content.slice(0, 240),
      role: m.role,
      createdAt: m.createdAt ?? new Date().toISOString(),
      model: result.model
    }))
    addEmbeddings(records)
    total += records.length
  }
  return total
}

export interface FileChunkInput {
  /** Composite key, typically `${absolutePath}#${chunkIndex}`. */
  id: string
  filePath: string
  chunkIndex: number
  content: string
  createdAt?: string
}

/** Embeds and stores text chunks pulled from indexed files. */
export async function indexFileChunks(chunks: FileChunkInput[]): Promise<number> {
  if (chunks.length === 0) return 0
  const fresh = chunks.filter((c) => c.content.trim().length > 0 && !hasEmbeddingFor(c.id))
  if (fresh.length === 0) return 0

  let total = 0
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const batch = fresh.slice(i, i + BATCH_SIZE)
    const result = await embedTexts(batch.map((c) => c.content))
    if (!result) return total
    const records: EmbeddingRecord[] = batch.map((c, idx) => ({
      messageId: c.id,
      source: 'file',
      filePath: c.filePath,
      chunkIndex: c.chunkIndex,
      vector: result.vectors[idx],
      preview: c.content.slice(0, 240),
      role: 'file',
      createdAt: c.createdAt ?? new Date().toISOString(),
      model: result.model
    }))
    addEmbeddings(records)
    total += records.length
  }
  return total
}

/**
 * Indexes every message in every thread (the one-time backfill button).
 * Updates `backfillProgress` so the renderer can show "indexed N of M…".
 * Guarded against double-invocation: a second call while one is running
 * returns 0 immediately instead of interleaving with the first.
 */
export async function backfillFromThreads(threads: ChatThread[]): Promise<number> {
  if (backfillRunning) return 0
  backfillRunning = true
  const inputs: ChatIndexInput[] = []
  for (const thread of threads) {
    for (const m of thread.messages) {
      if (m.id === WELCOME_MESSAGE_ID) continue
      if (m.role !== 'user' && m.role !== 'assistant') continue
      if (!m.content?.trim()) continue
      if (hasEmbeddingFor(m.id)) continue
      inputs.push({
        id: m.id,
        threadId: thread.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt
      })
    }
  }

  if (inputs.length === 0) {
    backfillProgress = null
    backfillRunning = false
    return 0
  }

  backfillProgress = { done: 0, total: inputs.length }
  let added = 0
  try {
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE)
      const result = await embedTexts(batch.map((m) => m.content))
      if (!result) break
      addEmbeddings(
        batch.map((m, idx) => ({
          messageId: m.id,
          source: 'chat',
          threadId: m.threadId,
          vector: result.vectors[idx],
          preview: m.content.slice(0, 240),
          role: m.role,
          createdAt: m.createdAt ?? new Date().toISOString(),
          model: result.model
        }))
      )
      added += batch.length
      backfillProgress = { done: added, total: inputs.length }
    }
  } finally {
    backfillProgress = null
    backfillRunning = false
  }
  return added
}

export interface SearchOptions {
  limit?: number
  excludeIds?: string[]
  threshold?: number
  /** Restrict hits to a particular source. Omit to search both. */
  source?: 'chat' | 'file'
}

/**
 * Internal-only flag: skip the lastTrace capture inside searchSimilar.
 * Used by the Vector-store browser's Explore tab so the panel's own
 * probe queries don't clobber the chat layer's trace. Kept off the
 * public SearchOptions surface so callers don't have a debug knob they
 * shouldn't be touching.
 */
interface InternalSearchExtras {
  skipTrace?: boolean
}

export async function searchSimilar(
  query: string,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  return searchSimilarInternal(query, options, {})
}

async function searchSimilarInternal(
  query: string,
  options: SearchOptions,
  extras: InternalSearchExtras
): Promise<SearchHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const result = await embedTexts([trimmed])
  if (!result || !result.vectors[0]) return []

  // The actual cosine math runs in the RAG worker thread — keeps the main
  // process responsive even with 10k+ records, and is the seam where a future
  // local embedder (Transformers.js) would plug in without changing callers.
  const hits = await cosineSearch({
    query: result.vectors[0],
    model: result.model,
    limit: options.limit ?? 5,
    threshold: options.threshold ?? 0.3,
    excludeIds: options.excludeIds,
    source: options.source
  })
  const mapped: SearchHit[] = hits.map((h) => ({
    messageId: h.messageId,
    source: h.source,
    threadId: h.threadId,
    filePath: h.filePath,
    chunkIndex: h.chunkIndex,
    preview: h.preview,
    role: h.role,
    createdAt: h.createdAt,
    score: h.score
  }))
  // v2.0 — capture the most-recent retrieval for the Vector-store browser's
  // Query Trace tab. Store the raw hits and defer the chunk-row mapping
  // until the panel actually asks for it — the mapping is wasted work on
  // every chat retrieval otherwise (panel-open is the rare case).
  if (!extras.skipTrace) {
    lastTraceRaw = {
      query: trimmed,
      ranAt: new Date().toISOString(),
      hits: mapped
    }
  }
  return mapped
}

/* ---------------------- Vector-store browser surface ------------------- */

/**
 * v2.0 — single-slot memory of the most-recent retrieval, stored as RAW
 * hits so the per-chunk `recordToChunkRow` mapping only runs when the
 * panel actually opens. Keeps `searchSimilar` (which runs on every chat
 * RAG-enabled turn) free of vestigial allocations. Reset when the user
 * clears the index.
 */
interface RawTrace {
  query: string
  ranAt: string
  hits: SearchHit[]
}
let lastTraceRaw: RawTrace | null = null

/**
 * Translate an EmbeddingMeta / EmbeddingRecord / SearchHit into the
 * renderer-facing chunk row shape. All three carry the fields we need;
 * the only divergence is `score` (SearchHit-only) and `model`
 * (EmbeddingMeta + EmbeddingRecord), handled with safe defaults.
 *
 * Kept narrow on purpose — Float32Array vectors must never cross the
 * IPC bridge (they don't structured-clone cleanly and would balloon the
 * payload for no UI value). EmbeddingMeta is the same shape minus the
 * vector, so accepting it directly avoids an unnecessary decode upstream.
 */
function recordToChunkRow(src: EmbeddingMeta | SearchHit): VectorStoreChunkRow {
  return {
    id: src.messageId,
    source: (src.source ?? 'chat') as 'chat' | 'file',
    filePath: src.filePath ?? null,
    chunkIndex: src.chunkIndex ?? null,
    threadId: src.threadId ?? null,
    role: src.role,
    preview: src.preview,
    createdAt: src.createdAt,
    // SearchHit doesn't carry `model` (cosine-search doesn't read it);
    // empty string is fine because the panel only renders model when
    // the row originates from listChunksForFile (which DOES include it).
    model: 'model' in src ? src.model : '',
    // EmbeddingRecord has no score; SearchHit always does.
    score: 'score' in src ? src.score : undefined
  }
}

/** Aggregate counts + active-model info for the dashboard chip. */
export function vectorStoreStats(): VectorStoreStats {
  const by = countBySource()
  return {
    totalChunks: by.chat + by.file,
    chatChunks: by.chat,
    fileChunks: by.file,
    activeModel: embeddingsAvailable() ? preferredModel() : null,
    modelCount: distinctModelCount()
  }
}

/**
 * List indexed files (optionally restricted to one folder prefix). Returns
 * lightweight summaries — the browser fetches per-file chunk detail on
 * expand.
 */
export function listVectorStoreFiles(folderPrefix?: string): VectorStoreFileSummary[] {
  return listFileSummaries(folderPrefix)
}

/** Per-file chunk drill-down. */
export function listVectorStoreChunks(filePath: string): VectorStoreChunkRow[] {
  return listChunkMetaForFile(filePath).map((r) => recordToChunkRow(r))
}

/**
 * The most-recent retrieval trace, or null if none has run yet. Lazily
 * maps the raw hits to renderer-shape rows on read — most chat sessions
 * never open the panel, so we avoid the per-turn allocation up-front.
 */
export function getQueryTrace(): VectorStoreQueryTrace | null {
  if (!lastTraceRaw) return null
  return {
    query: lastTraceRaw.query,
    ranAt: lastTraceRaw.ranAt,
    hits: lastTraceRaw.hits.map((h) => recordToChunkRow(h))
  }
}

/** Reset the trace — called by clearEmbeddings + on user request. */
export function clearQueryTrace(): void {
  lastTraceRaw = null
}

/**
 * Run a query for the renderer's Query Explorer tab. Same retrieval path
 * as the chat layer uses, but doesn't pollute the trace slot (this IS
 * the trace already). The renderer renders the returned rows directly.
 */
export async function explainQuery(
  query: string,
  options: { limit?: number; source?: 'chat' | 'file' } = {}
): Promise<VectorStoreChunkRow[]> {
  const hits = await searchSimilarInternal(
    query,
    {
      limit: options.limit ?? 10,
      source: options.source
    },
    { skipTrace: true }
  )
  return hits.map((h) => recordToChunkRow(h))
}

/**
 * Wraps the raw store-level clear so the in-memory trace slot is reset
 * alongside the DB rows — otherwise a Cleared index would still surface
 * the last query trace pointing at chunks that no longer exist.
 */
function clearEmbeddingsWithTrace(): void {
  clearEmbeddings()
  clearQueryTrace()
}

export {
  clearEmbeddingsWithTrace as clearEmbeddings,
  preferredModel,
  removeByFilePath,
  removeByFolder,
  removeByIds,
  removeByThread,
  removeNonCurrentModel
}
