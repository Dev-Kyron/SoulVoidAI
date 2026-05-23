/**
 * RAG worker thread. Owns its own SQLite connection (WAL mode lets multiple
 * threads read concurrently with the main process) and handles two CPU- or
 * IO-bound operations off the main process:
 *
 *  - `cosine-search`: iterates every embedding row matching the active model
 *    and computes cosine similarity against the supplied query vector.
 *  - `extract-file`: reads a file from disk and runs the appropriate
 *    extractor (PDF, DOCX, plain text) — keeps PDF parsing off the UI thread.
 *
 * The worker has no Electron module access (workers can use Node APIs but
 * not main-process Electron APIs), so the data directory is passed in via
 * `workerData` rather than being looked up.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import Database from 'better-sqlite3'
import {
  CODE_EXTENSIONS,
  PLAIN_TEXT_EXTENSIONS,
  isSupportedExtension
} from '../files-rag/extensions'
import { extractPdfText, extractDocxText } from '../parsers'
import type {
  CosineSearchHit,
  CosineSearchRequest,
  EmbedTextsRequest,
  EmbedTextsResult,
  ExtractFileRequest,
  ExtractFileResult,
  TranscribeAudioRequest,
  TranscribeAudioResult,
  WorkerBootData,
  WorkerRequest,
  WorkerResponse
} from './protocol'

if (!parentPort) throw new Error('rag-worker must be spawned via worker_threads')

const boot = workerData as WorkerBootData
const dbPath = join(boot.dataDir, 'voidsoul.db')

// Lazy DB handle — opened on first query and reused for the worker lifetime.
let dbHandle: Database.Database | null = null
function db(): Database.Database {
  if (dbHandle) return dbHandle
  const h = new Database(dbPath, { readonly: false, fileMustExist: false })
  h.pragma('journal_mode = WAL')
  h.pragma('foreign_keys = ON')
  dbHandle = h
  return h
}

function blobToVector(blob: Buffer): Float32Array {
  // Node Buffers share an underlying ArrayBuffer with a non-zero byteOffset.
  // Float32Array requires its byte offset to be a multiple of 4 — if better-
  // sqlite3 hands back an unaligned slice, the zero-copy view would throw.
  // Copy the bytes into a fresh aligned buffer to make this robust.
  if (blob.byteOffset % 4 === 0 && blob.byteLength % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
  }
  const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
  return new Float32Array(aligned)
}

function cosine(a: Float32Array, b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
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
  vector: Buffer
}

function handleCosineSearch(req: CosineSearchRequest): CosineSearchHit[] {
  const exclude = new Set(req.excludeIds ?? [])
  // Filter by model in SQL — drastically cuts the rows we iterate when the
  // user has switched embedding providers and the table holds both spaces.
  const where: string[] = ['model = ?']
  const params: unknown[] = [req.model]
  if (req.source) {
    where.push('source = ?')
    params.push(req.source)
  }
  const stmt = db().prepare(`SELECT * FROM embeddings WHERE ${where.join(' AND ')}`)
  const rows = stmt.iterate(...params) as IterableIterator<Row>

  const hits: CosineSearchHit[] = []
  for (const row of rows) {
    if (exclude.has(row.id)) continue
    const vec = blobToVector(row.vector)
    const score = cosine(vec, req.query)
    if (score < req.threshold) continue
    hits.push({
      messageId: row.id,
      source: (row.source === 'file' ? 'file' : 'chat'),
      threadId: row.thread_id,
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      preview: row.preview,
      role: row.role as CosineSearchHit['role'],
      createdAt: row.created_at,
      score
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, req.limit)
}

/* ------------------------------ extraction ----------------------------- */

const MAX_BYTES = 4 * 1024 * 1024

async function handleExtractFile(req: ExtractFileRequest): Promise<ExtractFileResult | null> {
  const ext = extname(req.path).toLowerCase()
  if (!isSupportedExtension(ext)) return null

  // Stat first so an oversized file doesn't get pulled fully into RAM before
  // we discover it's too big — a single 1GB file in the indexed folder would
  // otherwise spike the worker's memory.
  const stats = await stat(req.path)
  if (stats.size > MAX_BYTES) return null
  const buffer = await readFile(req.path)
  const sha = createHash('sha1').update(buffer).digest('hex')
  const meta = {
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    sha
  }

  if (PLAIN_TEXT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) {
    return { path: req.path, text: buffer.toString('utf-8'), ...meta }
  }
  if (ext === '.pdf') {
    return { path: req.path, text: await extractPdfText(buffer), ...meta }
  }
  if (ext === '.docx') {
    return { path: req.path, text: await extractDocxText(buffer), ...meta }
  }
  return null
}

/* ----------------------------- embeddings ------------------------------ */

/**
 * Local Transformers.js embedding pipeline. Lazy-loaded on first call so the
 * ~25 MB ONNX bundle + model download only happens for users who opt in to
 * the local embedder. Subsequent calls reuse the cached pipeline.
 *
 * Model: `Xenova/all-MiniLM-L6-v2` — 384-dim sentence embeddings, ubiquitous
 * baseline, well-supported in the Xenova fork. Cache lives under the user
 * data dir so the model survives upgrades and isn't redownloaded.
 */
const LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const LOCAL_MODEL_TAG = `local:${LOCAL_MODEL_ID}`

/**
 * Loads a Transformers.js pipeline with one-shot cache recovery. A network
 * drop mid-download leaves a partial ONNX in `hf-cache/<model>/...`; on the
 * next launch the pipeline load throws an opaque parse error and stays
 * permanently broken until the user finds and deletes the bad file.
 *
 * On failure we blow away the model's cache subdirectory (forcing a fresh
 * download next time), log the recovery attempt, then retry the load once.
 * If the retry also fails, the error propagates and the caller surfaces it
 * to the user — at that point it's not a stale-cache problem.
 *
 * The HF cache layout for Xenova models is `<cacheDir>/<modelId>/...` where
 * `modelId` is the namespace+name (e.g. `Xenova/whisper-tiny.en`). Removing
 * just that subtree leaves other models' caches intact.
 */
async function loadPipelineWithCacheRecovery<P>(
  task: string,
  modelId: string,
  cacheRoot: string
): Promise<P> {
  const transformers = (await import('@xenova/transformers')) as unknown as {
    pipeline: (task: string, model: string) => Promise<P>
    env: {
      cacheDir: string
      allowLocalModels: boolean
      allowRemoteModels: boolean
    }
  }
  transformers.env.cacheDir = cacheRoot
  transformers.env.allowRemoteModels = true
  transformers.env.allowLocalModels = true

  try {
    return await transformers.pipeline(task, modelId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // ONNX parse failures, JSON SyntaxErrors, EOF on the binary — all signal
    // a corrupted cache. Other errors (out of memory, etc) wouldn't recover
    // from a re-download, but the cost of trying once is small.
    const modelDir = join(cacheRoot, modelId)
    try {
      await rm(modelDir, { recursive: true, force: true })
    } catch {
      // If even rm fails (permissions), there's nothing else we can do —
      // the original error will surface on retry.
    }
    // One retry — fresh download.
    return await transformers.pipeline(task, modelId).catch((retryErr) => {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
      throw new Error(
        `Failed to load ${modelId} after cache recovery. ` +
          `Initial error: ${message}. Retry error: ${retryMsg}.`
      )
    })
  }
}

interface EmbedPipeline {
  (
    text: string | string[],
    opts: { pooling: 'mean'; normalize: boolean }
  ): Promise<{ data: Float32Array; dims: number[] }>
}

let embedPipelinePromise: Promise<EmbedPipeline> | null = null

function getEmbedPipeline(): Promise<EmbedPipeline> {
  if (!embedPipelinePromise) {
    // Point HF cache at our user-data dir so the model survives reinstalls
    // and Transformers.js doesn't drop ~25 MB into the CWD.
    embedPipelinePromise = loadPipelineWithCacheRecovery<EmbedPipeline>(
      'feature-extraction',
      LOCAL_MODEL_ID,
      join(boot.dataDir, 'hf-cache')
    ).catch((err) => {
      // Don't retain a rejected promise — clear so the next call retries
      // from scratch instead of getting the same rejection forever.
      embedPipelinePromise = null
      throw err
    })
  }
  return embedPipelinePromise
}

async function handleEmbedTexts(req: EmbedTextsRequest): Promise<EmbedTextsResult> {
  if (req.texts.length === 0) return { vectors: [], model: LOCAL_MODEL_TAG }
  const pipeline = await getEmbedPipeline()
  // The pipeline supports batched input; pooling='mean' + normalize=true is
  // the standard sentence-embedding setup for MiniLM. dims is [batch, hidden].
  const output = await pipeline(req.texts, { pooling: 'mean', normalize: true })
  const hidden = output.dims[output.dims.length - 1]
  const vectors: number[][] = []
  for (let i = 0; i < req.texts.length; i++) {
    const start = i * hidden
    const vec = new Array<number>(hidden)
    for (let j = 0; j < hidden; j++) vec[j] = output.data[start + j]
    vectors.push(vec)
  }
  return { vectors, model: LOCAL_MODEL_TAG }
}

/* ------------------------------ transcribe ----------------------------- */

/**
 * Local speech-to-text via Whisper-tiny.en (~75 MB ONNX, English-only). The
 * Transformers.js ASR pipeline accepts a Float32Array of audio samples at the
 * model's sample rate (16 kHz) and returns the transcription string.
 *
 * Lazy-loaded on first call so the WASM runtime + model download only happens
 * for users who actually use voice input — and only once per install since
 * the cache lives under the user-data dir alongside the embedder model.
 */
const WHISPER_MODEL_ID = 'Xenova/whisper-tiny.en'

interface AsrPipeline {
  (
    audio: Float32Array,
    opts?: {
      chunk_length_s?: number
      stride_length_s?: number
      /**
       * Generation-side guard against the "thank you thank you thank you…"
       * repetition loop Whisper-tiny falls into on low-energy or noisy
       * input. With n=3 the decoder refuses to emit any 3-gram it's
       * already emitted in the same call. Cheap, deterministic, and the
       * downside (rare loss of legitimate triple-word repeats like
       * "yes yes yes") is irrelevant to a wake-phrase use case.
       */
      no_repeat_ngram_size?: number
    }
  ): Promise<{ text: string }>
}

let asrPipelinePromise: Promise<AsrPipeline> | null = null

function getAsrPipeline(): Promise<AsrPipeline> {
  if (!asrPipelinePromise) {
    asrPipelinePromise = loadPipelineWithCacheRecovery<AsrPipeline>(
      'automatic-speech-recognition',
      WHISPER_MODEL_ID,
      join(boot.dataDir, 'hf-cache')
    ).catch((err) => {
      asrPipelinePromise = null
      throw err
    })
  }
  return asrPipelinePromise
}

async function handleTranscribeAudio(
  req: TranscribeAudioRequest
): Promise<TranscribeAudioResult> {
  if (req.sampleRate !== 16_000) {
    // The renderer should always resample to 16k; if it didn't, that's a bug
    // upstream — fail loudly rather than silently producing garbage transcripts.
    throw new Error(
      `Whisper requires 16kHz PCM; got ${req.sampleRate}Hz. Resample in the renderer first.`
    )
  }
  if (req.pcm.length === 0) return { text: '' }
  const pipeline = await getAsrPipeline()
  // chunk_length_s=30 matches Whisper's training context; clips under 30s
  // skip the chunking codepath entirely. stride_length_s prevents word-loss
  // at chunk boundaries for longer clips. no_repeat_ngram_size=3 kills the
  // "thank you thank you thank you" repetition loop the tiny.en model
  // falls into on quiet/noisy input — VAD already drops most silent
  // buffers (see whisper.ts wake engine) but the rare buffer that makes
  // it past VAD still benefits from the decoder-side guard.
  const out = await pipeline(req.pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    no_repeat_ngram_size: 3
  })
  return { text: (out.text ?? '').trim() }
}

/* ------------------------------ dispatcher ----------------------------- */

async function handle(message: WorkerRequest): Promise<WorkerResponse> {
  try {
    switch (message.op) {
      case 'cosine-search': {
        const result = handleCosineSearch(message.payload as CosineSearchRequest)
        return { id: message.id, ok: true, result }
      }
      case 'extract-file': {
        const result = await handleExtractFile(message.payload as ExtractFileRequest)
        return { id: message.id, ok: true, result }
      }
      case 'embed-texts': {
        const result = await handleEmbedTexts(message.payload as EmbedTextsRequest)
        return { id: message.id, ok: true, result }
      }
      case 'transcribe-audio': {
        const result = await handleTranscribeAudio(message.payload as TranscribeAudioRequest)
        return { id: message.id, ok: true, result }
      }
      case 'ping':
        return { id: message.id, ok: true, result: 'pong' }
      default:
        return { id: message.id, ok: false, error: `Unknown op: ${String(message.op)}` }
    }
  } catch (err) {
    return {
      id: message.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

parentPort.on('message', (message: WorkerRequest) => {
  void handle(message).then((response) => {
    parentPort?.postMessage(response)
  })
})

// Clean WAL checkpoint on shutdown — without this, on Windows the .db-shm /
// .db-wal sidecar files occasionally outlive the process.
process.on('exit', () => {
  if (dbHandle) {
    try {
      dbHandle.close()
    } catch {
      /* nothing useful to do at exit */
    }
  }
})
