/**
 * v2.0 — Settings entry landing.
 *
 * The new first tab under General. Two jobs:
 *   1. Hero CTA for "Unlock everything" — the friction-free power-user
 *      shortcut. Opens UnlockEverythingDialog which spells out exactly
 *      what gets flipped on + a caution note before doing anything.
 *   2. Plain-English orientation card explaining the sidebar layout
 *      so a first-time user knows where to find things instead of
 *      hunting through 7 groups.
 *
 * No business logic of its own — the dialog owns the unlock flow.
 */
import { useState } from 'react'
import {
  ArrowRight,
  Bot,
  Brain,
  Cog,
  MousePointerClick,
  Plug,
  ShieldCheck,
  Sparkles,
  User
} from 'lucide-react'
import { UnlockEverythingDialog } from './UnlockEverythingDialog'

export function SetupLandingPanel(): JSX.Element {
  const [unlockOpen, setUnlockOpen] = useState(false)

  return (
    <div className="space-y-3">
      {/* Hero — Unlock everything */}
      <div className="rounded-xl border border-[var(--accent)]/30 bg-gradient-to-br from-[var(--accent-soft)] to-transparent p-4">
        <div className="mb-2 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Sparkles size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-white">
              Unlock Void & Soul To The Fullest
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-300">
              One click — every capability the assistant has, enabled at once. Permissions,
              proactive voice, screen awareness, wake word, click_on_screen, browser bridge, taskbar
              import, all installed MCP servers and plugins. The friction-free path to the full
              Jarvis experience.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setUnlockOpen(true)}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110"
        >
          <Sparkles size={12} />
          Unlock everything
          <ArrowRight size={11} />
        </button>
        <p className="mt-2 text-[10px] text-slate-400">
          A confirmation screen explains exactly what gets turned on and lists the risks before
          anything happens. You can disable each feature individually later.
        </p>
      </div>

      {/* Orientation — sidebar groups */}
      <div className="rounded-xl border border-white/10 bg-black/20 p-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Where things live
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
          The sidebar groups every setting by what it does. Each group has sub-tabs across the top
          of this pane — click a tab to swap the focused panel. Quick orientation:
        </p>
        <div className="grid grid-cols-1 gap-1.5 text-[11px] text-slate-300">
          <OrientationRow icon={Sparkles} label="General">
            Mode (workflow surface), Persona (custom personalities), Appearance (look + screen
            awareness).
          </OrientationRow>
          <OrientationRow icon={Bot} label="AI">
            Providers + API keys, memory + facts, file knowledge (RAG + vector store), Python
            sandbox, usage and budgets.
          </OrientationRow>
          <OrientationRow icon={MousePointerClick} label="click_on_screen">
            The AI clicks UI elements you describe in plain English. Taught-clicks, the strategy
            picker, and the benchmark harness all live here.
          </OrientationRow>
          <OrientationRow icon={Plug} label="Tools">
            Integrations, Home Assistant, scheduled tasks, MCP servers, plugins, the Chrome browser
            bridge.
          </OrientationRow>
          <OrientationRow icon={ShieldCheck} label="Privacy & Sync">
            What the assistant is allowed to do, the E2E-encrypted vault for cross-device sync, and
            the smoke-test diagnostics.
          </OrientationRow>
          <OrientationRow icon={Brain} label="Voice">
            Pick voices per persona, tone direction, wake-word + proactive nudges in one place.
          </OrientationRow>
          <OrientationRow icon={Cog} label="Advanced">
            System prompt, experimental flags, About.
          </OrientationRow>
          <OrientationRow icon={User} label="Tip">
            The search box at the top of the sidebar searches sub-tab names too — type "ollama" and
            AI surfaces; type "MCP" and Tools surfaces.
          </OrientationRow>
        </div>
      </div>

      {unlockOpen && <UnlockEverythingDialog onClose={() => setUnlockOpen(false)} />}
    </div>
  )
}

function OrientationRow({
  icon: Icon,
  label,
  children
}: {
  icon: typeof Sparkles
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-1.5">
      <Icon size={11} className="mt-0.5 shrink-0 text-[var(--accent)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold text-slate-100">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{children}</p>
      </div>
    </div>
  )
}
