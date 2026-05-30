/**
 * Full-window root for the dedicated Settings window. Loaded by main.tsx
 * when the renderer is opened with `?view=settings`.
 *
 * v2.0 revamp — moved from "sidebar group → wall of stacked panels" to
 * "sidebar group → sub-tab → single panel". The AI / Tools / Advanced
 * groups each used to stack 5-6 panels vertically, which overflowed
 * and forced endless scrolling. Now each group has horizontal segment
 * navigation across the top of the content pane; clicking a sub-tab
 * swaps a single focused panel into view.
 *
 * Each panel is lazy-loaded so changing sub-tabs is the unit that
 * pulls a chunk, not opening the window.
 */
import { Suspense, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  Bot,
  Brain,
  Cog,
  CreditCard,
  Cpu,
  FileText,
  GitBranch,
  Globe,
  Home,
  Info,
  Languages,
  Layers,
  Lock,
  Mic,
  MousePointerClick,
  Network,
  Plug,
  Puzzle,
  Rocket,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  Type,
  User,
  Wand2,
  X,
  type LucideIcon
} from 'lucide-react'
import { useConfigStore } from './store/useConfigStore'
import { useMemoryStore } from './store/useMemoryStore'
import { usePluginStore } from './store/usePluginStore'
import { useUiStore } from './store/useUiStore'
import { vs } from './lib/bridge'
import { cn, lazyNamed } from './lib/utils'
import { useAccentTheme, useConfigBroadcastSync } from './lib/useConfigBridge'
import { useWakeBroadcastSync } from './lib/wakeBridge'
import { useTheme } from './lib/useTheme'
import { useGlobalSearchHotkey } from './lib/useGlobalSearchHotkey'
import { Overlays } from './components/panel/Overlays'
import { SetupDiscoveryPanel } from './components/setup/SetupDiscoveryPanel'

/* ------------------------- lazy panel imports ------------------------- */

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
const VectorStoreSettings = lazyNamed(
  () => import('./components/settings/VectorStoreSettings'),
  'VectorStoreSettings'
)
const PythonSandboxSettings = lazyNamed(
  () => import('./components/settings/PythonSandboxSettings'),
  'PythonSandboxSettings'
)
const PersonaSettings = lazyNamed(
  () => import('./components/settings/PersonaSettings'),
  'PersonaSettings'
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
const BrowserExtensionSettings = lazyNamed(
  () => import('./components/settings/BrowserExtensionSettings'),
  'BrowserExtensionSettings'
)
const HomeAssistantSettings = lazyNamed(
  () => import('./components/settings/HomeAssistantSettings'),
  'HomeAssistantSettings'
)
const PermissionsManager = lazyNamed(
  () => import('./components/settings/PermissionsManager'),
  'PermissionsManager'
)
const SmokeTestPanel = lazyNamed(
  () => import('./components/settings/SmokeTestPanel'),
  'SmokeTestPanel'
)
const ExperimentalSettings = lazyNamed(
  () => import('./components/settings/ExperimentalSettings'),
  'ExperimentalSettings'
)
const SyncSettings = lazyNamed(() => import('./components/settings/SyncSettings'), 'SyncSettings')
const SystemPromptEditor = lazyNamed(
  () => import('./components/settings/SystemPromptEditor'),
  'SystemPromptEditor'
)
const About = lazyNamed(() => import('./components/settings/About'), 'About')
const SetupLandingPanel = lazyNamed(
  () => import('./components/settings/SetupLandingPanel'),
  'SetupLandingPanel'
)

/* ------------------------------- groups ------------------------------- */

type GroupId = 'general' | 'voice' | 'ai' | 'click' | 'tools' | 'privacy' | 'advanced'

interface SectionItem {
  id: string
  label: string
  icon: LucideIcon
  /** Short one-liner shown under the breadcrumb in the header. */
  hint?: string
  /** v2.0 — paragraph-level orientation. Rendered as a card under the
   *  section icon to explain what this surface is, when to use it, and
   *  any non-obvious gotchas. Helps a first-time user get oriented
   *  without hunting through the panel itself. */
  intro?: string
  render: () => JSX.Element
}

interface SectionGroup {
  id: GroupId
  label: string
  description: string
  icon: LucideIcon
  sections: SectionItem[]
}

const GROUPS: SectionGroup[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Setup landing, mode, persona, appearance — the everyday surface.',
    icon: Sparkles,
    sections: [
      {
        id: 'setup',
        label: 'Setup',
        icon: Rocket,
        hint: 'One-click unlock + orientation card for first-time users.',
        intro:
          "Start here. The Unlock card flips every capability on in one action — permissions, screen awareness, click_on_screen, wake word, browser bridge, plugins. The orientation card below maps each sidebar group so you know where to drill in. Skip the Mode picker if you don't care which workflow surface you start on — the AI works the same regardless.",
        render: () => <SetupLandingPanel />
      },
      {
        id: 'mode',
        label: 'Mode',
        icon: Wand2,
        hint: 'Switch the workflow surface — indie dev, creator, researcher, productivity.',
        intro:
          "Modes change WHICH quick-actions show on the Nexus tab and WHICH system-prompt fragment gets appended — they don't change what the AI can do, just what it's primed for. Pick the one that matches what you're doing right now (you can switch any time, including per-thread). Custom modes layer on via the Persona panel.",
        render: () => <ModeSettings />
      },
      {
        id: 'persona',
        label: 'Persona',
        icon: User,
        hint: 'Custom personalities — system prompt, voice, sample prompts as bundles.',
        intro:
          'Personas are sharable bundles: a system prompt + a recommended provider/model + a default voice + a few sample prompts. Apply one to a thread and it overrides the global mode for that conversation. Export as a `.voidsoul-persona.json` file to share with someone else or import via drag-and-drop.',
        render: () => <PersonaSettings />
      },
      {
        id: 'appearance',
        label: 'Appearance',
        icon: Languages,
        hint: 'Accent, theme, language, screen-awareness, DND, startup behaviour.',
        intro:
          "Cosmetic + behavioural toggles that affect how the app looks and how aggressively it engages with you. Screen awareness shares the focused window's title with the AI; semantic awareness goes further and OCRs the screen on every window change (local, no API cost). DND mutes voice replies and dims the orb during a daily quiet window.",
        render: () => <AppearanceSettings />
      }
    ]
  },
  {
    id: 'voice',
    label: 'Voice',
    description: 'Pick voices, tone direction, wake word, proactive nudges.',
    icon: Mic,
    sections: [
      {
        id: 'voice',
        label: 'Voice',
        icon: Mic,
        hint: 'Per-persona voice picker, wake word, proactive nudges, tone direction.',
        intro:
          "Pick which Piper voice each persona uses, fine-tune the rate and volume, arm the wake-word listener (Whisper local or Picovoice cloud), and turn proactive voice on so Soul can speak unprompted when watch tasks fire. Read-aloud reads assistant replies aloud at the end of each turn; you can mute individual bubbles too. If the voice sounds robotic, you likely need a higher-quality `.onnx` model — there's a credit / install hint at the bottom of the panel.",
        render: () => <VoiceSettings />
      }
    ]
  },
  {
    id: 'ai',
    label: 'AI',
    description: 'Providers, memory, file knowledge, Python sandbox, usage.',
    icon: Cpu,
    sections: [
      {
        id: 'providers',
        label: 'Providers',
        icon: Bot,
        hint: 'API keys, model picks, auto-fallback, auto-router behaviour.',
        intro:
          'Configure the LLM providers the assistant can call. API keys are encrypted with your OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and never leave this machine. The auto-router can switch providers mid-prompt for speed or cost; turn it off if you want every send to go to your active pick verbatim. Local providers (Ollama, LM Studio) show a green badge when their daemon is reachable.',
        render: () => <ProviderSettings />
      },
      {
        id: 'memory',
        label: 'Memory',
        icon: Brain,
        hint: 'Facts, passive biographical profile, emotional context, summariser.',
        intro:
          "Three layers: explicit facts (you teach the AI things), passive biographical (auto-extracted in the background from your conversations), and emotional context (a daily sentiment classifier that biases tone). Edit, scope to specific modes, or wipe entirely. The summariser knobs control when older messages roll into a 'story so far' recap — raise the trigger for coding sessions where the recent file edits matter, lower it for creative writing where arc continuity wins.",
        render: () => <MemorySettings />
      },
      {
        id: 'files',
        label: 'File knowledge',
        icon: FileText,
        hint: 'Folders indexed into RAG + the vector store the AI retrieves from.',
        intro:
          'Point at folders you want the AI to be able to search. Files get chunked, embedded with the picked engine (OpenAI / Ollama / local Transformers.js), and stored in SQLite. The vector-store browser below lets you inspect which chunks landed and trace which ones got retrieved for the most recent assistant reply — useful when an answer feels off and you want to see WHY the AI grabbed that file. Local embeddings are free + offline; cloud embeddings are higher-quality but cost tokens.',
        render: () => (
          <>
            <FilesRagSettings />
            <VectorStoreSettings />
          </>
        )
      },
      {
        id: 'python',
        label: 'Python sandbox',
        icon: Terminal,
        hint: 'Persistent per-thread Jupyter-style kernels.',
        intro:
          'Each chat thread gets its own long-running Python kernel — state (variables, imports, plots) survives across `run_python` tool calls within the same thread. Workspace dirs live under userData; you can open them in your file explorer to see generated files. Kernels are killed by an idle reaper after a few minutes of no use to free RAM.',
        render: () => <PythonSandboxSettings />
      },
      {
        id: 'usage',
        label: 'Usage',
        icon: CreditCard,
        hint: 'Cost ledger, monthly budget, per-provider latency + success rate.',
        intro:
          "Every cloud-provider call is logged with tokens + dollars. Set a monthly cap and you'll get warnings at 75 / 90 / 100% — the budget alert triggers as a system notification + chat bubble, not a hard block. Per-provider performance shows you which one is actually fastest + most reliable on YOUR machine, so you can swap your active pick if needed.",
        render: () => <UsageSettings />
      }
    ]
  },
  {
    id: 'click',
    label: 'click_on_screen',
    description: 'Five-step click pipeline — taught → Sonnet → UIA → pick → vision.',
    icon: MousePointerClick,
    sections: [
      {
        id: 'click',
        label: 'click_on_screen',
        icon: MousePointerClick,
        hint: 'Master toggle, strategy router, taught-clicks store, benchmark harness.',
        intro:
          'Lets the AI click UI elements you describe in plain English. The pipeline tries five strategies in order, each cheaper + more precise than the next: a taught-click lookup (zero model call), Sonnet computer-use (when the active provider supports it), the Windows UIA tree, a vision model picking from the UIA candidate list, then free-form vision-locate as the fallback. Teach a click once via the hover-to-teach button and future identical descriptions short-circuit to instant — no model, no tokens. The benchmark harness measures all five strategies head-to-head against your own captured ground truth.',
        render: () => <ExperimentalSettings />
      }
    ]
  },
  {
    id: 'tools',
    label: 'Tools',
    description: 'Integrations, Home Assistant, scheduled tasks, MCP, plugins, browser bridge.',
    icon: Plug,
    sections: [
      {
        id: 'integrations',
        label: 'Integrations',
        icon: Plug,
        hint: 'API-key-only upgrades — Tavily, Stability, OpenWeather, etc.',
        intro:
          "Drop an API key and a feature lights up. Tavily upgrades the web_search tool from DuckDuckGo's free tier to ranked results with citations; Stability unlocks higher-quality image gen alongside the keyless Pollinations default; OpenWeather feeds weather context into proactive replies. Each entry shows what changes when you add the key + what falls back when you don't.",
        render: () => <IntegrationSettings />
      },
      {
        id: 'home-assistant',
        label: 'Home Assistant',
        icon: Home,
        hint: 'List entities, get state, call services — native HA integration.',
        intro:
          'Talk to your Home Assistant instance directly: list_entities discovers everything HA exposes, get_state reads any single entity, call_service is universal write (turn_on/off, set_temperature, lock, etc). The setup wizard validates the URL + long-lived access token before saving so you fix typos up front. The token lives in the OS keychain; only the URL is in plaintext config.',
        render: () => <HomeAssistantSettings />
      },
      {
        id: 'scheduled',
        label: 'Scheduled tasks',
        icon: Timer,
        hint: 'Cron-fired prompts + condition-driven proactive watch tasks.',
        intro:
          'Two flavours of automation in one panel. Cron tasks fire a prompt on a clock (every morning at 8, every Tuesday, etc) — useful for daily briefings, research digests, scheduled web fetches. Watch tasks fire on a condition (you went idle for N minutes, a sentiment shift, a task finished) and trigger a proactive voice nudge or a chat message. Both honour DND and have per-task throttles.',
        render: () => <ScheduledTasks />
      },
      {
        id: 'mcp',
        label: 'MCP servers',
        icon: Network,
        hint: 'Model Context Protocol — install, edit, browse the marketplace.',
        intro:
          'MCP servers extend the AI with curated tool surfaces — filesystem, GitHub, web fetch, your own custom ones. Install from the curated marketplace (signed entries), the community PR registry, or paste a manual config. Each server runs as a child process, the AI sees its tools alongside the built-in ones. Duplicate tool names across servers get an amber warning since the agent can guess wrong.',
        render: () => <McpSettings />
      },
      {
        id: 'plugins',
        label: 'Plugins',
        icon: Puzzle,
        hint: 'JSON workflow packs + optional JS hooks the assistant can run.',
        intro:
          "Plugins are JSON manifests that add quick-action buttons and optional JS hooks (onUserMessage, onAssistantReply, etc) the assistant runs in-process. Browse curated and community plugins from the marketplace; install lands them as `.json` files under userData/plugins. JS hooks are off behind a master switch — flip it on if you trust the plugin's author.",
        render: () => <PluginSettings />
      },
      {
        id: 'browser',
        label: 'Browser extension',
        icon: Globe,
        hint: 'Local Chrome bridge via native messaging.',
        intro:
          "Pair the optional Chrome extension to give the AI tools that read the active tab's URL, content, and screenshots. Everything runs locally over a native-messaging socket — no remote server, no cloud. The panel walks you through installing the native-host manifest (one config file per OS) and shows live connection state so you can verify the link is up.",
        render: () => <BrowserExtensionSettings />
      }
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy & Sync',
    description: 'Permissions, encrypted sync vault, capability diagnostics.',
    icon: ShieldCheck,
    sections: [
      {
        id: 'permissions',
        label: 'Permissions',
        icon: Lock,
        hint: 'What the assistant can do without asking again — 8 distinct capabilities.',
        intro:
          "Every automation capability — running shell commands, reading/writing files, controlling apps, using your mouse and keyboard, accessing the microphone, capturing the screen, talking to Home Assistant — sits behind one of 8 permissions. Nothing runs without an explicit grant. Each entry shows a risk badge (low/medium/high) and a plain-English description so you know what you're agreeing to. Revoke any at any time; the AI will start prompting again the next time it needs it.",
        render: () => <PermissionsManager />
      },
      {
        id: 'sync',
        label: 'Sync & backup',
        icon: GitBranch,
        hint: 'E2E-encrypted vault — fold a Dropbox/iCloud/OneDrive folder in.',
        intro:
          'Cross-device sync without a backend — point at a folder that something else (Dropbox, iCloud Drive, Syncthing) replicates between machines, and Soul writes an encrypted vault into it. Threads, facts, personas, and config all roam. Encryption is X25519 + ChaCha20-Poly1305 derived from a passphrase you set on each device; the vault folder itself never contains plaintext, so the cloud provider sees only ciphertext.',
        render: () => <SyncSettings />
      },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        icon: Activity,
        hint: 'Smoke tests across every permission-gated capability.',
        intro:
          "One-click sanity check: tries each capability and reports pass/fail/skip with a one-line detail. Useful when something feels broken ('why isn't the AI clicking?', 'why isn't filesystem write working?') — the smoke test names exactly which permission is missing or which subsystem returned an error.",
        render: () => <SmokeTestPanel />
      }
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'System prompt, experimental flags, About.',
    icon: Cog,
    sections: [
      {
        id: 'system-prompt',
        label: 'System prompt',
        icon: Type,
        hint: 'The base instruction set the assistant gets on every reply.',
        intro:
          "The system prompt is what tells the AI WHO it is and HOW to behave — voice, format preferences, hard rules. Mode fragments and persona overrides layer on top. Reset to the v2.0 default any time if you've drifted into something that doesn't work. Per-thread overrides live in the chat sidebar (pin a system prompt to one conversation).",
        render: () => <SystemPromptEditor />
      },
      {
        id: 'experimental',
        label: 'Experimental',
        icon: Layers,
        hint: 'Reserved for future opt-in features.',
        intro:
          "Where new features land before they graduate. click_on_screen used to live here through Phases 1–4; it now has its own top-level group. When a fresh experimental flag ships, it'll appear here with an honest 'what works / what doesn't' note so you can decide whether to try it.",
        render: () => (
          <div className="rounded-lg border border-white/10 bg-black/20 px-4 py-6 text-center text-[11px] text-slate-500">
            No experimental flags right now — features get their own panel once they ship.
          </div>
        )
      },
      {
        id: 'about',
        label: 'About',
        icon: Info,
        hint: 'Version, credits, re-run setup, leave a review.',
        intro:
          "Version, attribution for the open-source bits (Piper, Whisper, tesseract.js, lucide-react, etc), a 'Re-run setup discovery' button if you skipped first-launch detection, and a quick review form that posts to the marketing site.",
        render: () => <About />
      }
    ]
  }
]

/* ------------------------------- sidebar ------------------------------- */

function Sidebar({
  active,
  onPick
}: {
  active: GroupId
  onPick: (id: GroupId) => void
}): JSX.Element {
  const [filter, setFilter] = useState('')
  const lowered = filter.trim().toLowerCase()
  // Filter searches group labels, hints, AND sub-section labels — so
  // "ollama" finds the AI group and "MCP" finds Tools.
  const filtered = lowered
    ? GROUPS.filter((g) => {
        if (g.label.toLowerCase().includes(lowered)) return true
        if (g.description.toLowerCase().includes(lowered)) return true
        return g.sections.some(
          (s) =>
            s.label.toLowerCase().includes(lowered) ||
            (s.hint?.toLowerCase().includes(lowered) ?? false)
        )
      })
    : GROUPS
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-white/5 bg-black/30">
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
      <nav className="flex flex-col gap-0.5 px-2" aria-label="Settings sections">
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

/* ----------------------------- sub-tab pills ----------------------------- */

function SubTabs({
  sections,
  active,
  onPick
}: {
  sections: SectionItem[]
  active: string
  onPick: (id: string) => void
}): JSX.Element | null {
  if (sections.length < 2) return null
  return (
    <div className="scrollbar-void mb-4 -mx-1 flex gap-1 overflow-x-auto pb-1">
      {sections.map((s) => {
        const Icon = s.icon
        const isActive = s.id === active
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition',
              isActive
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-white/10 bg-black/20 text-slate-400 hover:bg-white/5 hover:text-slate-100'
            )}
          >
            <Icon size={11} />
            {s.label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------- root ------------------------------- */

function ContentSkeleton(): JSX.Element {
  return (
    <div className="flex h-40 items-center justify-center text-[11px] text-slate-500">
      <span className="animate-pulse">Loading…</span>
    </div>
  )
}

interface NavState {
  group: GroupId
  /** Sub-section id WITHIN the group. Defaults to first section's id. */
  section: string
}

function readPersisted(): NavState {
  // First-time visitors land on Setup (General → Setup) — the
  // friction-free orientation surface. Returning users get wherever
  // they last viewed.
  if (typeof window === 'undefined') return { group: 'general', section: 'setup' }
  try {
    const raw = window.localStorage.getItem('voidsoul:settings-nav')
    if (raw) {
      const parsed = JSON.parse(raw) as NavState
      const group = GROUPS.find((g) => g.id === parsed.group)
      if (group) {
        const section = group.sections.find((s) => s.id === parsed.section)
        if (section) return { group: group.id, section: section.id }
        return { group: group.id, section: group.sections[0].id }
      }
    }
  } catch {
    // Storage quota / private mode / malformed — fall through to default.
  }
  return { group: 'general', section: 'setup' }
}

export function SettingsRoot(): JSX.Element {
  const load = useConfigStore((s) => s.load)
  const ready = useConfigStore((s) => s.ready)
  const accent = useConfigStore((s) => s.config?.appearance.accent)
  const loadMemory = useMemoryStore((s) => s.load)
  const loadPlugins = usePluginStore((s) => s.load)

  const [nav, setNavRaw] = useState<NavState>(readPersisted)
  const setNav = (next: NavState): void => {
    setNavRaw(next)
    try {
      window.localStorage.setItem('voidsoul:settings-nav', JSON.stringify(next))
    } catch {
      // Non-fatal — next launch just lands on General/Mode.
    }
  }
  const pickGroup = (group: GroupId): void => {
    const g = GROUPS.find((x) => x.id === group)
    if (!g) return
    setNav({ group, section: g.sections[0].id })
  }
  const pickSection = (section: string): void => {
    setNav({ ...nav, section })
  }

  useEffect(() => {
    void load()
    void loadMemory()
    void loadPlugins()
  }, [load, loadMemory, loadPlugins])

  useConfigBroadcastSync()
  useWakeBroadcastSync()
  useAccentTheme(accent)
  useTheme()
  useGlobalSearchHotkey('settings')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // v2.0 polish — refuse Esc while a critical flow is mid-run.
        // UnlockEverythingDialog steps through ~20 IPC calls in sequence;
        // closing the window mid-way leaves a partially-granted config
        // (some permissions on, others not) AND drops the result dialog
        // before the user can see what skipped.
        if (useUiStore.getState().criticalBusyCount > 0) return
        event.preventDefault()
        void vs.window.closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const currentGroup = useMemo(
    () => GROUPS.find((g) => g.id === nav.group) ?? GROUPS[0],
    [nav.group]
  )
  const currentSection = useMemo(
    () => currentGroup.sections.find((s) => s.id === nav.section) ?? currentGroup.sections[0],
    [currentGroup, nav.section]
  )

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-void-700 text-[11px] text-slate-400">
        <span className="animate-pulse">Loading settings…</span>
      </div>
    )
  }

  const animKey = `${currentGroup.id}:${currentSection.id}`
  // When the group has just one section, the header reads "GROUP / Group"
  // which is redundant. Show only the group label in that case.
  const breadcrumb =
    currentGroup.sections.length > 1
      ? `${currentGroup.label} · ${currentSection.label}`
      : currentGroup.label
  const hint = currentSection.hint ?? currentGroup.description

  return (
    <div className="relative flex h-screen w-screen bg-void-700 text-slate-200">
      <Sidebar active={nav.group} onPick={pickGroup} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex items-center justify-between border-b border-white/5 px-6 pb-3 pr-36 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{breadcrumb}</p>
            <p className="mt-0.5 text-[14px] font-semibold text-white">{hint}</p>
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
          <div className="mx-auto w-full max-w-[640px]">
            <SubTabs
              sections={currentGroup.sections}
              active={currentSection.id}
              onPick={pickSection}
            />
            <AnimatePresence mode="wait">
              <motion.div
                key={animKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <Suspense fallback={<ContentSkeleton />}>
                  <SettingsHeaderIcon icon={currentSection.icon} />
                  {currentSection.intro && (
                    <div className="mb-4 rounded-xl border border-white/5 bg-black/15 px-4 py-3 text-[11px] leading-relaxed text-slate-300">
                      {currentSection.intro}
                    </div>
                  )}
                  {currentSection.render()}
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>
      <Overlays />
      <SetupDiscoveryPanel />
    </div>
  )
}

function SettingsHeaderIcon({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return (
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
      <Icon size={20} />
    </div>
  )
}
