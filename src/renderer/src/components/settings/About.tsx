/**
 * The About section. Shows version + platform info, the auto-updater
 * state with a manual "check for updates" / "restart to install" affordance,
 * lets the user open the data folder where VoidSoul keeps its SQLite DB /
 * JSON stores, and links out to GitHub for issues and source code.
 */
import { useEffect, useState } from 'react'
import {
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  Heart,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Star
} from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import type { AppInfo } from '@shared/bridge'
import type { UpdaterStatus } from '@shared/types'

const REPO_URL = 'https://github.com/Dev-Kyron/SoulVoidAI'
const ISSUES_URL = 'https://github.com/Dev-Kyron/SoulVoidAI/issues/new'
const PRIVACY_URL = 'https://github.com/Dev-Kyron/SoulVoidAI/blob/main/PRIVACY.md'
const TERMS_URL = 'https://github.com/Dev-Kyron/SoulVoidAI/blob/main/TERMS.md'

export function About(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void vs.system.info().then(setInfo)
  }, [])

  const openUrl = (url: string): void => {
    void vs.automation.execute({ type: 'open-url', params: { url } })
  }
  return (
    <CollapsibleSection
      title="About"
      hint="App version, where VoidSoul keeps your local data, and how to send feedback."
    >
      <div className="glass-soft overflow-hidden rounded-lg">
        {/* Hero with the orb-style accent gradient — feels intentional vs
            the previous bare-text presentation. */}
        <div className="flex items-center gap-3 border-b border-white/5 bg-gradient-to-br from-[var(--accent-soft)] to-transparent px-3 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-glow">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-[13px] font-semibold text-white">
              VoidSoul Assistant
            </p>
            <p className="text-[10px] text-slate-400">
              v{info?.version ?? '—'} · Electron {info?.electron ?? '—'} · {info?.platform ?? '—'}
            </p>
          </div>
        </div>

        {/* Updater row — its own block under the hero so the user can see
           at a glance whether they're on the latest. */}
        <UpdaterRow />

        {/* Action row — a real "what can I do with this About section" set */}
        <div className="grid grid-cols-2 gap-1.5 p-2.5">
          <ActionButton
            icon={<Star size={12} />}
            label="Leave a review"
            onClick={() => useUiStore.getState().setReviewDialogOpen(true)}
            hint="Star rating + a note — sent privately to the studio."
          />
          <ActionButton
            icon={<Search size={12} />}
            label="Re-run setup"
            onClick={() => useUiStore.getState().setSetupDiscoveryOpen(true)}
            hint="Re-scan this machine for AI tools you've configured elsewhere."
          />
          <ActionButton
            icon={<Heart size={12} />}
            label="Report an issue"
            onClick={() => openUrl(ISSUES_URL)}
            external
            hint="Bug, feature request, weird behaviour."
          />
          <ActionButton
            icon={<FolderOpen size={12} />}
            label="Open data folder"
            onClick={() => void vs.system.openDataFolder()}
            hint="SQLite DB, JSON stores, model cache."
          />
          <ActionButton
            icon={<Github size={12} />}
            label="View source"
            onClick={() => openUrl(REPO_URL)}
            external
            hint="Source available on GitHub for transparency."
          />
          <ActionButton
            icon={<ShieldCheck size={12} />}
            label="Privacy policy"
            onClick={() => openUrl(PRIVACY_URL)}
            external
            hint="What we collect (nothing) and what stays local."
          />
          <ActionButton
            icon={<FileText size={12} />}
            label="Terms of service"
            onClick={() => openUrl(TERMS_URL)}
            external
            hint="Licence, acceptable use, no-warranty."
          />
        </div>

        <div className="border-t border-white/5 px-3 py-2.5 text-[10px] leading-relaxed text-slate-500">
          Local-first. API keys are encrypted with your OS keychain and never leave this machine.
          Chat history, embeddings, and indexed files live in the data folder above — back it up
          if you care about it.
        </div>
      </div>
    </CollapsibleSection>
  )
}

/**
 * Live binding to the main-process updater. Renders a single-row summary
 * with the current state, a "check now" button, and a "restart to install"
 * button when a download is queued.
 */
function UpdaterRow(): JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)
  const pushToast = useUiStore((s) => s.pushToast)

  // Pull the initial snapshot (the updater service has been running since
  // boot and may have already determined "not available") and subscribe to
  // future transitions so the row stays live.
  useEffect(() => {
    void vs.updater.status().then(setStatus)
    return vs.events.onUpdaterStatus(setStatus)
  }, [])

  const handleCheck = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    try {
      const next = await vs.updater.check()
      // Toast only on the "nothing new" terminal state — every other state
      // produces ongoing UI in the row itself so a second toast would noise.
      if (next.kind === 'not-available') {
        pushToast('info', "You're on the latest version.")
      } else if (next.kind === 'error') {
        pushToast('error', `Update check failed — ${next.message}`)
      }
    } finally {
      setChecking(false)
    }
  }

  const handleRestart = (): void => {
    void vs.updater.quitAndInstall()
  }

  const { label, tone, action } = describeStatus(status, handleRestart)

  return (
    <div className="flex items-center gap-2.5 border-b border-white/5 px-3 py-2">
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          tone === 'ok' && 'bg-emerald-500/15 text-emerald-300',
          tone === 'info' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
          tone === 'warn' && 'bg-amber-500/15 text-amber-300'
        )}
      >
        <Download size={12} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold text-slate-200">{label}</p>
        {status.kind === 'downloading' && (
          <p className="text-[10px] text-slate-500">{status.percent}% downloaded</p>
        )}
        {status.kind === 'available' && (
          <p className="text-[10px] text-slate-500">Downloading in the background…</p>
        )}
        {status.kind === 'error' && (
          <p className="text-[10px] text-rose-300/80">{status.message}</p>
        )}
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[10px] font-semibold text-white transition hover:brightness-110"
        >
          {action.label}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleCheck()}
          disabled={checking}
          title="Check for updates"
          aria-label="Check for updates"
          className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={10} className={checking ? 'animate-spin' : undefined} />
          {checking ? 'Checking' : 'Check'}
        </button>
      )}
    </div>
  )
}

/** Maps the wire status into label + visual tone + an optional action. */
function describeStatus(
  status: UpdaterStatus,
  onRestart: () => void
): { label: string; tone: 'ok' | 'info' | 'warn'; action: { label: string; onClick: () => void } | null } {
  switch (status.kind) {
    case 'idle':
      return { label: 'Checking for updates…', tone: 'info', action: null }
    case 'checking':
      return { label: 'Checking for updates…', tone: 'info', action: null }
    case 'not-available':
      return { label: "You're on the latest version.", tone: 'ok', action: null }
    case 'available':
      return { label: `Update available — v${status.version}`, tone: 'info', action: null }
    case 'downloading':
      return { label: `Downloading update… ${status.percent}%`, tone: 'info', action: null }
    case 'downloaded':
      return {
        label: `Update ready — v${status.version}`,
        tone: 'warn',
        action: { label: 'Restart & install', onClick: onRestart }
      }
    case 'error':
      return { label: 'Update check failed.', tone: 'warn', action: null }
  }
}

function ActionButton({
  icon,
  label,
  hint,
  onClick,
  external
}: {
  icon: JSX.Element
  label: string
  hint: string
  onClick: () => void
  external?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-label={label}
      className="group flex flex-col gap-0.5 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-left transition hover:border-[var(--accent-ring)] hover:bg-white/5"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
        {icon}
        {label}
        {external && (
          <ExternalLink size={9} className="ml-auto text-slate-500 group-hover:text-slate-300" />
        )}
      </span>
      <span className="text-[9px] text-slate-500">{hint}</span>
    </button>
  )
}
