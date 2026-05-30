/**
 * Settings panel for the per-thread persistent Python sandbox (v2.0).
 *
 * Each chat thread that calls `run_python` gets its own long-lived Python
 * process — variables / imports / generated files survive across turns
 * (Jupyter-style). This panel surfaces what's currently running so the
 * user can see why their disk has python.exe processes, restart a kernel
 * to clear variables, or dispose one entirely (kernel + workspace dir
 * both gone) for a thread they've moved on from.
 *
 * Idle reaper in the manager kills kernels after 30 minutes of no use,
 * so this list is usually short. The "no kernels yet" empty state is
 * what most users will see most of the time — that's correct.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCcw, Terminal, Trash2 } from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { useChatStore } from '../../store/useChatStore'
import type { PythonKernelStatus } from '@shared/types'

export function PythonSandboxSettings(): JSX.Element {
  const [kernels, setKernels] = useState<PythonKernelStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const pushToast = useUiStore((s) => s.pushToast)
  const threads = useChatStore((s) => s.threads)

  const refresh = useCallback(() => {
    void vs.pythonSandbox.list().then(setKernels)
  }, [])

  useEffect(() => {
    refresh()
    // Light auto-refresh — kernels come and go via idle reaper or chat
    // activity in a thread the user isn't currently looking at. 10s is
    // slow enough to be free, fresh enough that the panel never feels
    // stale when you open it after a long chat.
    const handle = window.setInterval(refresh, 10_000)
    return () => window.clearInterval(handle)
  }, [refresh])

  // Resolve threadId → human title; falls back to the raw id when the
  // thread was deleted but a kernel briefly outlived it (rare race).
  const titleFor = (threadId: string): string => {
    const thread = threads.find((t) => t.id === threadId)
    return thread?.title?.trim() || `Thread ${threadId.slice(0, 8)}`
  }

  const handleRestart = async (threadId: string): Promise<void> => {
    setBusy(threadId)
    try {
      await vs.pythonSandbox.restart(threadId)
      pushToast('info', 'Kernel restarted — variables cleared, files in the workspace preserved.')
      refresh()
    } catch (err) {
      pushToast('error', `Restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleDispose = async (threadId: string): Promise<void> => {
    setBusy(threadId)
    try {
      await vs.pythonSandbox.dispose(threadId)
      pushToast('info', 'Kernel and workspace removed.')
      refresh()
    } catch (err) {
      pushToast('error', `Dispose failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <CollapsibleSection
      title="Python Sandbox"
      hint="One Python kernel per chat thread. Variables, imports, and files persist across turns within the same thread (Jupyter-style)."
    >
      <div className="space-y-2">
        {kernels === null ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-slate-500">
            <Loader2 size={11} className="animate-spin" />
            Loading kernels…
          </div>
        ) : kernels.length === 0 ? (
          <p className="px-2.5 py-1.5 text-[11px] text-slate-500">
            No active Python kernels. One spawns on demand the first time a thread calls{' '}
            <code className="rounded bg-white/5 px-1 font-mono text-[10px]">run_python</code> and
            reaps itself after 30 minutes idle.
          </p>
        ) : (
          <div className="space-y-1.5">
            {kernels.map((kernel) => (
              <div
                key={kernel.threadId}
                className="glass-soft flex items-start gap-2 rounded-lg p-2.5"
              >
                <Terminal size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-slate-100">
                    {titleFor(kernel.threadId)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    Python {kernel.python} ·{' '}
                    <span title={kernel.executable}>
                      {kernel.executable.split(/[\\/]/).slice(-1)[0]}
                    </span>{' '}
                    · last used{' '}
                    {new Date(kernel.lastUsedAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </p>
                  <p
                    className="mt-0.5 truncate font-mono text-[9px] text-slate-500"
                    title={kernel.workspaceDir}
                  >
                    {kernel.workspaceDir}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => void handleRestart(kernel.threadId)}
                    disabled={busy === kernel.threadId}
                    title="Restart — clears variables, keeps the workspace files"
                    aria-label={`Restart Python kernel for thread ${kernel.threadId}`}
                    aria-busy={busy === kernel.threadId || undefined}
                    className="rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
                  >
                    {busy === kernel.threadId ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCcw size={12} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDispose(kernel.threadId)}
                    disabled={busy === kernel.threadId}
                    title="Dispose — kills the kernel AND deletes the workspace dir"
                    aria-label={`Dispose Python kernel and workspace for thread ${kernel.threadId}`}
                    className="rounded-md p-1 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-snug text-slate-500">
          Requires Python 3.10+ on PATH. Private-mode threads fall back to ephemeral execution (no
          on-disk workspace, no persistent state).
        </p>
      </div>
    </CollapsibleSection>
  )
}
