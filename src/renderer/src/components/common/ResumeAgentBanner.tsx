/**
 * Crash-recovery banner. Shows when one or more agent runs were still at
 * `status='running'` in the checkpoint table when the app started — which
 * means the previous session ended uncleanly (crash, force-quit, OS
 * reboot, sleep that the agent loop didn't survive). Each row had its
 * progress persisted on every step, so resuming actually picks up where
 * the loop stopped instead of starting from scratch.
 *
 * Behaviour:
 *   - Banner appears at the top of the panel, above the chat surface.
 *   - One pill per stale checkpoint (most are single-row situations but
 *     a multi-window setup could leave several).
 *   - Each pill exposes Resume + Discard. Resume re-enters the agent
 *     loop in the original thread, drops a "[Resume]" turn, and the
 *     conversation-history breadcrumbs let the model continue.
 *     Discard deletes the row and dismisses.
 *
 * Visual: emerald accent (recoverable, not a hard error). Distinct from
 * the purple FirstRunBanner which signals "missing setup", and from the
 * red error toasts which signal "something broke".
 */
import { useEffect, useState } from 'react'
import { Play, X, RefreshCcw } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useChatStore } from '../../store/useChatStore'
import { vs } from '../../lib/bridge'
import type { AgentCheckpoint } from '@shared/types'

function formatAge(updatedAt: string): string {
  const then = new Date(updatedAt).getTime()
  const now = Date.now()
  const diffSec = Math.max(0, Math.floor((now - then) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

/**
 * Extracts a short, single-line preview of the task the agent was
 * working on. Reads the FIRST user-role turn — that's the original
 * prompt that kicked off the agent loop. Tool-result turns and the
 * synthetic "here is a screenshot" follow-ups are skipped so the
 * preview reads as the actual user intent.
 */
function taskSnippet(checkpoint: { turns?: { role: string; content: string }[] }): string {
  const firstUser = checkpoint.turns?.find(
    (t) => t.role === 'user' && t.content && t.content.length > 4
  )
  if (!firstUser) return 'Untitled task'
  const oneLine = firstUser.content.replace(/\s+/g, ' ').trim()
  return oneLine.length > 70 ? `${oneLine.slice(0, 67)}…` : oneLine
}

function CheckpointPill({ checkpoint }: { checkpoint: AgentCheckpoint }): JSX.Element {
  const removeStale = useUiStore((s) => s.removeStaleCheckpoint)
  const pushToast = useUiStore((s) => s.pushToast)
  const resumeFromCheckpoint = useChatStore((s) => s.resumeFromCheckpoint)
  const [busy, setBusy] = useState(false)

  const onResume = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await resumeFromCheckpoint(checkpoint)
      removeStale(checkpoint.requestId)
    } catch (err) {
      pushToast('error', `Couldn't resume: ${err instanceof Error ? err.message : 'unknown error'}`)
      setBusy(false)
    }
  }

  const onDiscard = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await vs.agentCheckpoint.delete(checkpoint.requestId)
    } catch {
      // Best-effort — the row will be cleaned up on the next 30-day
      // sweep anyway. Removing from UI state is the important part.
    }
    removeStale(checkpoint.requestId)
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-400/30 bg-emerald-500/5 px-2.5 py-1.5">
      <RefreshCcw size={12} className="mt-0.5 flex-none text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-slate-200">{taskSnippet(checkpoint)}</p>
        <p className="truncate text-[10px] text-slate-500">
          step {checkpoint.step} · {checkpoint.modelId} · {formatAge(checkpoint.updatedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onResume()}
        disabled={busy}
        className="flex flex-none items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-40"
      >
        <Play size={9} fill="currentColor" />
        Resume
      </button>
      <button
        type="button"
        onClick={() => void onDiscard()}
        disabled={busy}
        className="flex-none rounded p-0.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200 disabled:opacity-40"
        aria-label="Discard"
      >
        <X size={11} />
      </button>
    </div>
  )
}

export function ResumeAgentBanner(): JSX.Element | null {
  const staleCheckpoints = useUiStore((s) => s.staleCheckpoints)
  const setStaleCheckpoints = useUiStore((s) => s.setStaleCheckpoints)

  // Boot-time fetch — runs once when the banner first mounts. The store
  // holds the result; subsequent removes flow through removeStaleCheckpoint
  // so the banner naturally hides when the list empties.
  useEffect(() => {
    let cancelled = false
    void vs.agentCheckpoint
      .listStale()
      .then((rows) => {
        if (cancelled) return
        setStaleCheckpoints(rows)
      })
      .catch(() => {
        // Best-effort — IPC hiccup on boot just means no recovery banner
        // this session. Failures are logged on the main side.
      })
    return () => {
      cancelled = true
    }
  }, [setStaleCheckpoints])

  if (staleCheckpoints.length === 0) return null

  return (
    <div className="mb-2 space-y-1.5 rounded-lg border border-emerald-400/30 bg-emerald-950/40 p-2">
      <div className="flex items-center gap-1.5">
        <RefreshCcw size={11} className="text-emerald-400" />
        <p className="text-[11px] font-semibold uppercase tracking-widest text-emerald-300">
          {staleCheckpoints.length === 1
            ? '1 task to resume'
            : `${staleCheckpoints.length} tasks to resume`}
        </p>
      </div>
      <div className="space-y-1">
        {staleCheckpoints.map((cp) => (
          <CheckpointPill key={cp.requestId} checkpoint={cp} />
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        These agent runs were still in flight when the app last quit. Resume picks up from the last
        persisted step; the conversation already has the tool-call breadcrumbs so the model knows
        where it left off.
      </p>
    </div>
  )
}
