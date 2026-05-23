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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  AppWindow,
  Clock,
  MessageSquare,
  Plus,
  SendHorizontal,
  Square,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { HudCore } from './HudCore'
import { Gauge } from './Gauge'
import { Orb } from '../widget/Orb'
import { MicButton } from '../common/MicButton'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore, useVisibleOrbState } from '../../store/useWidgetStore'
import { useChatStore } from '../../store/useChatStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useSystemStats } from '../../hooks/useSystemStats'
import { useCurrentSpoken } from '../../hooks/useCurrentSpoken'
import { getMode } from '@shared/modes'
import { resolveIcon } from '../../lib/icons'
import { runAction } from '../../lib/actions'
import { speak, stopSpeaking } from '../../lib/voice'
import { useDndActive } from '../../lib/useDndActive'
import { useClipboardPaste } from '../../lib/useClipboardPaste'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { useT } from '../../lib/i18n'
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

  const greet = (persona: VoicePersona): void => {
    if (isQuietNow(config.appearance.dnd)) return
    speak(persona === 'void' ? 'Void online.' : 'Soul online.', persona, voice.rate, voice.volume)
  }

  const toggle = async (): Promise<void> => {
    const enabled = !voice.enabled
    await setVoice({ enabled })
    if (enabled) greet(voice.persona)
    else stopSpeaking()
  }

  const pickPersona = async (persona: VoicePersona): Promise<void> => {
    await setVoice({ persona })
    if (voice.enabled) greet(persona)
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

/**
 * Strip markdown / code-fence chrome to a flat single line for the
 * teleprompter preview. Mirrors `forSpeech` in voice.ts (so what the user
 * reads matches what they hear) but collapses harder — no paragraph
 * breaks, no fenced code blocks, no list markers.
 */
function flattenForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Best preview line for the assistant's latest reply when TTS is idle —
 * the first sentence or, failing that, the first ~140 chars flattened.
 */
function previewLine(content: string): string {
  const flat = flattenForPreview(content)
  if (!flat) return ''
  const firstBoundary = flat.search(/[.!?](\s|$)/)
  if (firstBoundary >= 0 && firstBoundary < 140) return flat.slice(0, firstBoundary + 1)
  return flat.length > 140 ? flat.slice(0, 137).trimEnd() + '…' : flat
}

/**
 * Rolling-line preview of the assistant's reply.
 *
 * Three visual states:
 *  · TTS speaking — shows the sentence currently being voiced, ticking to
 *    the next as the synth queue advances. Teleprompter feel.
 *  · Streaming text but no TTS yet — shows the first sentence/line of the
 *    partial reply, kept to a single row so it doesn't push the layout.
 *  · Idle (reply landed, nothing speaking) — shows the first sentence of
 *    the latest reply as a static preview, with the "Full conversation →"
 *    link as the natural next step.
 *
 * One line throughout, no internal scrollbar. The user opens the full
 * conversation for the rest — that's what the link is for.
 */
function NexusResponse(): JSX.Element | null {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const setTab = useWidgetStore((s) => s.setTab)
  const spoken = useCurrentSpoken()

  const { assistant, prompt } = useMemo(() => {
    let a: ChatMessage | undefined
    let p: ChatMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!a && m.role === 'assistant' && m.id !== WELCOME_MESSAGE_ID) a = m
      else if (a && !p && m.role === 'user') {
        p = m
        break
      }
    }
    return { assistant: a, prompt: p }
  }, [messages])

  // Nothing to show: no past reply AND no live streaming text either.
  if (!assistant && !streamingContent) return null

  const toolCount = assistant?.toolCalls?.length ?? 0
  const baseContent = streaming && streamingContent ? streamingContent : assistant?.content ?? ''

  // Priority: live spoken sentence > preview of the latest content > nothing.
  let line = ''
  let label: 'speaking' | 'streaming' | 'idle' = 'idle'
  if (spoken) {
    line = flattenForPreview(spoken)
    label = 'speaking'
  } else if (streaming && streamingContent) {
    line = previewLine(streamingContent)
    label = 'streaming'
  } else if (baseContent) {
    line = previewLine(baseContent)
  }

  return (
    <div className="glass-soft mt-2 shrink-0 rounded-xl px-3 py-2">
      {prompt && (
        <p className="mb-1 truncate text-[10px] italic text-slate-500">“{prompt.content}”</p>
      )}
      {toolCount > 0 && (
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
          ran {toolCount} action{toolCount === 1 ? '' : 's'}
        </p>
      )}
      {line ? (
        // The `key` change on each new spoken sentence retriggers the fade
        // transition, giving the teleprompter that crisp roll-over feel
        // instead of a jarring instant swap.
        <p
          key={`${label}:${line}`}
          className="animate-nexus-roll truncate text-[12px] leading-snug text-slate-100"
          title={line}
        >
          {line}
        </p>
      ) : (
        <p className="animate-pulse py-0.5 text-[11px] text-slate-400">Thinking…</p>
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

/**
 * Compact one-line composer for the Nexus panel — lets users send a quick
 * message without switching to the full chat tab. Mirrors the chat
 * composer's send/stop semantics (Enter to send, Shift+Enter for newline,
 * single button toggles send/stop while streaming) so muscle memory carries
 * over for users who DO open the full conversation. Attachments / OCR /
 * model picker stay in the full composer — this slot is for fast follow-ups.
 */
function NexusComposer(): JSX.Element {
  const [text, setText] = useState('')
  const streaming = useChatStore((s) => s.streaming)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const onPaste = useClipboardPaste()
  const t = useT()

  const submit = (): void => {
    if (streaming) return
    const trimmed = text.trim()
    if (!trimmed) return
    void send(trimmed)
    setText('')
  }

  const canSend = streaming || text.trim().length > 0

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={text}
        placeholder={t('composer.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        spellCheck
        autoCorrect="on"
        className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-[var(--accent-ring)]"
      />
      <button
        type="button"
        onClick={() => (streaming ? stop() : submit())}
        disabled={!canSend}
        title={streaming ? t('composer.stop') : t('composer.send')}
        aria-label={streaming ? t('composer.stop') : t('composer.send')}
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40',
          streaming
            ? 'bg-rose-500/80 text-white hover:bg-rose-500'
            : 'bg-[var(--accent)] text-white hover:brightness-110'
        )}
      >
        {streaming ? <Square size={12} className="fill-current" /> : <SendHorizontal size={14} />}
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

      {/* Centre — just the orb identity, voice HUD and hint. Everything
       *  flow-y-scrolls here if it overflows, but in practice the orb plus
       *  one line of hint always fits the panel height. */}
      <div className="scrollbar-void flex min-h-0 flex-1 flex-col overflow-y-auto py-3">
        <OrbIdentity />
        <HudCore />
        <OrbHint />
      </div>

      {/* Pinned readback + gauges — beta feedback was that the rolling
       *  reply preview was getting buried inside the scrollable centre
       *  whenever the orb expanded. Pulling NexusResponse out here keeps
       *  it always visible immediately above the telemetry block, which
       *  is the natural reading order: assistant speaks → gauges show
       *  resource cost → composer. The two stay glued together as a unit
       *  so they read as one "vitals" panel. */}
      <div className="shrink-0 space-y-2 pt-1">
        <NexusResponse />
        <AdvancedTelemetry />
      </div>

      {/* Bottom — quick composer, voice controls, and the full-chat entry. */}
      <div className="shrink-0 space-y-2 pt-2">
        <NexusComposer />
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

/**
 * The Simple layout's central orb wrapped as a voice-toggle button.
 * Mirrors HudCore's OrbVoiceButton — same store, same semantics — so
 * tapping the orb in either layout converges on the same MicButton
 * pipeline. Single tap toggles record/stop.
 */
function SimpleOrbButton({
  orbState,
  animated,
  dnd
}: {
  orbState: ReturnType<typeof useVisibleOrbState>
  animated: boolean
  dnd: boolean
}): JSX.Element {
  const status = useVoiceInputStore((s) => s.status)
  const toggle = useVoiceInputStore((s) => s.toggle)
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const title = transcribing
    ? 'Transcribing…'
    : recording
      ? 'Stop and transcribe'
      : 'Tap to talk'
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={transcribing}
      title={title}
      aria-label={title}
      aria-pressed={recording}
      className="rounded-full outline-none transition-transform hover:scale-105 active:scale-95 disabled:cursor-wait"
    >
      <Orb size={88} state={orbState} animated={animated} dnd={dnd} />
    </button>
  )
}

function SimpleNexus(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const orbState = useVisibleOrbState()
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

      {/* The orb — tap to start / stop voice input. The Open Conversation
          button below remains the path to the full chat view. */}
      <div className="flex shrink-0 justify-center py-3">
        <SimpleOrbButton orbState={orbState} animated={animated} dnd={dnd} />
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

      {/* Composer + speak controls + conversation entry point, kept low. */}
      <div className="shrink-0 space-y-2 pt-3">
        <NexusComposer />
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
