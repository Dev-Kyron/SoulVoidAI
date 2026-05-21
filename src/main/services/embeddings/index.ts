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
  countEmbeddings,
  hasEmbeddingFor,
  removeByFilePath,
  removeByFolder,
  removeByIds,
  removeByThread,
  removeNonCurrentModel,
  type EmbeddingRecord
} from './store'
import { embedTexts, embeddingsAvailable, preferredModel } from './provider'
import { cosineSearch } from '../rag-worker'
import { WELCOME_MESSAGE_ID, type ChatThread } from '@shared/types'

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
  const fresh = messages.filter(
    (m) => m.content.trim().length > 0 && !hasEmbeddingFor(m.id)
  )
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

export async function searchSimilar(
  query: string,
  options: SearchOptions = {}
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
  return hits.map((h) => ({
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
}

export {
  clearEmbeddings,
  preferredModel,
  removeByFilePath,
  removeByFolder,
  removeByIds,
  removeByThread,
  removeNonCurrentModel
}
