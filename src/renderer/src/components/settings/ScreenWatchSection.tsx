/**
 * v1.7 — Settings UI for the screen-watch loop.
 *
 * Lives inside the Voice tab as a sibling CollapsibleSection. Surfaces
 * the master toggle, interval, active hours, daily call cap, plus a
 * live status panel (calls today / last observation / what Soul
 * decided last). A "Test now" button forces a one-off tick so the
 * user can sanity-check the loop without waiting up to N minutes.
 *
 * Privacy + cost banner: when the active provider is a CLOUD provider,
 * an amber warning surfaces above the controls. Local providers
 * (Ollama / LM Studio) get a green "stays on your machine" badge.
 *
 * Permission: this UI shows a yellow "Permission needed" state when
 * screenCapture isn't granted — toggling Enabled while ungranted
 * prompts the user to grant via the existing permission flow.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Lock, ShieldCheck, Sparkles } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { Toggle } from '../common/ui'
import { relativeTime } from '../../lib/utils'
import type { ProviderId, ScreenWatchStatus } from '@shared/types'

// Local providers run on the user's machine — screenshots never leave.
// Kept in sync with main's LOCAL_PROVIDER_IDS in `services/ai/types.ts`.
const LOCAL_PROVIDER_IDS = new Set<ProviderId>(['ollama', 'lmstudio', 'llamacpp'])

export function ScreenWatchSectionBody(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)
  const [status, setStatus] = useState<ScreenWatchStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await vs.screenWatch.status()
      setStatus(s)
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Re-pull every 60s so "Calls today" + "Last observation" stay live
    // while the user is sitting on the Settings panel.
    const id = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (!config) return null

  const cfg = config.screenWatch
  const provider = config.providers.find((p) => p.id === config.activeProvider)
  const isCloud = !LOCAL_PROVIDER_IDS.has(config.activeProvider)
  const hasScreenCapture = config.permissions.screenCapture?.granted === true

  const patch = async (next: Partial<typeof cfg>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await useConfigStore.getState().setScreenWatch(next)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const handleEnable = async (next: boolean): Promise<void> => {
    if (next && !hasScreenCapture) {
      const granted = await useUiStore
        .getState()
        .promptPermission('screenCapture', 'Screen watch')
      if (!granted) {
        pushToast('info', 'Screen-capture permission is needed for screen watch.')
        return
      }
      await useConfigStore.getState().setPermission('screenCapture', true)
    }
    await patch({ enabled: next })
    pushToast(
      'success',
      next
        ? `Screen watch armed — Soul checks in every ${cfg.intervalMinutes} min during active hours.`
        : 'Screen watch off.'
    )
  }

  const handleTestNow = async (): Promise<void> => {
    setTesting(true)
    try {
      const s = await vs.screenWatch.observeNow()
      setStatus(s)
      pushToast(
        s.lastSpoke ? 'success' : 'info',
        s.lastSpoke
          ? 'Soul spoke — see status below.'
          : `Soul stayed silent: ${s.lastReason ?? 'no useful observation'}`
      )
    } catch (err) {
      pushToast(
        'error',
        err instanceof Error ? `Test failed: ${err.message}` : 'Test failed.'
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
        Soul takes a low-resolution screenshot every few minutes and asks your
        AI provider whether there's anything genuinely worth saying. She stays
        silent most of the time — only speaks when she notices something
        useful (stuck on a stack trace, blocked dialog, drifting attention).
      </p>

      {/* Privacy / cost banner — adapts to whether the active provider is
       *  cloud (sends screenshots out) or local (stays on the machine). */}
      {isCloud ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Cloud provider: {provider?.label ?? '—'}</p>
            <p className="mt-0.5 text-[10px] text-amber-300/80">
              Every observation sends a screenshot to {provider?.label ?? 'your provider'}.
              Costs tokens. Switch to Ollama / LM Studio with a vision model
              (llava etc) for free + private operation.
            </p>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
          <ShieldCheck size={12} className="mt-0.5 shrink-0" />
          <p>
            Local provider: <span className="font-semibold">{provider?.label}</span> —
            screenshots stay on your machine. Make sure your model supports vision
            (llava / bakllava / moondream).
          </p>
        </div>
      )}

      {/* Permission requirement — only renders when ungranted */}
      {!hasScreenCapture && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-300">
          <Lock size={12} className="mt-0.5 shrink-0 text-slate-500" />
          <p>
            Screen-capture permission isn't granted yet. Toggling Enabled below
            will prompt for it.
          </p>
        </div>
      )}

      {/* Master enable */}
      <div className="mb-2 flex items-center justify-between rounded-lg border border-white/5 bg-black/20 px-2.5 py-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-200">Enabled</p>
          <p className="text-[10px] text-slate-500">
            Off = no ticks fire. Ships off by default.
          </p>
        </div>
        <Toggle checked={cfg.enabled} onChange={(v) => void handleEnable(v)} />
      </div>

      {/* Interval */}
      <div className="my-2 py-1">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] text-slate-400">Interval (minutes)</label>
          <span className="text-[10px] text-slate-500">every {cfg.intervalMinutes} min</span>
        </div>
        <input
          type="range"
          min={2}
          max={60}
          step={1}
          value={cfg.intervalMinutes}
          onChange={(e) => void patch({ intervalMinutes: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </div>

      {/* Active hours */}
      <div className="my-2 flex gap-3">
        <div className="flex-1">
          <label className="mb-1 block text-[10px] text-slate-400">Active from</label>
          <input
            type="time"
            value={cfg.activeFrom ?? ''}
            onChange={(e) => void patch({ activeFrom: e.target.value || null })}
            className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-[10px] text-slate-400">to</label>
          <input
            type="time"
            value={cfg.activeTo ?? ''}
            onChange={(e) => void patch({ activeTo: e.target.value || null })}
            className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
          />
        </div>
      </div>

      {/* Daily cap */}
      <div className="my-2 py-1">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] text-slate-400">Daily call cap</label>
          <span className="text-[10px] text-slate-500">
            stops after {cfg.dailyCap} ticks/day
          </span>
        </div>
        <input
          type="range"
          min={4}
          max={200}
          step={4}
          value={cfg.dailyCap}
          onChange={(e) => void patch({ dailyCap: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </div>

      {/* Status panel + Test button */}
      <div className="my-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <Sparkles size={10} className="text-[var(--accent)]" /> Status
          </p>
          <button
            type="button"
            onClick={() => void handleTestNow()}
            disabled={testing || !cfg.enabled}
            className="flex items-center gap-1 rounded-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/15 disabled:opacity-50"
          >
            {testing ? <Loader2 size={10} className="animate-spin" /> : null}
            Test now
          </button>
        </div>
        {status ? (
          <div className="space-y-0.5 text-[10px] text-slate-400">
            <p>
              Calls today:{' '}
              <span className="text-slate-200">
                {status.callsToday} / {status.dailyCap}
              </span>
            </p>
            <p>
              Last observation:{' '}
              <span className="text-slate-200">
                {status.lastObservationAt
                  ? relativeTime(status.lastObservationAt)
                  : 'never'}
              </span>
            </p>
            {status.lastReason && (
              <p className="italic text-slate-500">
                Soul {status.lastSpoke ? 'spoke' : 'stayed silent'}: {status.lastReason}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[10px] italic text-slate-500">Loading…</p>
        )}
      </div>
    </>
  )
}
