/**
 * Single Python kernel wrapper. One instance per `PythonKernel.spawn()`
 * call; the parent manager pools them by threadId. Holds the child
 * process, the workspace dir, and the in-flight exec promise so
 * subsequent runCode() calls queue cleanly instead of interleaving.
 *
 * Cancellation: an AbortSignal passed to `runCode` sends SIGINT to the
 * child, which surfaces as KeyboardInterrupt inside the user's code.
 * SIGTERM/kill on .kill() — the kernel can't recover from those.
 *
 * Failure modes covered:
 *   · Python not installed → spawn rejects; manager surfaces friendly hint.
 *   · Code crashes user-side → done event with `error` set; kernel survives.
 *   · Kernel process crashes mid-exec → 'exit' handler rejects the pending
 *     promise so the call site doesn't hang forever.
 *   · Idle for too long → manager calls .kill() (this class doesn't time
 *     itself out; the pool owns lifecycle policy).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../storage/store'
import { log } from '../logger'
import { PYTHON_RUNNER_SOURCE } from './runner'

/**
 * The command used to launch Python. Windows ships `python` (the launcher
 * shim) but no `python3`; everywhere else `python3` is the convention and
 * `python` is often a missing or 2.7-vestigial binary. Exported so the
 * legacy ephemeral run-python path in actions.ts can stay in lockstep
 * without redeclaring the same one-liner.
 */
export const PYTHON_CMD: string = process.platform === 'win32' ? 'python' : 'python3'

export interface KernelExecResult {
  stdout: string
  stderr: string
  /** Traceback when the user code raised; null on success. */
  error: string | null
}

export interface KernelReadyInfo {
  python: string
  executable: string
}

interface PendingExec {
  /** Cell id this pending exec is waiting on. The runner echoes back the
   *  id on its done message; if we see a done with a non-matching id
   *  it's protocol drift (stale done after a previous cell, runner bug)
   *  and we drop it instead of resolving the new exec with the wrong
   *  payload. v2.0 round-3 polish. */
  id: string
  resolve: (result: KernelExecResult) => void
  reject: (err: Error) => void
}

/** Where the shared runner.py script lives on disk. */
let runnerScriptPath: string | null = null

async function ensureRunnerScript(): Promise<string> {
  if (runnerScriptPath) return runnerScriptPath
  // Lives in <userData>/python-runner/runner.py — one file for the whole
  // app, not per-kernel. Re-written on cold start ONLY if the on-disk
  // contents differ from the bundled source, so an unchanged runner
  // doesn't pay the disk I/O on every fresh kernel spawn.
  const dir = dataPath('python-runner')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'runner.py')
  let needsWrite = true
  try {
    const existing = await readFile(file, 'utf-8')
    if (existing === PYTHON_RUNNER_SOURCE) needsWrite = false
  } catch {
    // File missing / unreadable — treat as needs-write rather than
    // probing further. The write below will surface a real failure.
  }
  if (needsWrite) await writeFile(file, PYTHON_RUNNER_SOURCE, 'utf-8')
  runnerScriptPath = file
  return file
}

/**
 * Per-thread workspace directory — survives app restarts (which is the
 * whole point: a user re-opens a thread tomorrow and their CSV is still
 * sitting in the workspace). Cleaned only on thread delete.
 */
export async function workspaceDirFor(threadId: string): Promise<string> {
  const dir = dataPath(`python-workspaces/${threadId}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export class PythonKernel {
  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    readonly workspaceDir: string,
    readonly ready: KernelReadyInfo
  ) {}

  /** Queued exec requests (one in-flight at a time). */
  private pending: PendingExec | null = null
  /**
   * Stdout assembly buffer. Chunks land here as strings and are joined
   * only when a newline arrives — avoids the O(n²) string-concat trap
   * a single 10 MB `print(huge)` would otherwise hit (each new 64 KB
   * chunk would re-copy the growing 10 MB head). For typical small
   * outputs the array stays empty between lines.
   */
  private chunks: string[] = []
  private exited = false
  private nextId = 0

  static async spawn(threadId: string): Promise<PythonKernel> {
    const runner = await ensureRunnerScript()
    const workspaceDir = await workspaceDirFor(threadId)
    // python on Windows, python3 elsewhere — see PYTHON_CMD docstring.
    const child = spawn(PYTHON_CMD, ['-u', runner], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        // Force unbuffered stdio so the runner's emit() lands immediately.
        // -u above does this for stdout; this covers the rare CPython build
        // where -u doesn't fully cover stderr.
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Wait for the runner's "ready" emission (or a spawn failure). 5s
    // ceiling covers the slowest cold starts I've measured on Windows
    // with a sluggish AV scan; longer than that and Python is genuinely
    // not installed and we should surface the error fast.
    const ready = await new Promise<KernelReadyInfo>((resolve, reject) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf-8')
        const newline = buf.indexOf('\n')
        if (newline === -1) return
        const line = buf.slice(0, newline)
        try {
          const msg = JSON.parse(line) as {
            type?: string
            python?: string
            executable?: string
          }
          if (msg.type === 'ready') {
            child.stdout.off('data', onData)
            child.removeListener('error', onError)
            child.removeListener('exit', onExit)
            clearTimeout(timer)
            resolve({
              python: msg.python ?? 'unknown',
              executable: msg.executable ?? 'unknown'
            })
          }
        } catch {
          // Pre-ready garbage on stdout (a pip warning, etc) is harmless;
          // we keep listening for the ready line.
        }
      }
      const onError = (err: Error): void => {
        clearTimeout(timer)
        reject(
          new Error(
            `Failed to launch Python (${PYTHON_CMD}): ${err.message}. Install Python 3.10+ and ensure it's on your PATH.`
          )
        )
      }
      const onExit = (code: number | null): void => {
        clearTimeout(timer)
        reject(
          new Error(
            `Python kernel exited before becoming ready (code=${code}). Install Python 3.10+ and ensure it's on your PATH.`
          )
        )
      }
      const timer = setTimeout(() => {
        child.stdout.off('data', onData)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        reject(new Error(`Python kernel didn't signal ready within 5s.`))
      }, 5000)
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })

    const kernel = new PythonKernel(child, workspaceDir, ready)
    kernel.attachListeners()
    return kernel
  }

  private attachListeners(): void {
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      // Kernel-side stderr (the runner script itself, not user code) is
      // surfaced through the per-exec response; anything that lands here
      // outside that path is genuinely unexpected — log for diagnostics.
      const text = chunk.toString('utf-8').trim()
      if (text) {
        log('warn', 'python', `[kernel stderr] ${text.slice(0, 500)}`)
      }
    })
    this.proc.on('exit', (code) => this.onExit(code))
    this.proc.on('error', (err) => this.onProcessError(err))
  }

  private onStdoutData(chunk: Buffer): void {
    let remaining = chunk.toString('utf-8')
    // Fast path: the chunk contains no newline — just queue it and wait
    // for more. This is the path that used to allocate O(n²) on huge
    // single-line outputs in the v1 string-concat implementation.
    let newlineIdx = remaining.indexOf('\n')
    if (newlineIdx === -1) {
      this.chunks.push(remaining)
      return
    }
    // Drain every complete line in this chunk; each line is joined from
    // accumulated chunks + the segment of `remaining` up to the newline.
    while (newlineIdx !== -1) {
      this.chunks.push(remaining.slice(0, newlineIdx))
      const line = this.chunks.join('')
      this.chunks = []
      remaining = remaining.slice(newlineIdx + 1)
      if (line.trim()) this.handleResponseLine(line)
      newlineIdx = remaining.indexOf('\n')
    }
    if (remaining) this.chunks.push(remaining)
  }

  private handleResponseLine(line: string): void {
    let msg: { type?: string; id?: string; stdout?: string; stderr?: string; error?: string | null }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      // Non-JSON stdout from a misbehaving import (printing on import is
      // an old Python antipattern). Ignore — exec's own stdout is buffered
      // inside the runner and arrives as part of the done event.
      return
    }
    if (msg.type !== 'done') {
      // 'ready' was consumed during spawn(); any other type here is
      // either a future runner extension or a runner bug. Log so a
      // protocol drift doesn't silently swallow events forever.
      log(
        'warn',
        'python',
        `Unexpected message type from runner: ${msg.type ?? '(none)'} — ignored.`
      )
      return
    }
    if (!this.pending) return
    // v2.0 round-3 polish — verify the done message's id matches the
    // pending exec's id. Without this, a stray late 'done' from a
    // previous cell (runner protocol drift, stderr/stdout race, or
    // an aborted exec's belated SIGINT-cancelled emit) would resolve
    // the NEXT runCode call with the PREVIOUS cell's output. Quiet
    // wrong-data return that's nearly invisible to debug.
    if (msg.id && msg.id !== this.pending.id) {
      log(
        'warn',
        'python',
        `Runner emitted done for cell "${msg.id}" but pending is "${this.pending.id}" — dropping stale frame.`
      )
      return
    }
    const result: KernelExecResult = {
      stdout: msg.stdout ?? '',
      stderr: msg.stderr ?? '',
      error: msg.error ?? null
    }
    const pending = this.pending
    this.pending = null
    pending.resolve(result)
  }

  private onExit(code: number | null): void {
    this.exited = true
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.reject(new Error(`Python kernel exited mid-execution (code=${code}).`))
    }
  }

  private onProcessError(err: Error): void {
    this.exited = true
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.reject(err)
    }
  }

  /**
   * Execute one cell of code in the persistent globals. Rejects if the
   * kernel has already exited; resolves with stdout/stderr/error otherwise.
   * Callers should serialise their own calls — this class only holds ONE
   * pending exec at a time (a second concurrent call rejects immediately).
   */
  async runCode(code: string, signal?: AbortSignal): Promise<KernelExecResult> {
    if (this.exited) {
      throw new Error('Python kernel has exited; spawn a new one.')
    }
    if (this.pending) {
      throw new Error('Python kernel is already executing another cell.')
    }
    if (signal?.aborted) {
      throw new Error('Aborted before execution started.')
    }
    const id = `cell-${this.nextId++}`
    const promise = new Promise<KernelExecResult>((resolve, reject) => {
      if (signal) {
        // SIGINT raises KeyboardInterrupt inside the running Python code
        // — the runner catches it and emits a done with error set, so
        // the kernel survives and stays usable for the next cell.
        //
        // SIGINT isn't supported on Windows for arbitrary child
        // processes — fall back to SIGTERM there, which kills the
        // kernel outright. The pool's getOrSpawn will detect the
        // exited kernel and respawn on the next call.
        //
        // { once: true } auto-removes the listener after firing; if
        // the result arrives before any abort, the listener stays
        // attached to the signal and is GC'd whenever the signal is.
        // No manual removal needed — last revision's signalListener
        // cleanup was symmetry theatre over a one-shot listener.
        signal.addEventListener(
          'abort',
          () => {
            try {
              const sig = process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'
              this.proc.kill(sig)
            } catch {
              /* already dead; the exit handler will reject the pending */
            }
          },
          { once: true }
        )
      }
      this.pending = { id, resolve, reject }
    })

    const payload = JSON.stringify({ id, type: 'exec', code }) + '\n'
    try {
      this.proc.stdin.write(payload)
    } catch (err) {
      this.pending = null
      throw err instanceof Error ? err : new Error(String(err))
    }
    return promise
  }

  /** True when the kernel has exited and can no longer run cells. */
  isAlive(): boolean {
    return !this.exited
  }

  /** Graceful shutdown — sends the shutdown request and waits up to 1s
   *  for the process to exit on its own; SIGKILL after that.
   *  The settings UI and the thread-delete hook both call this. */
  async kill(): Promise<void> {
    if (this.exited) return
    try {
      this.proc.stdin.write(JSON.stringify({ id: 'shutdown', type: 'shutdown' }) + '\n')
      this.proc.stdin.end()
    } catch {
      /* ignore — pipe might already be torn down */
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000)
      this.proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    this.exited = true
  }
}

/** Module-level helpers for the manager (exposed for tests). */
export async function workspaceExists(threadId: string): Promise<boolean> {
  try {
    const dir = dataPath(`python-workspaces/${threadId}`)
    const info = await stat(dir)
    return info.isDirectory()
  } catch {
    return false
  }
}
