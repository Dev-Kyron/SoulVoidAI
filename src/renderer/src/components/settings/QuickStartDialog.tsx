/**
 * v1.12.0 — MCP Quick Start onboarding dialog.
 *
 * Closes the friction gap a first-time non-tech user hits when they open
 * the marketplace and see 100+ entries. Quick Start collapses the choice
 * into "pick a workflow" → bulk-install every zero-config curated server
 * that matches. They land with 5–8 working tools in one click instead of
 * playing matching-game between entries and their config requirements.
 *
 * UX state machine:
 *   picking  ← profile cards visible. Each shows tagline + server count.
 *      ↓ (click a profile card)
 *   confirming ← shows the actual list of servers about to install, with
 *                back button + "Install N servers" action. Last off-ramp
 *                before anything hits the disk.
 *      ↓ (click Install)
 *   installing ← per-server status list updates as Promise.allSettled
 *                resolves each install. Servers already present get
 *                'skipped' status without re-trying.
 *      ↓ (all settled)
 *   done ← summary with success/skipped/failed counts + Close.
 *
 * Why Promise.allSettled instead of sequential: `vs.mcp.add` returns once
 * the config is persisted; npx process spawn happens async server-side.
 * Adding 8 servers in parallel costs ~one round-trip total, not eight.
 * If one server's add throws, the others keep going.
 *
 * Why we bypass `useMcpStore.add` and call `vs.mcp.add` directly: the
 * store's add() reloads the full server list after each call (necessary
 * for duplicate-tools flag recomputation). Eight parallel adds would do
 * eight redundant reloads racing against each other. We reload ONCE at
 * the end via `useMcpStore.getState().load()`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, Loader2, Rocket, Sparkles, X, AlertTriangle } from 'lucide-react'
import { useMcpStore } from '../../store/useMcpStore'
import { useUiStore } from '../../store/useUiStore'
import { useDialog } from '../../lib/useDialog'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import {
  QUICK_START_PROFILES,
  resolveProfileEntries,
  type QuickStartProfile
} from '../../lib/mcpQuickStart'
import type { McpRegistryEntry } from '@shared/types'

interface QuickStartDialogProps {
  open: boolean
  onClose: () => void
  /** Loaded marketplace entries — passed in so we don't double-fetch from
   *  the parent. The parent already paid the network cost; reuse it. */
  entries: McpRegistryEntry[]
}

type Phase = 'picking' | 'confirming' | 'installing' | 'done'

/** Per-server install result tracked through the installing → done phases.
 *  'pending' is the placeholder before the install promise settles; the
 *  three terminal states map to the icon + colour shown in the list. */
type InstallStatus = 'pending' | 'installing' | 'done' | 'skipped' | 'failed'
interface InstallRow {
  entry: McpRegistryEntry
  status: InstallStatus
  error?: string
}

export function QuickStartDialog({
  open,
  onClose,
  entries
}: QuickStartDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)
  const servers = useMcpStore((s) => s.servers)
  const installedNames = useMemo(
    () => new Set(servers.map((s) => s.name)),
    [servers]
  )
  const [phase, setPhase] = useState<Phase>('picking')
  const [profile, setProfile] = useState<QuickStartProfile | null>(null)
  const [rows, setRows] = useState<InstallRow[]>([])

  // Reset on every open so a closed-then-reopened dialog doesn't show the
  // previous run's "done" summary. Cleanup also resets so a quick close
  // mid-install doesn't leave stale rows in state.
  useEffect(() => {
    if (!open) return
    setPhase('picking')
    setProfile(null)
    setRows([])
  }, [open])

  const pickedEntries = useMemo(
    () => (profile ? resolveProfileEntries(profile, entries) : []),
    [profile, entries]
  )

  const startInstall = async (chosen: QuickStartProfile): Promise<void> => {
    const list = resolveProfileEntries(chosen, entries)
    // Seed rows in pending state so the UI doesn't flash empty before the
    // first promise resolves. Already-installed entries skip the IPC.
    const initial: InstallRow[] = list.map((entry) => ({
      entry,
      status: installedNames.has(entry.name) ? 'skipped' : 'pending'
    }))
    setRows(initial)
    setPhase('installing')

    // Run installs in parallel via allSettled — one bad apple shouldn't
    // abort the rest. Track results by entry id so the row update is
    // order-independent. Note: we flip 'pending' → 'installing' just-in-
    // time so the spinner shows for the duration of each promise.
    const promises = initial.map(async (row) => {
      if (row.status === 'skipped') return row
      // Flip to 'installing' for this row.
      setRows((prev) =>
        prev.map((r) => (r.entry.id === row.entry.id ? { ...r, status: 'installing' } : r))
      )
      try {
        await vs.mcp.add({
          name: row.entry.name,
          command: row.entry.command,
          args: row.entry.args,
          env: row.entry.env
        })
        const done: InstallRow = { ...row, status: 'done' }
        setRows((prev) => prev.map((r) => (r.entry.id === row.entry.id ? done : r)))
        return done
      } catch (err) {
        const failed: InstallRow = {
          ...row,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err)
        }
        setRows((prev) => prev.map((r) => (r.entry.id === row.entry.id ? failed : r)))
        return failed
      }
    })
    await Promise.allSettled(promises)
    // Single reload at the end so the cross-server duplicate-tools flag
    // is recomputed once with the full new state, not eight times racing.
    await useMcpStore.getState().load()
    setPhase('done')
  }

  const summary = useMemo(() => {
    const done = rows.filter((r) => r.status === 'done').length
    const skipped = rows.filter((r) => r.status === 'skipped').length
    const failed = rows.filter((r) => r.status === 'failed').length
    return { done, skipped, failed }
  }, [rows])

  const handleClose = (): void => {
    // If the user closes mid-install, the surviving in-flight installs
    // still resolve in the background — vs.mcp.add can't be cancelled
    // and abandoning them would leave half-written config. Toast the
    // total so they know what landed.
    if (phase === 'installing') {
      useUiStore
        .getState()
        .pushToast('info', 'Quick Start running in background — check Settings → MCP shortly.')
    } else if (phase === 'done' && summary.done > 0) {
      useUiStore
        .getState()
        .pushToast(
          'success',
          `Quick Start installed ${summary.done} server${summary.done === 1 ? '' : 's'}.`
        )
    }
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="MCP Quick Start"
            className="glass flex h-[min(640px,90vh)] w-[min(560px,95vw)] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — title + close. The icon (rocket) is the same on all
              * phases so the user has a consistent "this is the Quick Start
              * dialog" anchor as the inner content swaps. */}
            <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
              <Rocket size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                {phase === 'done' ? 'Quick Start complete' : 'Quick Start setup'}
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="text-slate-400 transition hover:text-white"
              >
                <X size={15} />
              </button>
            </div>

            {phase === 'picking' && (
              <PickingView entries={entries} onPick={(p) => { setProfile(p); setPhase('confirming') }} />
            )}

            {phase === 'confirming' && profile && (
              <ConfirmingView
                profile={profile}
                entries={pickedEntries}
                installedNames={installedNames}
                onBack={() => setPhase('picking')}
                onConfirm={() => void startInstall(profile)}
              />
            )}

            {(phase === 'installing' || phase === 'done') && (
              <InstallingView
                rows={rows}
                phase={phase}
                summary={summary}
                onClose={handleClose}
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ----------------------- picking — workflow cards ----------------------- */

function PickingView({
  entries,
  onPick
}: {
  entries: McpRegistryEntry[]
  onPick: (profile: QuickStartProfile) => void
}): JSX.Element {
  return (
    <div className="scrollbar-void flex-1 overflow-y-auto px-5 py-4">
      {/* Heads-up panel — single screen explanation so we don't burn a
        * whole step on "are you sure". Confirmation step still gates the
        * actual install with the full server list. */}
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
        <p className="leading-snug">
          Pick a workflow to bulk-install several MCP servers at once. Each one adds tools
          the AI can use — file access, web fetching, memory, etc. None of these need API
          keys or credentials. You can remove any later from Settings → MCP.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {QUICK_START_PROFILES.map((profile) => {
          const list = resolveProfileEntries(profile, entries)
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => onPick(profile)}
              disabled={list.length === 0}
              className={cn(
                'glass-soft group flex flex-col items-start gap-1 rounded-lg p-3 text-left transition',
                list.length === 0
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:border-[var(--accent-ring)] hover:bg-white/5'
              )}
            >
              <div className="flex w-full items-center gap-1.5">
                <Sparkles size={11} className="text-[var(--accent)]" />
                <p className="flex-1 text-[12px] font-semibold text-white">{profile.name}</p>
                <span className="rounded-full bg-white/10 px-1.5 text-[9px] font-mono text-slate-300">
                  {list.length}
                </span>
              </div>
              <p className="text-[10px] font-medium text-slate-300">{profile.tagline}</p>
              <p className="text-[10px] leading-snug text-slate-500">{profile.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ----------------------- confirming — server list ----------------------- */

function ConfirmingView({
  profile,
  entries,
  installedNames,
  onBack,
  onConfirm
}: {
  profile: QuickStartProfile
  entries: McpRegistryEntry[]
  installedNames: Set<string>
  onBack: () => void
  onConfirm: () => void
}): JSX.Element {
  const toInstall = entries.filter((e) => !installedNames.has(e.name))
  const alreadyInstalled = entries.length - toInstall.length

  return (
    <>
      <div className="scrollbar-void flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-3">
          <p className="text-[11px] font-semibold text-white">{profile.name}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{profile.description}</p>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-200">
            None of this profile&apos;s servers are available in the current marketplace fetch.
            Refresh the marketplace and try again.
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map((entry) => {
              const skip = installedNames.has(entry.name)
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'glass-soft flex items-start gap-2 rounded-lg px-2.5 py-1.5',
                    skip && 'opacity-60'
                  )}
                >
                  <div className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {skip ? (
                      <Check size={11} className="text-emerald-400" />
                    ) : (
                      <Sparkles size={9} className="text-[var(--accent)]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-white">{entry.name}</p>
                    <p className="text-[10px] leading-snug text-slate-400">{entry.description}</p>
                  </div>
                  {skip && (
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 text-[9px] text-emerald-300">
                      already installed
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <p className="mt-3 text-[10px] leading-snug text-slate-500">
          Each server runs as a local process when its tools are invoked. Nothing connects
          to remote services except where the server itself needs to (e.g., Cloudflare API).
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-white/10 px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft size={11} />
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={toInstall.length === 0}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Rocket size={11} />
          {toInstall.length === 0
            ? 'Nothing to install'
            : `Install ${toInstall.length} server${toInstall.length === 1 ? '' : 's'}`}
          {alreadyInstalled > 0 && (
            <span className="ml-1 rounded-full bg-white/15 px-1.5 text-[9px] font-normal">
              {alreadyInstalled} skipped
            </span>
          )}
        </button>
      </div>
    </>
  )
}

/* ----------------------- installing / done — progress ------------------- */

function InstallingView({
  rows,
  phase,
  summary,
  onClose
}: {
  rows: InstallRow[]
  phase: 'installing' | 'done'
  summary: { done: number; skipped: number; failed: number }
  onClose: () => void
}): JSX.Element {
  return (
    <>
      <div className="scrollbar-void flex-1 overflow-y-auto px-5 py-4">
        {phase === 'installing' && (
          <p className="mb-3 flex items-center gap-1.5 text-[11px] text-slate-300">
            <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
            Installing {rows.filter((r) => r.status !== 'skipped').length} servers…
          </p>
        )}
        {phase === 'done' && (
          <p className="mb-3 text-[11px] text-slate-300">
            Installed <span className="font-semibold text-emerald-300">{summary.done}</span>
            {summary.skipped > 0 && (
              <>
                , skipped <span className="font-semibold text-slate-300">{summary.skipped}</span>
              </>
            )}
            {summary.failed > 0 && (
              <>
                , failed <span className="font-semibold text-rose-300">{summary.failed}</span>
              </>
            )}
            .
          </p>
        )}

        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={row.entry.id}
              className="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-1.5"
            >
              <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                {row.status === 'done' && <Check size={12} className="text-emerald-400" />}
                {row.status === 'skipped' && <Check size={12} className="text-slate-400" />}
                {row.status === 'failed' && (
                  <AlertTriangle size={12} className="text-rose-400" />
                )}
                {row.status === 'installing' && (
                  <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
                )}
                {row.status === 'pending' && (
                  <div className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-white">{row.entry.name}</p>
                {row.error && (
                  <p className="text-[10px] leading-snug text-rose-300">{row.error}</p>
                )}
                {row.status === 'skipped' && (
                  <p className="text-[10px] leading-snug text-slate-500">
                    already installed — left as-is
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={phase === 'installing'}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'installing' ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              Working…
            </>
          ) : (
            <>
              <Check size={11} />
              Done
            </>
          )}
        </button>
      </div>
    </>
  )
}
