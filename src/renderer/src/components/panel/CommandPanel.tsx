/**
 * The expanded command panel: a frosted-glass card with a draggable header,
 * tab bar and routed tab content. Only the header is a window-drag region so
 * the tab content stays fully interactive. On first open of a session,
 * VoidSoul speaks a greeting.
 */
import { Suspense, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  BookOpen,
  ChevronDown,
  Command,
  HelpCircle,
  Minus,
  Pin,
  Radar,
  ScrollText,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react'
import { Orb } from '../widget/Orb'
import { useDndActive } from '../../lib/useDndActive'
import { IconButton } from '../common/ui'
import { NexusView } from './NexusView'
import { ChatView } from '../chat/ChatView'
import { FirstRunBanner } from '../common/FirstRunBanner'
import { Overlays } from './Overlays'
import { CommandPalette } from './CommandPalette'
import { SpiritMotes } from './SpiritMotes'

// Lazy chunks — Logs + Notebook are tab content that load on first click;
// the dialogs only open on specific triggers. (Settings has its own window
// now, opened from the gear in the header.)
const LogsView = lazyNamed(() => import('./LogsView'), 'LogsView')
const NotebookView = lazyNamed(() => import('./NotebookView'), 'NotebookView')
const AddActionDialog = lazyNamed(() => import('./AddActionDialog'), 'AddActionDialog')
const DeleteActionDialog = lazyNamed(() => import('./DeleteActionDialog'), 'DeleteActionDialog')
const HelpDialog = lazyNamed(() => import('./HelpDialog'), 'HelpDialog')
const CanvasDialog = lazyNamed(() => import('./CanvasDialog'), 'CanvasDialog')
const TourOverlay = lazyNamed(() => import('./TourOverlay'), 'TourOverlay')
import { useWidgetStore, useVisibleOrbState, type PanelTab } from '../../store/useWidgetStore'
import { useChatStore } from '../../store/useChatStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { speakWith } from '../../lib/voice'
import { STATE_LABEL, cn, lazyNamed } from '../../lib/utils'
import { isQuietNow } from '@shared/types'

/** Tiny placeholder shown while a lazy-loaded tab chunk fetches. */
function TabSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
      <span className="animate-pulse">{label}</span>
    </div>
  )
}

const TABS: Array<{ id: PanelTab; label: string; icon: LucideIcon }> = [
  { id: 'nexus', label: 'Nexus', icon: Radar },
  { id: 'notebook', label: 'Notebook', icon: BookOpen },
  { id: 'logs', label: 'Logs', icon: ScrollText }
]

/** Ensures the spoken greeting plays only once per app session. */
let hasGreeted = false

function greet(): void {
  if (hasGreeted) return
  hasGreeted = true
  const config = useConfigStore.getState().config
  if (!config?.voice.enabled) return
  // Respect quiet mode — no spoken greeting during DND or scheduled quiet hours.
  if (isQuietNow(config.appearance.dnd)) return
  const hour = new Date().getHours()
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const personaName = config.voice.persona === 'void' ? 'Void' : 'Soul'
  speakWith(config.voice, `${part}. ${personaName} online. How can I help you?`)
}

function Header(): JSX.Element {
  const orbState = useVisibleOrbState()
  const collapse = useWidgetStore((s) => s.collapse)
  const config = useConfigStore((s) => s.config)
  const setAppearance = useConfigStore((s) => s.setAppearance)
  const dnd = useDndActive()
  const animated = config?.appearance.animations ?? true
  const onTop = config?.appearance.alwaysOnTop ?? true
  const provider = config?.providers.find((p) => p.id === config.activeProvider)

  return (
    <header className="drag flex items-center gap-3 px-4 pb-2.5 pt-3.5">
      <Orb size={30} state={orbState} animated={animated} dnd={dnd} />
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-sm font-semibold tracking-wide text-white">VoidSoul</h1>
        <p className="truncate text-[10px] text-slate-400">
          {STATE_LABEL[orbState]}
          {provider ? ` · ${provider.label} / ${provider.model}` : ' · no provider'}
        </p>
      </div>
      <IconButton
        onClick={() => useUiStore.getState().setPalette(true)}
        title="Command palette (Ctrl+K)"
      >
        <Command size={15} />
      </IconButton>
      <IconButton
        onClick={() => useUiStore.getState().setHelpOpen(true)}
        title="Quick reference & shortcuts"
      >
        <HelpCircle size={15} />
      </IconButton>
      <IconButton
        onClick={() => void vs.window.openSettings()}
        title="Settings (opens in its own window)"
      >
        <SlidersHorizontal size={15} />
      </IconButton>
      <IconButton
        onClick={() => void setAppearance({ alwaysOnTop: !onTop })}
        title={onTop ? 'Always on top: on' : 'Always on top: off'}
        className={onTop ? 'text-[var(--accent)]' : undefined}
      >
        <Pin size={15} className={onTop ? 'fill-current' : undefined} />
      </IconButton>
      <IconButton onClick={collapse} title="Collapse to orb">
        <ChevronDown size={17} />
      </IconButton>
      <IconButton onClick={() => void vs.window.hide()} title="Hide to tray">
        <Minus size={17} />
      </IconButton>
    </header>
  )
}

function TabBar(): JSX.Element {
  const activeTab = useWidgetStore((s) => s.activeTab)
  const setTab = useWidgetStore((s) => s.setTab)

  return (
    <nav className="flex gap-1 px-3 pb-2">
      {TABS.map((tab) => {
        const active = tab.id === activeTab
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-medium transition',
              active ? 'tab-active text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            )}
          >
            <Icon size={13} />
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}

export function CommandPanel(): JSX.Element {
  const activeTab = useWidgetStore((s) => s.activeTab)

  // Greet on first open; bind global panel shortcuts (Ctrl/Cmd-K, Ctrl/Cmd-N).
  useEffect(() => {
    greet()
    const onKey = (event: KeyboardEvent): void => {
      // Ignore when the user is in the middle of typing — Ctrl-N should
      // create a new chat from anywhere EXCEPT a text field where it might
      // mean something native (rare, but the safe call).
      const target = event.target as HTMLElement | null
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true

      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        const ui = useUiStore.getState()
        ui.setPalette(!ui.paletteOpen)
        return
      }
      if (mod && event.key.toLowerCase() === 'n' && !inField) {
        // Start a fresh chat thread. Surfaces in the threads sidebar
        // immediately and switches focus to it.
        event.preventDefault()
        void useChatStore.getState().createThread()
        useWidgetStore.getState().setTab('chat')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <motion.div
      className="relative h-screen w-screen p-2"
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      style={{ transformOrigin: 'bottom right' }}
    >
      <div className="glass relative flex h-full flex-col overflow-hidden rounded-2xl shadow-panel">
        <SpiritMotes />
        <div className="relative z-10 flex h-full flex-col">
          <Header />
          <TabBar />
          {/* Shown only when no provider can actually answer requests — gives
              first-run users an obvious path to a working setup instead of
              hitting a silent "no provider configured" error in the chat. */}
          <FirstRunBanner />
          <div className="relative flex-1 overflow-hidden border-t border-white/5">
            {activeTab === 'nexus' && <NexusView />}
            {activeTab === 'chat' && <ChatView />}
            {activeTab === 'notebook' && (
              <Suspense fallback={<TabSkeleton label="Loading notebook…" />}>
                <NotebookView />
              </Suspense>
            )}
            {activeTab === 'logs' && (
              <Suspense fallback={<TabSkeleton label="Loading logs…" />}>
                <LogsView />
              </Suspense>
            )}
          </div>
        </div>
      </div>
      <Overlays />
      <CommandPalette />
      {/* Dialogs render inside their own Suspense so a trigger doesn't block
          the rest of the panel from drawing while the chunk fetches. */}
      <Suspense fallback={null}>
        <AddActionDialog />
        <DeleteActionDialog />
        <HelpDialog />
        <CanvasDialog />
        <TourOverlay />
      </Suspense>
    </motion.div>
  )
}
