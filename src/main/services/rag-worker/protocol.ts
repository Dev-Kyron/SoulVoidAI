/**
 * Shared message protocol between the main process and the RAG worker thread.
 * Defined in one place so both sides import the same union — TypeScript catches
 * any drift between the worker's handler and the main-side proxy.
 *
 * Every request carries a unique `id` so the proxy can match replies back to
 * the originating Promise. Each `op` has a payload type and a result type.
 */

/* ----------------------------- search ops ------------------------------ */

export interface CosineSearchRequest {
  /** Query vector — must come from the same embedding model as `model`. */
  query: number[]
  /** Embedding model id; records from other models are filtered out. */
  model: string
  /** Maximum hits to return. */
  limit: number
  /** Minimum cosine similarity threshold (defaults to 0.3 if omitted). */
  threshold: number
  /** Optional ids to skip (already-included context, etc.). */
  excludeIds?: string[]
  /** Optional source filter; omit to search both chat + file records. */
  source?: 'chat' | 'file'
}

export interface CosineSearchHit {
  messageId: string
  source: 'chat' | 'file'
  threadId: string | null
  filePath: string | null
  chunkIndex: number | null
  preview: string
  role: 'user' | 'assistant' | 'file'
  createdAt: string
  score: number
}

/* --------------------------- extraction ops ---------------------------- */

export interface ExtractFileRequest {
  path: string
}

export interface ExtractFileResult {
  path: string
  text: string
  size: number
  mtime: string
  sha: string
}

/* ----------------------------- embed ops ------------------------------- */

/**
 * Run the local Transformers.js embedder on a batch of texts. The worker
 * lazy-loads the ONNX runtime + model on first call (~25 MB one-time
 * download for `all-MiniLM-L6-v2`) and caches the pipeline for subsequent
 * calls.
 */
export interface EmbedTextsRequest {
  texts: string[]
}

export interface EmbedTextsResult {
  vectors: number[][]
  /** Fully-qualified model id e.g. `local:Xenova/all-MiniLM-L6-v2`. */
  model: string
}

/* --------------------------- transcribe ops ---------------------------- */

/**
 * Transcribe a clip of 16kHz mono PCM via the local Transformers.js Whisper
 * pipeline. First call downloads ~75 MB of ONNX + tokenizer; subsequent calls
 * reuse the cached pipeline and run in 1-2s per 5s clip on CPU.
 */
export interface TranscribeAudioRequest {
  pcm: Float32Array
  sampleRate: number
}

export interface TranscribeAudioResult {
  text: string
}

/* ----------------------------- wire format ----------------------------- */

export type WorkerOp =
  | 'cosine-search'
  | 'extract-file'
  | 'embed-texts'
  | 'transcribe-audio'
  | 'ping'

export interface WorkerRequest<P = unknown> {
  id: string
  op: WorkerOp
  payload: P
}

export type WorkerResponse<R = unknown> =
  | { id: string; ok: true; result: R }
  | { id: string; ok: false; error: string }

/** workerData passed to the spawned thread so it can locate the DB file. */
export interface WorkerBootData {
  /** Absolute path to the voidsoul-data directory. */
  dataDir: string
}
