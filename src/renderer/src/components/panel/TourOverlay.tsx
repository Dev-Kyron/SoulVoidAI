/**
 * First-boot onboarding. Two phases, shown once until the user finishes or
 * skips (tracked by the `onboarded` config flag):
 *
 *  1. **Setup** — pick a workflow mode and the Nexus layout style.
 *  2. **Try these** — an interactive checklist. Each task ticks itself off
 *     when the user actually performs the action (sends a message, opens
 *     settings, presses Cmd+F). Replaces the previous slideshow tour,
 *     which only advanced via a Next button and didn't prove the user
 *     understood anything.
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Sparkles,
  Radar,
  CheckCircle2,
  MessageSquare,
  Settings as SettingsIcon,
  Search,
  Mic,
  Code,
  Clapperboard,
  Radio,
  Microscope,
  PenLine,
  Target,
  LayoutGrid,
  type LucideIcon
} from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { MODES } from '@shared/modes'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { WELCOME_MESSAGE_ID, type ModeId, type NexusStyle } from '@shared/types'

const MODE_ICONS: Record<ModeId, LucideIcon> = {
  'indie-dev': Code,
  creator: Clapperboard,
  streamer: Radio,
  researcher: Microscope,
  writer: PenLine,
  productivity: Target
}

const STYLE_OPTIONS: Array<{ id: NexusStyle; name: string; desc: string; icon: LucideIcon }> = [
  { id: 'simple', name: 'Simple', desc: 'A clean, phone-style app launcher.', icon: LayoutGrid },
  { id: 'advanced', name: 'Advanced', desc: 'The full radial HUD with live telemetry.', icon: Radar }
]

/** localStorage key for the in-progress "try these" checklist state. */
const ONBOARDING_PROGRESS_KEY = 'voidsoul:onboarding-progress'

interface TryTask {
  id: 'send' | 'settings' | 'search' | 'mic'
  icon: LucideIcon
  title: string
  body: string
  action: { label: string; run: () => void | Promise<void> }
}

/** The setup menu — pick a workflow mode and the Nexus layout style. */
function SetupScreen(): JSX.Element {
  const config = useConfigStore((s) => s.config)
  const setActiveMode = useConfigStore((s) => s.setActiveMode)
  const setAppearance = useConfigStore((s) => s.setAppearance)
  const activeMode = config?.activeMode
  const nexusStyle = config?.appearance.nexusStyle

  const cardClass = (selected: boolean): string =>
    cn(
      'flex flex-col gap-1 rounded-xl border p-2.5 text-left transition',
      selected
        ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
        : 'border-white/10 hover:bg-white/5'
    )

  return (
    <>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
        <Sparkles size={24} />
      </div>
      <h3 className="font-display text-base font-semibold text-white">Set up VoidSoul</h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
        Pick a workflow and a look to start with. You can change both any time in Settings.
      </p>

      <p className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        Workflow mode
      </p>
      <div className="grid grid-cols-2 gap-2">
        {MODES.map((mode) => {
          const Icon = MODE_ICONS[mode.id]
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => {
                void setActiveMode(mode.id)
                void setAppearance({ accent: mode.accent })
              }}
              className={cardClass(mode.id === activeMode)}
            >
              <Icon size={16} className="text-[var(--accent)]" />
              <span className="text-[11px] font-semibold text-white">{mode.name}</span>
              <span className="text-[9px] text-slate-400">{mode.tagline}</span>
            </button>
          )
        })}
      </div>

      <p className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        Nexus style
      </p>
      <div className="grid grid-cols-2 gap-2">
        {STYLE_OPTIONS.map((opt) => {
          const Icon = opt.icon
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => void setAppearance({ nexusStyle: opt.id })}
              className={cardClass(opt.id === nexusStyle)}
            >
              <Icon size={16} className="text-[var(--accent)]" />
              <span className="text-[11px] font-semibold text-white">{opt.name}</span>
              <span className="text-[9px] leading-snug text-slate-400">{opt.desc}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/**
 * Interactive "try these" panel — completes each task by observing real
 * user state. No Next button required: send a message and the task ticks
 * itself; press Cmd+F and the next one ticks. The user finishes the tour
 * by actually using the app, not by mashing Next.
 */
function TryThesePanel({ onDone }: { onDone: () => void }): JSX.Element {
  // Subscribe to the bits of state each task watches. Cheap selectors —
  // each is a single value-equality check.
  const messageCount = useChatStore((s) =>
    s.messages.filter((m) => m.role === 'user' && m.id !== WELCOME_MESSAGE_ID).length
  )
  const globalSearchOpen = useUiStore((s) => s.globalSearchOpen)
  const voiceStatus = useVoiceInputStore((s) => s.status)

  // Locally remember which tasks have been ticked off — derived from state
  // when possible but persisted in localStorage so the user doesn't see the
  // checklist reset if they reopen the panel before clicking "Done".
  const [completed, setCompleted] = useState<Record<string, boolean>>(() => {
    try {
      const stored = window.localStorage.getItem(ONBOARDING_PROGRESS_KEY)
      return stored ? (JSON.parse(stored) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  // Track which action *buttons* the user has pressed — separate from the
  // outcome-driven flags below. Pressing "Open mic" should tick the task
  // even if the mic permission is later denied; otherwise the checklist
  // would feel broken to a user who definitely tried but got blocked at
  // the OS layer.
  const [settingsOpened, setSettingsOpened] = useState(false)
  const [micAttempted, setMicAttempted] = useState(false)

  const tasks: TryTask[] = useMemo(
    () => [
      {
        id: 'send',
        icon: MessageSquare,
        title: 'Send your first message',
        body: 'Type a question — try "Summarise what you can do" — and hit Enter.',
        action: {
          label: 'Focus composer',
          run: () => {
            const el = document.querySelector<HTMLTextAreaElement>(
              'textarea[placeholder]'
            )
            el?.focus()
          }
        }
      },
      {
        id: 'search',
        icon: Search,
        title: 'Search across all chats',
        body: 'Press Cmd/Ctrl + F any time to find a previous answer.',
        action: {
          label: 'Open search',
          run: () => useUiStore.getState().setGlobalSearchOpen(true)
        }
      },
      {
        id: 'mic',
        icon: Mic,
        title: 'Talk to it',
        body: 'Tap the mic to ask out loud — VoidSoul replies as Void or Soul.',
        action: {
          label: 'Open mic',
          run: () => {
            setMicAttempted(true)
            void useVoiceInputStore.getState().toggle()
          }
        }
      },
      {
        id: 'settings',
        icon: SettingsIcon,
        title: 'Make it yours',
        body: 'Open Settings to switch model, theme, language, accent, voice…',
        action: {
          label: 'Open Settings',
          run: () => {
            setSettingsOpened(true)
            void vs.window.openSettings()
          }
        }
      }
    ],
    []
  )

  // Tick tasks off as real state crosses each threshold. Only persist when
  // the map actually changed so we don't write to localStorage on every
  // streaming token (which would keep firing this effect via messageCount).
  // Mic ticks on either outcome (recording started) OR intent (button
  // pressed) so a denied OS permission doesn't strand the user.
  useEffect(() => {
    setCompleted((prev) => {
      const next = { ...prev }
      if (messageCount > 0) next.send = true
      if (globalSearchOpen) next.search = true
      if (voiceStatus !== 'idle' || micAttempted) next.mic = true
      if (settingsOpened) next.settings = true
      const changed =
        next.send !== prev.send ||
        next.search !== prev.search ||
        next.mic !== prev.mic ||
        next.settings !== prev.settings
      if (!changed) return prev
      try {
        window.localStorage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify(next))
      } catch {
        /* private mode etc. — non-fatal */
      }
      return next
    })
  }, [messageCount, globalSearchOpen, voiceStatus, micAttempted, settingsOpened])

  const doneCount = tasks.filter((t) => completed[t.id]).length
  const allDone = doneCount === tasks.length

  return (
    <div className="p-5">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
        <Sparkles size={24} />
      </div>
      <h3 className="font-display text-base font-semibold text-white">Try these</h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
        A guided tour, one action at a time. Each item ticks itself when you actually try it.
      </p>
      <div className="mt-4 space-y-2">
        {tasks.map((task) => {
          const Icon = task.icon
          const done = completed[task.id] ?? false
          return (
            <div
              key={task.id}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-2.5 transition',
                done
                  ? 'border-emerald-400/30 bg-emerald-500/5'
                  : 'border-white/10 hover:bg-white/5'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                  done
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                )}
              >
                {done ? <CheckCircle2 size={14} /> : <Icon size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[11.5px] font-semibold',
                    done ? 'text-emerald-200/80 line-through' : 'text-white'
                  )}
                >
                  {task.title}
                </p>
                <p className="text-[10px] leading-snug text-slate-400">{task.body}</p>
              </div>
              {!done && (
                <button
                  type="button"
                  onClick={() => void task.action.run()}
                  className="rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-200 transition hover:bg-white/5 hover:text-white"
                >
                  {task.action.label}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all"
            style={{ width: `${(doneCount / tasks.length) * 100}%` }}
          />
        </div>
        <span className="text-[9px] tabular-nums text-slate-500">
          {doneCount}/{tasks.length}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onDone}
          className="text-[11px] text-slate-400 transition hover:text-white"
        >
          Skip rest
        </button>
        <button
          type="button"
          onClick={onDone}
          className={cn(
            'rounded-lg px-4 py-1.5 text-[11px] font-semibold transition',
            allDone
              ? 'bg-[var(--accent)] text-white hover:brightness-110'
              : 'border border-white/10 text-slate-300 hover:bg-white/5'
          )}
        >
          {allDone ? 'All done' : "I'm good"}
        </button>
      </div>
    </div>
  )
}

export function TourOverlay(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setOnboarded = useConfigStore((s) => s.setOnboarded)
  const [phase, setPhase] = useState<'setup' | 'try'>('setup')

  // Render only once config is loaded and onboarding has not happened.
  if (!config || config.onboarded !== false) return null

  const finish = (): void => {
    try {
      window.localStorage.removeItem(ONBOARDING_PROGRESS_KEY)
    } catch {
      /* non-fatal */
    }
    void setOnboarded(true)
  }

  return (
    <motion.div
      className={cn(
        'absolute inset-0 flex items-center justify-center p-5',
        // Z-layer per phase: setup is fully modal and sits above other
        // overlays (z-80, above QuickAI z-65 and GlobalSearch z-70); the
        // 'try' phase is non-blocking and slips below them so a user
        // popping Quick AI or Cmd+F mid-tour sees those on top of the
        // corner card. The wrapper passes clicks through outside the card.
        phase === 'setup'
          ? 'z-[80] bg-black/80'
          : 'pointer-events-none z-[55] items-end justify-end'
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <AnimatePresence mode="wait">
        {phase === 'setup' ? (
          <motion.div
            key="setup"
            className="glass pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <div className="scrollbar-void overflow-y-auto p-5">
              <SetupScreen />
            </div>
            <div className="flex items-center justify-between border-t border-white/10 px-5 py-3">
              <button
                type="button"
                onClick={finish}
                className="text-[11px] text-slate-400 transition hover:text-white"
              >
                Skip setup
              </button>
              <button
                type="button"
                onClick={() => setPhase('try')}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
              >
                Continue
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="try"
            className="glass pointer-events-auto m-3 w-[340px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            <TryThesePanel onDone={finish} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
