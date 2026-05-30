/**
 * Per-thread Python kernel pool. The agent's `run_python` tool calls
 * through here whenever a threadId is supplied — the kernel for that
 * thread is spawned on first use, reused across calls, and torn down
 * when the thread is deleted or the kernel goes idle.
 *
 * Pool semantics:
 *   · One kernel per threadId, at most. Concurrent runCode() calls for
 *     the same thread serialise behind the existing in-flight promise
 *     (we never queue beyond one — the agent loop is sequential).
 *   · Idle reaper sweeps every IDLE_CHECK_INTERVAL_MS and kills any
 *     kernel whose last use was > IDLE_TTL_MS ago. The workspace dir
 *     stays — only the kernel process dies. A subsequent call spawns
 *     a fresh kernel against the same dir (variables are lost; files
 *     persist).
 *   · disposeAll() runs at app quit so we don't leak python.exe
 *     subprocesses past the desktop app shutting down.
 *   · disposeForThread(id) deletes the kernel AND the workspace dir,
 *     called from the thread-delete IPC path.
 *
 * Why no per-thread queue of pending exec requests: the agent loop runs
 * tools sequentially within a single turn, so two concurrent run_python
 * calls against the same thread shouldn't happen in normal use. The
 * kernel's own one-pending-at-a-time guard catches the misbehaving case
 * with a clear error instead of silently interleaving cells.
 */
import { rm } from 'node:fs/promises'
import { dataPath } from '../storage/store'
import { log } from '../logger'
import { PythonKernel, type KernelExecResult, type KernelReadyInfo } from './kernel'

const IDLE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
/**
 * v2.0 polish — hard cap on simultaneously-live kernels. Each python.exe
 * holds ~15-25 MB RSS on Windows; a user with 50 active threads who
 * called run_python in every one would otherwise pin 750MB-1.25GB of
 * RAM until the 30-minute idle reaper sweeps. Eight is generous for
 * real chat usage (the user can only see/edit one thread at a time;
 * unused threads queue behind the cap and respawn on next use). The
 * workspace dir always persists; only the in-memory kernel process is
 * evicted, so files generated in a long-tail thread survive the evict.
 */
const MAX_CONCURRENT_KERNELS = 8

interface PoolEntry {
  kernel: PythonKernel
  lastUsedAt: number
  /** Promise that resolved when the kernel finished spawning. Held so a
   *  second concurrent getOrSpawn for the same thread awaits the same
   *  spawn instead of racing to start two kernels. */
  spawnPromise: Promise<PythonKernel>
}

const pool = new Map<string, PoolEntry>()
let idleTimer: ReturnType<typeof setInterval> | null = null

/** Public snapshot for the Settings panel. */
export interface KernelStatus {
  threadId: string
  python: string
  executable: string
  workspaceDir: string
  lastUsedAt: string
  alive: boolean
}

export function listActiveKernels(): KernelStatus[] {
  const out: KernelStatus[] = []
  for (const [threadId, entry] of pool) {
    out.push({
      threadId,
      python: entry.kernel.ready.python,
      executable: entry.kernel.ready.executable,
      workspaceDir: entry.kernel.workspaceDir,
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      alive: entry.kernel.isAlive()
    })
  }
  return out
}

/**
 * Returns the kernel for a thread, spawning if needed. Two concurrent
 * callers see the same spawnPromise and end up sharing one kernel.
 */
async function getOrSpawn(threadId: string): Promise<PythonKernel> {
  const existing = pool.get(threadId)
  if (existing) {
    // v2.0 polish — `kernel` is filled with a placeholder until the
    // spawn promise resolves (so concurrent callers can await the same
    // spawnPromise). Calling .isAlive() on the placeholder throws
    // TypeError. Await the promise first; only THEN can we ask if it's
    // alive. Without this, two concurrent run_python calls during the
    // spawn window crash the second one with "Cannot read properties
    // of undefined".
    if (existing.kernel === undefined) {
      existing.lastUsedAt = Date.now()
      return existing.spawnPromise
    }
    if (existing.kernel.isAlive()) {
      existing.lastUsedAt = Date.now()
      return existing.spawnPromise
    }
    // The kernel died (idle-reaped, user killed it, crashed). Fall
    // through to spawn a fresh one.
    pool.delete(threadId)
  }
  // v2.0 polish — bound the pool. If we're at the cap and we'd be
  // adding a NEW thread (not just resurrecting a dead entry above),
  // evict the least-recently-used kernel first. Workspace dir stays;
  // only the python.exe process dies — same semantics as the idle
  // reaper, just triggered by pressure instead of time. The eviction
  // runs fire-and-forget so the new kernel spawn doesn't wait on the
  // evictee's exit handshake.
  if (pool.size >= MAX_CONCURRENT_KERNELS) {
    let oldestId: string | null = null
    let oldestAt = Infinity
    for (const [id, entry] of pool) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt
        oldestId = id
      }
    }
    if (oldestId) {
      const evicted = pool.get(oldestId)
      pool.delete(oldestId)
      log(
        'info',
        'python',
        `Kernel pool at cap (${MAX_CONCURRENT_KERNELS}); evicting LRU thread ${oldestId} for ${threadId}.`
      )
      void evicted?.kernel
        .kill()
        .catch((err) =>
          log(
            'warn',
            'python',
            `LRU-evicted kernel kill failed for thread ${oldestId}`,
            err instanceof Error ? err.message : String(err)
          )
        )
    }
  }
  ensureIdleReaper()
  const spawnPromise = PythonKernel.spawn(threadId).catch((err) => {
    // Don't leave a half-installed entry on failure.
    pool.delete(threadId)
    throw err
  })
  pool.set(threadId, {
    kernel: undefined as unknown as PythonKernel,
    lastUsedAt: Date.now(),
    spawnPromise
  })
  const kernel = await spawnPromise
  // Patch the entry now that the kernel ref is real (the placeholder
  // above lets concurrent callers await the same promise without us
  // having to await it ourselves to populate the map).
  const entry = pool.get(threadId)
  if (entry) entry.kernel = kernel
  log(
    'info',
    'python',
    `Spawned Python kernel for thread ${threadId} (python ${kernel.ready.python}, cwd ${kernel.workspaceDir}).`
  )
  return kernel
}

/**
 * Public entry point: execute one code cell against the named thread's
 * kernel. Spawns the kernel if needed. Returns the runner result; the
 * caller maps it to the ActionResult shape.
 */
export async function execInThread(
  threadId: string,
  code: string,
  signal?: AbortSignal
): Promise<KernelExecResult & { ready: KernelReadyInfo; workspaceDir: string }> {
  const kernel = await getOrSpawn(threadId)
  const entry = pool.get(threadId)
  if (entry) entry.lastUsedAt = Date.now()
  const result = await kernel.runCode(code, signal)
  if (entry) entry.lastUsedAt = Date.now()
  return {
    ...result,
    ready: kernel.ready,
    workspaceDir: kernel.workspaceDir
  }
}

/**
 * Kill the kernel for a thread + delete its workspace dir. Called from
 * the thread-delete IPC handler. Safe to call when no kernel exists.
 */
export async function disposeForThread(threadId: string): Promise<void> {
  const entry = pool.get(threadId)
  if (entry) {
    pool.delete(threadId)
    try {
      await entry.kernel.kill()
    } catch (err) {
      log(
        'warn',
        'python',
        `Kernel for thread ${threadId} didn't exit cleanly`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  // Always attempt the workspace cleanup — a thread might have had a
  // workspace dir from a previous kernel that's no longer in the pool.
  const dir = dataPath(`python-workspaces/${threadId}`)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    log(
      'warn',
      'python',
      `Couldn't remove workspace dir for thread ${threadId}`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * Kill just the kernel for a thread (keep the workspace dir). Used by
 * the Settings panel's "Restart kernel" button — clears variables but
 * preserves files the user generated.
 */
export async function restartForThread(threadId: string): Promise<void> {
  const entry = pool.get(threadId)
  if (!entry) return
  // v2.0 polish — await kill BEFORE deleting the pool entry. The previous
  // order (delete → await kill) meant a concurrent execInThread/getOrSpawn
  // for the same threadId saw an empty pool and spawned a fresh kernel
  // against the still-living workspace dir; on Windows the second spawn
  // could fail trying to write runner.py while the first kernel had it
  // open. Hold the slot until the old kernel is gone.
  try {
    await entry.kernel.kill()
  } catch {
    /* swallow — pool entry still cleaned below */
  }
  pool.delete(threadId)
}

/** Tear down every kernel + stop the reaper. Called at app quit. */
export async function disposeAll(): Promise<void> {
  stopIdleReaper()
  const entries = Array.from(pool.values())
  pool.clear()
  await Promise.all(
    entries.map((entry) =>
      entry.kernel
        .kill()
        .catch((err) =>
          log(
            'warn',
            'python',
            'Kernel kill on shutdown failed',
            err instanceof Error ? err.message : String(err)
          )
        )
    )
  )
}

function ensureIdleReaper(): void {
  if (idleTimer) return
  idleTimer = setInterval(reapIdle, IDLE_CHECK_INTERVAL_MS)
  // Don't keep the event loop alive just for the reaper.
  idleTimer.unref?.()
}

function stopIdleReaper(): void {
  if (!idleTimer) return
  clearInterval(idleTimer)
  idleTimer = null
}

function reapIdle(): void {
  const cutoff = Date.now() - IDLE_TTL_MS
  for (const [threadId, entry] of pool) {
    if (entry.lastUsedAt > cutoff) continue
    pool.delete(threadId)
    void entry.kernel
      .kill()
      .catch((err) =>
        log(
          'warn',
          'python',
          `Idle kernel kill failed for thread ${threadId}`,
          err instanceof Error ? err.message : String(err)
        )
      )
    log('info', 'python', `Reaped idle Python kernel for thread ${threadId}.`)
  }
  // Reaper has nothing to watch anymore — sleep until the next spawn
  // restarts it. Saves one timer firing every 5 minutes for the rest
  // of an idle session.
  if (pool.size === 0) stopIdleReaper()
}
