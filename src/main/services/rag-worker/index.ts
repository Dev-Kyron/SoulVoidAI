/**
 * Main-side proxy for the RAG workers. Two worker threads now run in parallel:
 *
 *   - **`fast`** lane: cosine-search, extract-file, transcribe-audio, ping.
 *     Latency-sensitive (chat RAG queries fire while the user waits; wake-word
 *     fires once per second). Single in-flight queue prevents two callers
 *     from racing the same handle, but ops here are small and complete fast.
 *
 *   - **`slow`** lane: embed-texts. Cold-start downloads ~25 MB of model and
 *     can run for minutes on large batches. Lives in its own worker so a
 *     file-RAG backfill doesn't starve wake-word transcribes for ages.
 *
 * Each lane is independently spawned, crashed, respawned. The same per-op
 * timeout + force-respawn protocol applies to both. Routing is a static table
 * — callers don't choose a lane, the public function signature does.
 *
 * Memory cost of two workers: each lazy-loads its own model (Whisper ~75 MB
 * in fast, MiniLM ~25 MB in slow) only when first used; embedder doesn't
 * load Whisper and vice-versa, so worst-case footprint is roughly the same
 * as the prior single-worker design — just split across two heaps.
 */
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { log } from '../logger'
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
  WorkerOp,
  WorkerRequest,
  WorkerResponse
} from './protocol'

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
  op: WorkerOp
}

type Lane = 'fast' | 'slow'

/**
 * Per-op routing table. `embed-texts` is the only op that has the cold-load
 * + long-running profile that warrants isolation; everything else shares the
 * fast lane (their wall-clock budgets are tight).
 */
const OP_LANE: Record<WorkerOp, Lane> = {
  'cosine-search': 'fast',
  'extract-file': 'fast',
  'transcribe-audio': 'fast',
  'embed-texts': 'slow',
  ping: 'fast'
}

/**
 * Per-op timeout caps. The slow lane's embed-texts retains its generous
 * 180s ceiling because the first call downloads model weights. Whisper has
 * the same generous ceiling for the same reason, but lives on its own lane
 * so an in-flight embed batch can't queue behind it.
 */
const CALL_TIMEOUT_MS: Record<WorkerOp, number> = {
  'cosine-search': 30_000,
  'extract-file': 30_000,
  'embed-texts': 180_000,
  'transcribe-audio': 180_000,
  ping: 5_000
}

interface LaneState {
  name: Lane
  handle: Worker | null
  pending: Map<string, PendingCall>
}

const lanes: Record<Lane, LaneState> = {
  fast: { name: 'fast', handle: null, pending: new Map() },
  slow: { name: 'slow', handle: null, pending: new Map() }
}

/** Rejects every in-flight call on the named lane and clears its map. */
function rejectAllPending(lane: LaneState, reason: Error): void {
  for (const slot of lane.pending.values()) {
    clearTimeout(slot.timer)
    slot.reject(reason)
  }
  lane.pending.clear()
}

/** Resolves the bundled worker script path for both dev and production. */
function workerPath(): string {
  // In production __dirname is `out/main`; in dev `electron-vite` rewrites the
  // import URL so `__dirname` still points at the built location.
  return join(__dirname, 'workers/rag-worker.js')
}

function ensureWorker(lane: LaneState): Worker {
  if (lane.handle) return lane.handle
  const boot: WorkerBootData = {
    dataDir: join(app.getPath('userData'), 'voidsoul-data')
  }
  const worker = new Worker(workerPath(), { workerData: boot })

  worker.on('message', (response: WorkerResponse) => {
    const handler = lane.pending.get(response.id)
    if (!handler) return
    lane.pending.delete(response.id)
    clearTimeout(handler.timer)
    if (response.ok) handler.resolve(response.result)
    else handler.reject(new Error(response.error))
  })

  worker.on('error', (err) => {
    log(
      'error',
      'rag',
      `RAG worker [${lane.name}] crashed; future calls will respawn it`,
      err instanceof Error ? err.message : String(err)
    )
    rejectAllPending(lane, err)
    lane.handle = null
  })

  worker.on('exit', (code) => {
    if (code !== 0) {
      log('warn', 'rag', `RAG worker [${lane.name}] exited with code ${code}`)
    }
    // `error` only fires for thrown exceptions — a clean exit (or a SIGTERM
    // from disposeWorker mid-request) needs its own pending sweep, else
    // those callers wait forever.
    if (lane.pending.size > 0) {
      const reason = new Error(
        code === 0
          ? `RAG worker [${lane.name}] exited`
          : `RAG worker [${lane.name}] exited with code ${code}`
      )
      rejectAllPending(lane, reason)
    }
    lane.handle = null
  })

  lane.handle = worker
  return worker
}

/** Sends a request to the appropriate lane's worker; returns a Promise. */
function call<P, R>(op: WorkerOp, payload: P): Promise<R> {
  const lane = lanes[OP_LANE[op]]
  const worker = ensureWorker(lane)
  const id = randomUUID()
  const request: WorkerRequest<P> = { id, op, payload }
  const timeoutMs = CALL_TIMEOUT_MS[op]
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A hung worker (deadlock in PDF parse, blocked SQL handle, etc.) would
      // otherwise leave callers waiting forever AND keep blocking later calls
      // queued behind it. Reject this slot, then forcibly terminate the
      // worker so the next call spawns a fresh one rather than piling more
      // requests behind a dead handle.
      const slot = lane.pending.get(id)
      if (!slot) return
      lane.pending.delete(id)
      log(
        'warn',
        'rag',
        `RAG worker [${lane.name}] call "${op}" timed out after ${timeoutMs}ms — respawning`
      )
      slot.reject(
        new Error(`RAG worker [${lane.name}] call "${op}" timed out after ${timeoutMs}ms`)
      )
      const handle = lane.handle
      lane.handle = null
      if (handle) {
        void handle.terminate().catch((err) => {
          // Termination failure on Windows occasionally happens if the
          // worker process is already crashed — not catastrophic (the
          // OS will reap the orphan on quit), but worth a trace so
          // we can investigate if it becomes a pattern.
          log(
            'warn',
            'rag',
            `RAG worker [${lane.name}] terminate() rejected after timeout`,
            err instanceof Error ? err.message : String(err)
          )
        })
      }
    }, timeoutMs)
    lane.pending.set(id, {
      resolve: (value) => resolve(value as R),
      reject,
      timer,
      op
    })
    worker.postMessage(request)
  })
}

export function cosineSearch(req: CosineSearchRequest): Promise<CosineSearchHit[]> {
  return call<CosineSearchRequest, CosineSearchHit[]>('cosine-search', req)
}

export function extractFileViaWorker(req: ExtractFileRequest): Promise<ExtractFileResult | null> {
  return call<ExtractFileRequest, ExtractFileResult | null>('extract-file', req)
}

export function embedTextsViaWorker(req: EmbedTextsRequest): Promise<EmbedTextsResult> {
  return call<EmbedTextsRequest, EmbedTextsResult>('embed-texts', req)
}

export function transcribeAudioViaWorker(
  req: TranscribeAudioRequest
): Promise<TranscribeAudioResult> {
  return call<TranscribeAudioRequest, TranscribeAudioResult>('transcribe-audio', req)
}

/** Shuts both workers down (called on app quit). */
export async function disposeWorker(): Promise<void> {
  const handles: Array<{ worker: Worker; name: string }> = []
  for (const [name, lane] of Object.entries(lanes)) {
    if (!lane.handle) continue
    handles.push({ worker: lane.handle, name })
    lane.handle = null
    rejectAllPending(lane, new Error(`RAG worker [${lane.name}] disposed`))
  }
  // allSettled so a single hanging worker can't block quit. Log every
  // termination failure individually so we don't lose the signal.
  const results = await Promise.allSettled(handles.map(({ worker }) => worker.terminate()))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'rejected') {
      log(
        'warn',
        'rag',
        `RAG worker [${handles[i].name}] terminate() rejected on dispose`,
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      )
    }
  }
}
