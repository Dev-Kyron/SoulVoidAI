/**
 * The Nexus tab — VoidSoul's HUD home. Two layouts share this file:
 *
 *  · Advanced — the animated radial command core ringed by live telemetry
 *    (CPU / RAM / GPU / temps / disk / battery). The "computer nerd" setup.
 *  · Simple — a clean phone-style app launcher with the orb, a grid of quick
 *    actions and the voice controls. The casual setup.
 *
 * Which one renders is driven by `appearance.nexusStyle`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity, AppWindow, Clock, MessageSquare, Plus, Volume2, VolumeX, X } from 'lucide-react'
import { HudCore } from './HudCore'
import { Gauge } from './Gauge'
import { Orb } from '../widget/Orb'
import { MicButton } from '../common/MicButton'
import { Markdown } from '../chat/Markdown'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore, useVisibleOrbState } from '../../store/useWidgetStore'
import { useChatStore } from '../../store/useChatStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useSystemStats } from '../../hooks/useSystemStats'
import { getMode } from '@shared/modes'
import { resolveIcon } from '../../lib/icons'
import { runAction } from '../../lib/actions'
import { guessVoice, speak, stopSpeaking } from '../../lib/voice'
import { useDndActive } from '../../lib/useDndActive'
import { cn } from '../../lib/utils'
import {
  WELCOME_MESSAGE_ID,
  isQuietNow,
  type ChatMessage,
  type QuickAction,
  type VoicePersona
} from '@shared/types'

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return `${hours}h ${minutes}m`
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

/** A temperature reading mapped to a warning tint (cool → warm → hot). */
function tempTone(celsius: number): string {
  if (celsius >= 85) return '#fb7185'
  if (celsius >= 70) return '#fbbf24'
  return 'var(--accent)'
}

/** A battery level mapped to a tint, with charging shown as healthy green. */
function batteryTone(percent: number, charging: boolean): string {
  if (charging) return '#34d399'
  if (percent <= 20) return '#fb7185'
  if (percent <= 40) return '#fbbf24'
  return 'var(--accent)'
}

/** Ticking wall clock, refreshed once a second. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** App identity above the orb — names the assistant and its purpose. */
function OrbIdentity(): JSX.Element {
  return (
    <div className="shrink-0 pb-2 text-center">
      <h2 className="font-display text-[20px] font-semibold leading-tight text-white">VoidSoul</h2>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
        Your AI assistant
      </p>
    </div>
  )
}

/** Subtle hint below the orb so first-time users know it's interactive. */
function OrbHint(): JSX.Element {
  return (
    <p className="shrink-0 pt-2 text-center text-[9px] uppercase tracking-[0.18em] text-slate-500">
      tap the orb to talk
    </p>
  )
}

function Readout({
  icon,
  label,
  value,
  sub
}: {
  icon: ReactNode
  label: string
  value: string
  sub?: string
}): JSX.Element {
  return (
    <div className="glass-soft flex items-center gap-2 rounded-xl px-2.5 py-2">
      <div className="shrink-0 text-[var(--accent)]">{icon}</div>
      <div className="min-w-0">
        <p className="truncate text-[8px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <p className="truncate text-[11px] font-semibold text-white">{value}</p>
        {sub && <p className="truncate text-[9px] text-slate-400">{sub}</p>}
      </div>
    </div>
  )
}

function VoiceBar(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setVoice = useConfigStore((s) => s.setVoice)
  if (!config) return null
  const voice = config.voice

  const resolvedUris = (): { voidVoiceURI: string; soulVoiceURI: string } => ({
    voidVoiceURI: voice.voidVoiceURI || guessVoice('void'),
    soulVoiceURI: voice.soulVoiceURI || guessVoice('soul')
  })

  const greet = (persona: VoicePersona, uris: { voidVoiceURI: string; soulVoiceURI: string }): void => {
    if (isQuietNow(config.appearance.dnd)) return
    speak(
      persona === 'void' ? 'Void online.' : 'Soul online.',
      persona === 'void' ? uris.voidVoiceURI : uris.soulVoiceURI,
      voice.rate
    )
  }

  const toggle = async (): Promise<void> => {
    const uris = resolvedUris()
    const enabled = !voice.enabled
    await setVoice({ enabled, ...uris })
    if (enabled) greet(voice.persona, uris)
    else stopSpeaking()
  }

  const pickPersona = async (persona: VoicePersona): Promise<void> => {
    const uris = resolvedUris()
    await setVoice({ persona, ...uris })
    if (voice.enabled) greet(persona, uris)
  }

  return (
    <div className="flex items-center gap-2">
      <MicButton className="h-8 w-8 shrink-0 border border-white/10" />
      <button
        type="button"
        onClick={() => void toggle()}
        title={voice.enabled ? 'Spoken replies on — click to mute' : 'Spoken replies off — click to enable'}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition',
          voice.enabled
            ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : 'border-white/10 text-slate-500 hover:text-slate-300'
        )}
      >
        {voice.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
      </button>
      <div
        className={cn(
          'flex flex-1 gap-1 rounded-lg border border-white/10 p-0.5 transition',
          !voice.enabled && 'opacity-50'
        )}
      >
        {(['void', 'soul'] as VoicePersona[]).map((persona) => (
          <button
            key={persona}
            type="button"
            onClick={() => void pickPersona(persona)}
            className={cn(
              'flex-1 rounded-md py-1 text-[10px] font-semibold uppercase tracking-[0.2em] transition',
              voice.persona === persona
                ? 'bg-[var(--accent)] text-white'
                : 'text-slate-400 hover:text-white'
            )}
          >
            {persona}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Shows the latest assistant reply inline on the HUD — no tab switch. */
function NexusResponse(): JSX.Element | null {
  const messages = useChatStore((s) => s.messages)
  const setTab = useWidgetStore((s) => s.setTab)
  const ref = useRef<HTMLDivElement>(null)

  let assistant: ChatMessage | undefined
  let prompt: ChatMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!assistant && m.role === 'assistant' && m.id !== WELCOME_MESSAGE_ID) assistant = m
    else if (assistant && !prompt && m.role === 'user') {
      prompt = m
      break
    }
  }

  useEffect(() => {
    if (assistant) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [assistant?.id, assistant?.content])

  if (!assistant) return null
  const toolCount = assistant.toolCalls?.length ?? 0

  return (
    <div ref={ref} className="glass-soft mt-2 shrink-0 rounded-xl px-3 py-2.5">
      {prompt && (
        <p className="mb-1 truncate text-[10px] italic text-slate-500">“{prompt.content}”</p>
      )}
      {toolCount > 0 && (
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
          ran {toolCount} action{toolCount === 1 ? '' : 's'}
        </p>
      )}
      {assistant.content ? (
        <div className="markdown selectable scrollbar-void max-h-[150px] overflow-y-auto text-[12px] text-slate-100">
          <Markdown>{assistant.content}</Markdown>
        </div>
      ) : (
        <p className="animate-pulse py-1 text-[11px] text-slate-400">Thinking…</p>
      )}
      <button
        type="button"
        onClick={() => setTab('chat')}
        className="mt-1.5 text-[10px] text-[var(--accent)] transition hover:underline"
      >
        Full conversation →
      </button>
    </div>
  )
}

/** Conversation entry button shared by both layouts. */
function OpenConversation(): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => useWidgetStore.getState().setTab('chat')}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] py-2 text-[11px] font-semibold text-white transition hover:bg-[var(--accent)]"
    >
      <MessageSquare size={14} />
      Open conversation
    </button>
  )
}

/* ------------------------------ Advanced -------------------------------- */

/** The full telemetry grid — only the dials whose sensors report are shown. */
function AdvancedTelemetry(): JSX.Element {
  const stats = useSystemStats()

  const gauges: JSX.Element[] = [
    <Gauge key="cpu" value={stats?.cpu ?? 0} label="CPU" />,
    <Gauge
      key="ram"
      value={stats?.memPercent ?? 0}
      label="RAM"
      sub={stats ? `${gigabytes(stats.memUsed)} / ${gigabytes(stats.memTotal)}` : '—'}
    />
  ]

  if (stats?.gpu?.load != null) {
    gauges.push(<Gauge key="gpu" value={stats.gpu.load} label="GPU" sub="load" />)
  }
  if (stats?.cpuTemp != null) {
    gauges.push(
      <Gauge
        key="cpu-temp"
        value={stats.cpuTemp}
        unit="°"
        label="CPU temp"
        color={tempTone(stats.cpuTemp)}
      />
    )
  }
  if (stats?.gpu?.temp != null) {
    gauges.push(
      <Gauge
        key="gpu-temp"
        value={stats.gpu.temp}
        unit="°"
        label="GPU temp"
        color={tempTone(stats.gpu.temp)}
      />
    )
  }
  if (stats?.disk) {
    gauges.push(
      <Gauge
        key="disk"
        value={stats.disk.percent}
        label="Disk"
        sub={`${gigabytes(stats.disk.used)} / ${gigabytes(stats.disk.total)}`}
      />
    )
  }
  if (stats?.battery) {
    gauges.push(
      <Gauge
        key="battery"
        value={stats.battery.percent}
        label="Battery"
        sub={stats.battery.charging ? 'charging' : 'on battery'}
        color={batteryTone(stats.battery.percent, stats.battery.charging)}
      />
    )
  }

  return (
    <div className="mt-auto shrink-0 space-y-2 pt-3">
      <div className="grid grid-cols-3 gap-2">{gauges}</div>
      <div className="glass-soft flex items-center justify-center gap-2 rounded-xl py-1.5">
        <Activity size={13} className="text-[var(--accent)]" />
        <span className="text-[11px] font-semibold text-white">
          {stats ? formatUptime(stats.uptime) : '—'}
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          uptime
        </span>
      </div>
    </div>
  )
}

function AdvancedNexus(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const activeWindow = useUiStore((s) => s.activeWindow)
  const now = useClock()
  if (!config) return null
  const provider = config.providers.find((p) => p.id === config.activeProvider)

  return (
    <div className="flex h-full flex-col px-3 py-3">
      {/* Top — focused window & clock readouts. */}
      <div className="grid shrink-0 grid-cols-2 gap-2">
        <Readout
          icon={<AppWindow size={15} />}
          label="Focused window"
          value={activeWindow?.process || 'Idle'}
          sub={
            activeWindow?.title ||
            (config.appearance.screenAwareness ? 'detecting…' : 'awareness off')
          }
        />
        <Readout
          icon={<Clock size={15} />}
          label={now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
          value={now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          sub={provider ? provider.label : 'no provider'}
        />
      </div>

      {/* Centre — the orb HUD, its inline reply and the telemetry grid. */}
      <div className="scrollbar-void flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        <OrbIdentity />
        <HudCore />
        <OrbHint />
        <NexusResponse />
        <AdvancedTelemetry />
      </div>

      {/* Bottom — voice and the conversation entry point. */}
      <div className="shrink-0 space-y-2">
        <VoiceBar />
        <OpenConversation />
      </div>
    </div>
  )
}

/* ------------------------------- Simple --------------------------------- */

/** A phone-style app tile — one quick action. Custom actions can be removed. */
function AppTile({ action, custom }: { action: QuickAction; custom: boolean }): JSX.Element {
  const config = useConfigStore((s) => s.config)
  const Icon = resolveIcon(action.icon)
  const granted = action.requires
    ? (config?.permissions[action.requires]?.granted ?? false)
    : true

  return (
    <div className="group relative flex w-16 flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => void runAction(action.action, action.label)}
        title={action.description}
        className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-void-700/80 text-[var(--accent)] shadow-glow transition active:scale-95 group-hover:border-[var(--accent-ring)] group-hover:bg-[var(--accent)] group-hover:text-white"
      >
        <Icon size={22} />
        {!granted && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-void-800" />
        )}
      </button>
      <span className="w-full truncate text-center text-[9px] font-medium text-slate-300 transition group-hover:text-white">
        {action.label}
      </span>
      {custom && (
        <button
          type="button"
          onClick={() =>
            useUiStore.getState().setActionToDelete({ id: action.id, label: action.label })
          }
          title="Remove from Nexus"
          className="absolute -top-1 left-1 z-10 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-rose-500 text-white opacity-0 ring-2 ring-void-800 transition hover:bg-rose-400 group-hover:opacity-100"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}

function SimpleNexus(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const orbState = useVisibleOrbState()
  const setTab = useWidgetStore((s) => s.setTab)
  const customActions = useMemoryStore((s) => s.data?.customActions ?? [])
  const now = useClock()
  const dnd = useDndActive()
  if (!config) return null

  const animated = config.appearance.animations
  const actions = [...getMode(config.activeMode).quickActions, ...customActions]
  const customIds = new Set(customActions.map((a) => a.id))
  const showAdd = customActions.length < 8

  return (
    <div className="flex h-full flex-col px-4 py-4">
      {/* App identity + small date/time. */}
      <OrbIdentity />
      <p className="shrink-0 text-center text-[10px] tabular-nums text-slate-500">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
        {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>

      {/* The orb — tap to open the conversation. */}
      <div className="flex shrink-0 justify-center py-3">
        <button
          type="button"
          onClick={() => setTab('chat')}
          title="Open conversation"
          className="rounded-full outline-none transition-transform hover:scale-105 active:scale-95"
        >
          <Orb size={88} state={orbState} animated={animated} dnd={dnd} />
        </button>
      </div>

      <OrbHint />

      {/* App grid plus the latest inline reply. */}
      <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-4 justify-items-center gap-x-2 gap-y-3">
          {actions.map((action) => (
            <AppTile key={action.id} action={action} custom={customIds.has(action.id)} />
          ))}
          {showAdd && (
            <button
              type="button"
              onClick={() => useUiStore.getState().setAddActionOpen(true)}
              title="Add a quick action"
              className="group flex w-16 flex-col items-center gap-1.5"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-dashed border-white/20 text-slate-500 transition group-hover:border-[var(--accent)] group-hover:text-[var(--accent)] group-active:scale-95">
                <Plus size={22} />
              </span>
              <span className="text-[9px] font-medium text-slate-500 transition group-hover:text-[var(--accent)]">
                Add
              </span>
            </button>
          )}
        </div>
        <NexusResponse />
      </div>

      {/* Speak controls, kept low, with the conversation entry point. */}
      <div className="shrink-0 space-y-2 pt-3">
        <VoiceBar />
        <OpenConversation />
      </div>
    </div>
  )
}

export function NexusView(): JSX.Element | null {
  const nexusStyle = useConfigStore((s) => s.config?.appearance.nexusStyle)
  if (!nexusStyle) return null
  return nexusStyle === 'simple' ? <SimpleNexus /> : <AdvancedNexus />
}
