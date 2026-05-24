/**
 * Full-window root for the dedicated Settings window. Loaded by main.tsx
 * when the renderer is opened with `?view=settings`. Lays out a sidebar of
 * grouped sections on the left and a roomy scrolling pane on the right —
 * the same individual settings panels the floating widget used to host
 * inline, just given the room to actually breathe.
 *
 * Each settings panel is lazy-loaded so switching groups is the unit that
 * pulls its chunk, not opening the window itself.
 */
import { Suspense, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Cpu,
  Lock,
  Mic,
  Plug,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  X,
  type LucideIcon
} from 'lucide-react'
import { useConfigStore } from './store/useConfigStore'
import { useMemoryStore } from './store/useMemoryStore'
import { usePluginStore } from './store/usePluginStore'
import { vs } from './lib/bridge'
import { cn, lazyNamed } from './lib/utils'
import { useAccentTheme, useConfigBroadcastSync } from './lib/useConfigBridge'
import { useWakeBroadcastSync } from './lib/wakeBridge'
import { useTheme } from './lib/useTheme'
import { useGlobalSearchHotkey } from './lib/useGlobalSearchHotkey'
import { Overlays } from './components/panel/Overlays'
import { SetupDiscoveryPanel } from './components/setup/SetupDiscoveryPanel'

/* Lazy panels — each loads only when its group is first opened. */
const ModeSettings = lazyNamed(() => import('./components/settings/ModeSettings'), 'ModeSettings')
const AppearanceSettings = lazyNamed(
  () => import('./components/settings/AppearanceSettings'),
  'AppearanceSettings'
)
const VoiceSettings = lazyNamed(
  () => import('./components/settings/VoiceSettings'),
  'VoiceSettings'
)
const ProviderSettings = lazyNamed(
  () => import('./components/settings/ProviderSettings'),
  'ProviderSettings'
)
const MemorySettings = lazyNamed(
  () => import('./components/settings/MemorySettings'),
  'MemorySettings'
)
const FilesRagSettings = lazyNamed(
  () => import('./components/settings/FilesRagSettings'),
  'FilesRagSettings'
)
const UsageSettings = lazyNamed(
  () => import('./components/settings/UsageSettings'),
  'UsageSettings'
)
const IntegrationSettings = lazyNamed(
  () => import('./components/settings/IntegrationSettings'),
  'IntegrationSettings'
)
const ScheduledTasks = lazyNamed(
  () => import('./components/settings/ScheduledTasks'),
  'ScheduledTasks'
)
const McpSettings = lazyNamed(() => import('./components/settings/McpSettings'), 'McpSettings')
const PluginSettings = lazyNamed(
  () => import('./components/settings/PluginSettings'),
  'PluginSettings'
)
const PermissionsManager = lazyNamed(
  () => import('./components/settings/PermissionsManager'),
  'PermissionsManager'
)
const ExperimentalSettings = lazyNamed(
  () => import('./components/settings/ExperimentalSettings'),
  'ExperimentalSettings'
)
const SyncSettings = lazyNamed(
  () => import('./components/settings/SyncSettings'),
  'SyncSettings'
)
const SystemPromptEditor = lazyNamed(
  () => import('./components/settings/SystemPromptEditor'),
  'SystemPromptEditor'
)
const About = lazyNamed(() => import('./components/settings/About'), 'About')

/* ------------------------------- groups ------------------------------- */

type GroupId = 'general' | 'voice' | 'ai' | 'tools' | 'advanced'

interface SectionGroup {
  id: GroupId
  label: string
  description: string
  icon: LucideIcon
  /** The active section's title (shown in the breadcrumb header). */
  render: () => JSX.Element
}

const GROUPS: SectionGroup[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Mode and appearance — the everyday surface.',
    icon: Sparkles,
    render: () => (
      <>
        <ModeSettings />
        <AppearanceSettings />
      </>
    )
  },
  {
    id: 'voice',
    label: 'Voice',
    // Voice picker, tone direction, proactive nudges, wake word — all
    // the things that make Soul speak (and listen). Split out of General
    // in v1.5 because the voice surface grew past one tab's worth.
    description: 'Voices, tone direction, proactive nudges, wake word.',
    icon: Mic,
    render: () => <VoiceSettings />
  },
  {
    id: 'ai',
    label: 'AI',
    description: 'Providers, memory, file knowledge, cost tracking.',
    icon: Cpu,
    render: () => (
      <>
        <ProviderSettings />
        <MemorySettings />
        <FilesRagSettings />
        <UsageSettings />
      </>
    )
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Integrations, scheduled prompts, MCP servers, plugins.',
    icon: Plug,
    render: () => (
      <>
        <IntegrationSettings />
        <ScheduledTasks />
        <McpSettings />
        <PluginSettings />
      </>
    )
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Permissions, sync, system prompt, experimental, about.',
    icon: Lock,
    render: () => (
      <>
        <PermissionsManager />
        <ExperimentalSettings />
        <SyncSettings />
        <SystemPromptEditor />
        <About />
      </>
    )
  }
]

/* ------------------------------- root ------------------------------- */

function Sidebar({
  active,
  onPick
}: {
  active: GroupId
  onPick: (id: GroupId) => void
}): JSX.Element {
  // Quick filter — 16 settings panels grouped into 4 buckets means scanning
  // the sidebar for "wake word" or "scheduled tasks" gets old fast. The
  // filter matches group labels AND each group's panel hints, so a search
  // for "ollama" finds the AI Provider group via its description.
  const [filter, setFilter] = useState('')
  const lowered = filter.trim().toLowerCase()
  const filtered = lowered
    ? GROUPS.filter(
        (g) =>
          g.label.toLowerCase().includes(lowered) ||
          g.description.toLowerCase().includes(lowered)
      )
    : GROUPS
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-white/5 bg-black/30">
      {/*
        Drag region — paired with the header's drag strip on the right pane,
        the whole top edge of the Settings window is grabbable. Without a
        native title bar this is how users move the window.
      */}
      <div className="drag flex items-center gap-2 px-4 pb-3 pt-5">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">
          <SettingsIcon size={14} />
        </span>
        <div>
          <p className="text-[12px] font-semibold text-white">Settings</p>
          <p className="text-[10px] text-slate-500">VoidSoul AI Companion</p>
        </div>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            size={10}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search settings…"
            className="w-full rounded-md border border-white/5 bg-black/40 py-1 pl-7 pr-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-[var(--accent-ring)]"
            aria-label="Filter settings sections"
          />
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {filtered.map((group) => {
          const Icon = group.icon
          const isActive = group.id === active
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => onPick(group.id)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                isActive
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
              )}
            >
              <Icon size={13} />
              <span className="text-[12px] font-medium">{group.label}</span>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="px-2.5 py-2 text-[11px] text-slate-500">No matches.</p>
        )}
      </nav>
      <div className="mt-auto px-4 py-4 text-[10px] leading-relaxed text-slate-500">
        <p>API keys are encrypted with your OS keychain and never leave this machine.</p>
      </div>
    </aside>
  )
}

function ContentSkeleton(): JSX.Element {
  return (
    <div className="flex h-40 items-center justify-center text-[11px] text-slate-500">
      <span className="animate-pulse">Loading…</span>
    </div>
  )
}

export function SettingsRoot(): JSX.Element {
  const load = useConfigStore((s) => s.load)
  const ready = useConfigStore((s) => s.ready)
  const accent = useConfigStore((s) => s.config?.appearance.accent)
  const loadMemory = useMemoryStore((s) => s.load)
  const loadPlugins = usePluginStore((s) => s.load)
  // Persist the last-opened group in localStorage so re-opening Settings
  // lands the user back where they were instead of always at General.
  // Falls back to 'general' if the stored value isn't a known group id.
  const [active, setActiveRaw] = useState<GroupId>(() => {
    if (typeof window === 'undefined') return 'general'
    const stored = window.localStorage.getItem('voidsoul:settings-last-group')
    if (stored && GROUPS.some((g) => g.id === stored)) return stored as GroupId
    return 'general'
  })
  const setActive = (next: GroupId): void => {
    setActiveRaw(next)
    try {
      window.localStorage.setItem('voidsoul:settings-last-group', next)
    } catch {
      /* private-mode storage quotas etc — non-fatal */
    }
  }

  // Independent window — boot the same stores the main app relies on.
  useEffect(() => {
    void load()
    void loadMemory()
    void loadPlugins()
  }, [load, loadMemory, loadPlugins])

  useConfigBroadcastSync()
  // Cross-window WAKE sync — when the user clicks "Arm now" in this
  // window, the main panel must receive it so useWakeWord boots the
  // engine. Without this, clicking Arm here flips the local store but
  // the main panel never knows, engine stays dormant, Scans=0.
  useWakeBroadcastSync()
  useAccentTheme(accent)
  useTheme()
  // Cmd/Ctrl+F here closes the Settings window and pops the global search
  // back in the main window. The dialog itself can't live here because
  // `useChatStore` is a separate per-window instance — clicking a result
  // would switch a chat store nothing renders. See useGlobalSearchHotkey.
  useGlobalSearchHotkey('settings')

  // Esc closes — Cmd/Ctrl+W is already handled by Electron for framed windows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void vs.window.closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const current = useMemo(() => GROUPS.find((g) => g.id === active) ?? GROUPS[0], [active])

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-void-700 text-[11px] text-slate-400">
        <span className="animate-pulse">Loading settings…</span>
      </div>
    )
  }

  return (
    <div className="relative flex h-screen w-screen bg-void-700 text-slate-200">
      <Sidebar active={active} onPick={setActive} />
      <main className="flex min-w-0 flex-1 flex-col">
        {/*
          The whole header is the drag region — there's no OS title bar to
          grab anymore, so this strip is how users move the window. The
          right padding (`pr-36`) keeps the in-app close button (and any
          future header controls) clear of the native min/max/close
          overlay that Electron paints in the top-right corner via
          `titleBarOverlay`. The close button itself opts back out of
          dragging via `-webkit-app-region: no-drag` so clicks register.
        */}
        <header className="drag flex items-center justify-between border-b border-white/5 px-6 pb-3 pr-36 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
              {current.label}
            </p>
            <p className="mt-0.5 text-[14px] font-semibold text-white">{current.description}</p>
          </div>
          <button
            type="button"
            onClick={() => void vs.window.closeSettings()}
            title="Close (Esc)"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X size={15} />
          </button>
        </header>
        <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="mx-auto w-full max-w-[640px]"
            >
              <Suspense fallback={<ContentSkeleton />}>
                <SettingsGroupIcon icon={current.icon} />
                {current.render()}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      {/* Toasts + the permission prompt dialog. Without this, a setting
          that triggers a confirm (e.g. wake-word asking for mic) would set
          store state with nothing to render against. */}
      <Overlays />
      {/* Setup-discovery panel — opened from About → "Re-run setup"; the
          Settings window's useUiStore is independent of the main window's,
          so opening it here doesn't fight with first-launch on main. */}
      <SetupDiscoveryPanel />
    </div>
  )
}

function SettingsGroupIcon({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return (
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
      <Icon size={20} />
    </div>
  )
}

