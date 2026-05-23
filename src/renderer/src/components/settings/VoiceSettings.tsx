/**
 * Voice settings panel — v1.5.0 layout.
 *
 * Lives in its own top-level Settings tab as of v1.5. Four sibling
 * collapsible sections, each independently foldable so the user can
 * focus on just the surface they're tuning:
 *
 *   1. Voice picker     — Piper .onnx per persona + rate/volume sliders.
 *                         Default-expanded; this is the everyday surface.
 *   2. Voice direction  — tone catalogue + time-of-day window. Read-only
 *                         audition strip; the model picks tones itself.
 *   3. Proactive voice  — v1.5 watch-task master + per-task toggles.
 *   4. Wake word        — continuous-listening arm + .ppn config.
 *
 * Piper credit lives inside (1) since it's specifically about the voice
 * picker; Michael Hansen (rhasspy) maintains Piper on his own time and
 * the user explicitly asked for the attribution to stay visible.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  FolderOpen,
  Github,
  Heart,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Volume2
} from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore } from '../../store/useWidgetStore'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { CustomWatchTaskDialog } from './CustomWatchTaskDialog'
import { ScreenWatchSectionBody } from './ScreenWatchSection'
import { relayWakeState } from '../../lib/wakeBridge'
import { speak } from '../../lib/voice'
import { vs } from '../../lib/bridge'
import { cn, relativeTime } from '../../lib/utils'
import { getTimeWindow, getDefaultTone, getWindowLabel } from '@shared/voicePersona'
import type { InstalledVoice, VoiceConfig, VoicePersona, VoiceSetupStatus } from '@shared/types'

const PIPER_REPO = 'https://github.com/rhasspy/piper'
const PIPER_VOICES_REPO = 'https://github.com/rhasspy/piper/blob/master/VOICES.md'

export function VoiceSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setVoice = useConfigStore((s) => s.setVoice)
  const pushToast = useUiStore((s) => s.pushToast)
  const [status, setStatus] = useState<VoiceSetupStatus | null>(null)

  const refreshStatus = useCallback(() => {
    void vs.voice.status().then(setStatus)
  }, [])

  // First mount: migrate any legacy Voices/ folder, then probe the
  // canonical per-user voices folder for installed models. The migration
  // is no-op on subsequent runs (idempotent — checks for existing voices
  // per persona before copying).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await vs.voice.migrateLegacy()
        if (cancelled) return
        if (result.copied > 0) {
          pushToast(
            'success',
            `Imported ${result.copied} voice file${result.copied === 1 ? '' : 's'} from Voices/.`
          )
        }
      } catch {
        /* migration is best-effort */
      }
      if (!cancelled) refreshStatus()
    })()
    return () => {
      cancelled = true
    }
  }, [pushToast, refreshStatus])

  if (!config) return null
  const voice = config.voice

  // Four sibling sections, each independently foldable. Picker is the
  // only one default-expanded — it's the daily-driver surface; the rest
  // open when the user goes looking for them.
  return (
    <>
      <CollapsibleSection
        title="Voice picker"
        hint="Piper TTS — neural voices running locally on your machine. No cloud, no API key, no rate limits."
        defaultOpen
      >
        <VoicePickerBody
          voice={voice}
          status={status}
          setVoice={setVoice}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Voice direction"
        hint="The tones the model can pick from when speaking — audition each."
      >
        <VoiceDirectionBody voice={voice} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Proactive voice"
        hint="Let Soul initiate — nudges when a long task finishes, when you've been idle, when you're stuck."
      >
        <ProactiveVoiceBody />
      </CollapsibleSection>

      <CollapsibleSection
        title="Screen watch"
        hint="Soul periodically looks at your screen and speaks if she notices something worth saying. Permission-gated. Cost-aware with a daily cap."
      >
        <ScreenWatchSectionBody />
      </CollapsibleSection>

      <CollapsibleSection
        title="Wake word"
        hint="Continuous listening for &quot;Hey Void&quot; / &quot;Hey Soul&quot;."
      >
        <WakeWordBody voice={voice} />
      </CollapsibleSection>
    </>
  )
}

/**
 * The picker body — voice toggle, binary warning, the two persona cards,
 * shortcut buttons, rate/volume sliders, active-persona text, Piper
 * credit. Lives inside the "Voice picker" CollapsibleSection.
 */
function VoicePickerBody({
  voice,
  status,
  setVoice
}: {
  voice: VoiceConfig
  status: VoiceSetupStatus | null
  setVoice: (patch: Partial<VoiceConfig>) => Promise<void>
}): JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between py-1.5">
        <div>
          <p className="text-[12px] text-slate-200">Spoken replies</p>
          <p className="text-[10px] text-slate-500">Read assistant responses aloud</p>
        </div>
        <Toggle
          checked={voice.enabled}
          onChange={(enabled) => void setVoice({ enabled })}
        />
      </div>

      {!status?.binaryAvailable && (
        <div className="my-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <p className="flex items-start gap-1.5 font-semibold">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            Piper binary not bundled with this build.
          </p>
          <p className="mt-1 text-[10px] text-amber-300/80">
            Run <code className="rounded bg-black/40 px-1">npm run piper</code> in the dev tree to
            download it, then rebuild.
          </p>
        </div>
      )}

      <VoiceCard
        persona="void"
        label="Void voice (male)"
        installed={status?.void ?? null}
        voice={voice}
        active={voice.persona === 'void'}
        onUse={() => void setVoice({ persona: 'void' })}
      />
      <VoiceCard
        persona="soul"
        label="Soul voice (female)"
        installed={status?.soul ?? null}
        voice={voice}
        active={voice.persona === 'soul'}
        onUse={() => void setVoice({ persona: 'soul' })}
      />

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void vs.voice.openFolder()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-black/20 py-2 text-[11px] text-slate-300 transition hover:bg-white/5"
        >
          <FolderOpen size={11} />
          Open voices folder
        </button>
        <button
          type="button"
          onClick={() => window.open(PIPER_VOICES_REPO, '_blank')}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-black/20 py-2 text-[11px] text-slate-300 transition hover:bg-white/5"
        >
          Browse more voices
          <ExternalLink size={10} />
        </button>
      </div>

      <div className="my-3 space-y-1.5">
        <div className="py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[10px] text-slate-400">Speech rate</label>
            <span className="text-[10px] text-slate-500">{voice.rate.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min={0.6}
            max={1.5}
            step={0.1}
            value={voice.rate}
            onChange={(e) => void setVoice({ rate: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>

        <div className="py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[10px] text-slate-400">Speech volume</label>
            <span className="text-[10px] text-slate-500">{Math.round(voice.volume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={voice.volume}
            onChange={(e) => void setVoice({ volume: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
          {/* Low-volume warning. Piper voices are quieter than typical TTS,
           *  so even with the v1.3.4 make-up gain, sliders below ~30%
           *  produce playback that's hard to hear over ambient room noise.
           *  Beta testers consistently set this low by accident and read
           *  the resulting silence as "voice is broken." Flag it cheaply. */}
          {voice.volume > 0 && voice.volume < 0.3 && (
            <p className="mt-1 text-[10px] text-amber-300/80">
              Slider is low — Piper voices may be barely audible at this level.
              Try 50–80% if chat replies sound silent.
            </p>
          )}
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-slate-500">
        Active persona: <span className="uppercase text-[var(--accent)]">{voice.persona}</span> —
        switch between Void and Soul from the Nexus HUD.
      </p>

      <PiperCredit />
    </>
  )
}

/**
 * v1.3.0 Voice direction — explains the five tone presets the model can
 * pick from (via <voice tone="..."> markup) and gives the user a sample
 * line per tone so they can hear how each one sounds. Read-only — tones
 * aren't user-configurable here; the model picks them per segment based
 * on context. This row is purely informational + audition.
 */
import type { ToneTag } from '@shared/voiceMarkers'

const TONE_SAMPLES: ReadonlyArray<{
  tone: ToneTag
  label: string
  hint: string
  sample: string
}> = [
  {
    tone: 'casual',
    label: 'Casual',
    hint: 'relaxed, conversational, short',
    sample: "Alright — here's the gist of what I just shipped."
  },
  {
    tone: 'focused',
    label: 'Focused',
    hint: 'direct, minimal filler, task mode',
    sample: "Two changes — schema migration and the API patch. Both look clean."
  },
  {
    tone: 'excited',
    label: 'Excited',
    hint: 'energy up, faster cadence',
    sample: "Big one — the tests are green and the build's down to nine seconds!"
  },
  {
    tone: 'serious',
    label: 'Serious',
    hint: 'slower, deliberate, weighted',
    sample: "One thing worth pausing on. This change touches every user's session."
  },
  {
    tone: 'dry',
    label: 'Dry',
    hint: 'understated, deadpan, one-liner energy',
    sample: "Well. That's one way to handle a null pointer."
  },
  {
    tone: 'encouraging',
    label: 'Encouraging',
    hint: 'supportive lift, "you got this"',
    sample: "You're closer than it feels — push through this one and the rest follows."
  },
  {
    tone: 'playful',
    label: 'Playful',
    hint: 'light, mischievous, teasing',
    sample: "Oh? Going off the rails, are we? Lead on."
  },
  {
    tone: 'warm',
    label: 'Warm',
    hint: 'gentle, intimate, reassuring',
    sample: "Take your time. I'm here when you want to pick it back up."
  },
  {
    tone: 'curious',
    label: 'Curious',
    hint: 'leaning in, exploratory, asking',
    sample: "Hmm, that's a weird-looking error. What's the call stack say?"
  },
  {
    tone: 'thinking',
    label: 'Thinking',
    hint: 'pondering out loud, slower',
    sample: "Let me sit with that for a moment. Yeah, I think the second approach has legs."
  }
]

function VoiceDirectionBody({ voice }: { voice: VoiceConfig }): JSX.Element {
  const [playing, setPlaying] = useState<string | null>(null)
  // Recompute the current window every time the panel renders — the
  // user might keep settings open across a window boundary (e.g. 8:59
  // → 9:00 day flip). Memoising on a 1-minute ticker would be cleaner
  // but is overkill: the settings panel re-renders on every config
  // change anyway, which is more than often enough.
  const now = new Date()
  // Local name `timeWindow` (not `window`) so we don't shadow the global
  // `window` — the audition button below uses `window.setTimeout`.
  const timeWindow = getTimeWindow(now)
  const defaultTone = getDefaultTone(timeWindow)
  const windowLabel = getWindowLabel(timeWindow)
  const personaName = voice.persona === 'void' ? 'Void' : 'Soul'
  return (
    <>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
        Replies have a chat layer (what you read) and a voice layer (what gets
        spoken aloud). {personaName} picks the tone for each spoken segment —
        it's their call, not a setting. Tap any tone below to audition it
        with the active persona.
      </p>
      {/* Current-window indicator. Informational only — the persona
       *  knows what time it is and reads the moment themselves; this
       *  is just here so the user can see the context the persona has. */}
      <div className="mb-2 rounded-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2 py-1.5">
        <p className="text-[10px] font-semibold text-white">
          {personaName} knows: {windowLabel.toLowerCase()}
        </p>
        <p className="mt-0.5 text-[10px] text-slate-400">
          Natural fit for this window:{' '}
          <span className="font-mono text-[var(--accent)]">{defaultTone}</span>
          {' '}— but {personaName} may pick a different tone based on the
          moment.
        </p>
      </div>
      <div className="space-y-1">
        {TONE_SAMPLES.map((t) => {
          const isPlaying = playing === t.tone
          return (
            <button
              key={t.tone}
              type="button"
              onClick={() => {
                setPlaying(t.tone)
                // Auditioning a tone is a diagnostic — fixed full volume
                // regardless of the user's speech volume slider. If the
                // slider is at 15% the user wouldn't hear the audition
                // and would think the feature is broken; auditioning at
                // 1.0 separates "tone sounds right" from "volume is set
                // wrong" as two clearly distinct decisions.
                speak(t.sample, voice.persona, voice.rate, 1, t.tone)
                // The voice queue doesn't expose "finished" — guard the
                // spinner with a generous timer matching the sample length.
                window.setTimeout(() => setPlaying((cur) => (cur === t.tone ? null : cur)), 4000)
              }}
              disabled={isPlaying}
              className="flex w-full items-center gap-2 rounded-md border border-white/5 bg-black/20 px-2 py-1.5 text-left transition hover:border-white/15 hover:bg-black/30 disabled:opacity-60"
            >
              {isPlaying ? (
                <Loader2 size={11} className="shrink-0 animate-spin text-[var(--accent)]" />
              ) : (
                <Play size={11} className="shrink-0 text-slate-400" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-white">
                  {t.label}
                  <span className="ml-1.5 text-[9px] font-normal text-slate-500">
                    · {t.hint}
                  </span>
                </p>
                <p className="truncate font-mono text-[9px] italic text-slate-500">
                  "{t.sample}"
                </p>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

/**
 * Single voice card — shows the installed .onnx for one persona with
 * file size + language + preview button. Click to switch active persona
 * to this voice.
 *
 * Empty state ("no voice installed") nudges the user to drop a .onnx
 * into the persona's folder — links to the Piper voices catalog so they
 * know where to grab one.
 */
function VoiceCard({
  persona,
  label,
  installed,
  voice,
  active,
  onUse
}: {
  persona: VoicePersona
  label: string
  installed: InstalledVoice | null
  voice: VoiceConfig
  active: boolean
  onUse: () => void
}): JSX.Element {
  const [previewing, setPreviewing] = useState(false)
  const preview = (): void => {
    if (!installed || previewing) return
    setPreviewing(true)
    speak(
      persona === 'void' ? "I'm Void. Ready when you are." : "I'm Soul. How can I help?",
      persona,
      voice.rate,
      voice.volume
    )
    // The speak call is fire-and-forget from this layer's POV; reset the
    // spinner after a beat. Piper synthesis for a 5-word sentence finishes
    // well inside 500ms on every machine we've tested.
    window.setTimeout(() => setPreviewing(false), 800)
  }
  return (
    <div
      className={cn(
        'mt-2 rounded-lg border px-3 py-2.5 transition',
        installed
          ? active
            ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
            : 'border-white/10 bg-black/20 hover:border-white/20'
          : 'border-dashed border-white/15 bg-black/20'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Volume2 size={11} className={active ? 'text-[var(--accent)]' : 'text-slate-500'} />
        <p className="flex-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
        {active && (
          <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-white">
            Active
          </span>
        )}
      </div>
      {installed ? (
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onUse}
            className="min-w-0 flex-1 text-left"
            disabled={active}
          >
            <p className="truncate text-[12px] font-semibold capitalize text-white">{installed.name}</p>
            <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">
              {installed.id}
              {installed.language && ` · ${installed.language}`}
              {installed.quality && ` · ${installed.quality}`}
              {` · ${formatSize(installed.sizeBytes)}`}
            </p>
          </button>
          <button
            type="button"
            onClick={preview}
            disabled={previewing}
            title="Preview voice"
            aria-label={`Preview ${persona} voice`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
          >
            {previewing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          </button>
        </div>
      ) : (
        <p className="text-[10px] text-slate-400">
          No voice installed. Drop a Piper <code className="rounded bg-black/30 px-1">.onnx</code>{' '}
          (and the matching <code className="rounded bg-black/30 px-1">.onnx.json</code>) into{' '}
          <code className="rounded bg-black/30 px-1">voices/{persona}/</code>.
        </p>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/**
 * Credit + promo strip for Piper. The user explicitly asked for the
 * attribution to be visible — Piper is MIT-licensed but Michael Hansen
 * (rhasspy) maintains it on his own time, so a "View on GitHub" link is
 * both a nice gesture and the right thing to do.
 */
/**
 * Proactive voice settings — master toggle + per-task enable + custom
 * task builder (v1.6.0).
 *
 * The four v1.5 built-ins (Task complete / Long idle / Stuck loop /
 * Morning recap) seed automatically on boot. Users can add their own
 * tasks via the "+ Custom task" button — `addWatchTask` was always
 * part of the watch-task API, but v1.5 only exposed it through the
 * boot-time seeder. The CustomWatchTaskDialog flips that into a
 * platform feature: anyone can compose "When X happens, Soul says Y".
 *
 * Built-in tasks are detected by name (they re-seed on boot if
 * deleted, so the delete button stays hidden for them — surfacing a
 * delete that does nothing would be confusing).
 */
const BUILT_IN_NAMES = new Set(['Task complete', 'Long idle', 'Stuck loop', 'Morning recap'])

function ProactiveVoiceBody(): JSX.Element {
  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)
  const [tasks, setTasks] = useState<import('@shared/types').WatchTask[]>([])
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await vs.proactive.list()
      setTasks(list)
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Re-fetch every 60s so lastRun timestamps stay current while panel open.
    const id = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(id)
  }, [refresh])

  if (!config) return <></>

  const masterOn = config.proactiveVoice.enabled

  const handleMaster = async (next: boolean): Promise<void> => {
    await useConfigStore.getState().setProactiveVoice({ enabled: next })
  }

  const handleTaskToggle = async (
    id: string,
    name: string,
    next: boolean
  ): Promise<void> => {
    if (loading) return
    setLoading(true)
    try {
      await vs.proactive.setEnabled(id, next)
      pushToast(
        'success',
        next
          ? `Enabled "${name}" — Soul will speak when this condition trips.`
          : `Disabled "${name}".`
      )
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const handleTaskRemove = async (id: string, name: string): Promise<void> => {
    if (loading) return
    if (!window.confirm(`Remove watch task "${name}"? This can't be undone.`)) return
    setLoading(true)
    try {
      await vs.proactive.remove(id)
      pushToast('success', `Removed "${name}".`)
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const summarise = (task: import('@shared/types').WatchTask): string => {
    const t = task.spec.type
    if (t === 'idle-duration') {
      const mins = task.spec.params.minutes ?? 30
      const from = task.spec.params.activeFrom as string | undefined
      const to = task.spec.params.activeTo as string | undefined
      const window = from && to ? ` (${from}–${to})` : ''
      return `After ${mins} min idle${window}`
    }
    if (t === 'task-complete') {
      return `When a long task (>${task.spec.params.minDurationSec ?? 10}s) finishes`
    }
    if (t === 'sentiment-shift') {
      return `When session sentiment turns ${task.spec.params.to ?? 'any'}`
    }
    if (t === 'time-of-day-window') {
      return `Daily at ${task.spec.params.at ?? '09:00'}`
    }
    return t
  }

  return (
    <>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
        Soul can initiate without being asked — a quick nudge when a long
        task finishes, when you've been idle a while, when she notices
        you're stuck. Opt in to the ones you want, or build your own with
        "+ Custom task". DND + voice mute always override.
      </p>

      <div className="mb-2 flex items-center justify-between rounded-lg border border-white/5 bg-black/20 px-2.5 py-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-200">
            Master switch
          </p>
          <p className="text-[10px] text-slate-500">
            Off = no proactive speech regardless of per-task toggles.
          </p>
        </div>
        <Toggle checked={masterOn} onChange={(v) => void handleMaster(v)} />
      </div>

      {masterOn && (
        <>
          <div className="space-y-1">
            {tasks.length === 0 ? (
              <p className="text-[10px] italic text-slate-500">
                Loading built-in tasks…
              </p>
            ) : (
              tasks.map((task) => {
                const isCustom = !BUILT_IN_NAMES.has(task.name)
                return (
                  <div
                    key={task.id}
                    className="rounded-md border border-white/5 bg-black/20 px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
                          {task.name}
                          {isCustom && (
                            <span className="rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                              Custom
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] text-slate-500">{summarise(task)}</p>
                        {task.lastRun && (
                          <p className="mt-0.5 text-[9px] text-slate-600">
                            Last fired {relativeTime(task.lastRun)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Toggle
                          checked={task.enabled}
                          onChange={(v) => void handleTaskToggle(task.id, task.name, v)}
                        />
                        {isCustom && (
                          <button
                            type="button"
                            onClick={() => void handleTaskRemove(task.id, task.name)}
                            title="Remove this custom task"
                            aria-label={`Remove ${task.name}`}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition hover:bg-rose-500/15 hover:text-rose-300"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 bg-black/10 py-2 text-[11px] font-semibold text-slate-300 transition hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
          >
            <Plus size={12} />
            Custom task
          </button>
        </>
      )}

      <CustomWatchTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdded={() => void refresh()}
      />
    </>
  )
}

function PiperCredit(): JSX.Element {
  return (
    <div className="my-3 rounded-lg border border-[var(--accent-ring)] bg-gradient-to-br from-[var(--accent-soft)] to-transparent p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Heart size={11} className="text-[var(--accent)]" />
        <p className="text-[12px] font-semibold text-white">Voices powered by Piper TTS</p>
      </div>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-300">
        Open-source neural text-to-speech by Michael Hansen (Rhasspy). Runs locally on your
        machine — no cloud, no API key, no rate limits. If you like the voices, star the repo or
        sponsor the project.
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => window.open(PIPER_REPO, '_blank')}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-semibold text-slate-200 transition hover:bg-white/5"
        >
          <Github size={10} />
          View on GitHub
          <ExternalLink size={9} className="opacity-60" />
        </button>
        <button
          type="button"
          onClick={() => window.open(PIPER_VOICES_REPO, '_blank')}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-semibold text-slate-200 transition hover:bg-white/5"
        >
          <Sparkles size={10} />
          Explore more voices
          <ExternalLink size={9} className="opacity-60" />
        </button>
      </div>
    </div>
  )
}

/**
 * Per-session arm switch for the wake-word engine. Carried over from the
 * v1.1.x voice settings — wake-word lives next to TTS conceptually since
 * both are "voice" features, and the user already knows where to find it.
 */
function ArmRow(): JSX.Element {
  const armed = useWidgetStore((s) => s.wakeArmed)
  const setArmed = useWidgetStore((s) => s.setWakeArmed)
  return (
    <div className="mt-2 flex items-center justify-between rounded-md border border-white/5 bg-black/20 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${armed ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`}
        />
        <p className="text-[11px] text-slate-300">
          {armed ? 'Listening for wake word' : 'Mic is off · click Arm to listen'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          setArmed(!armed)
          // v1.7.3 — relay across windows so the main panel's
          // useWakeWord hook actually sees the change and boots the
          // engine. Without this, Settings flips its local store but
          // the engine in main panel stays dormant forever.
          relayWakeState()
        }}
        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
          armed
            ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
            : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
        }`}
      >
        {armed ? 'Disarm' : 'Arm now'}
      </button>
    </div>
  )
}

function WakeWordBody({ voice }: { voice: VoiceConfig }): JSX.Element {
  const setVoice = useConfigStore((s) => s.setVoice)
  const pushToast = useUiStore((s) => s.pushToast)
  const [hasKey, setHasKey] = useState(false)
  const [voidPpn, setVoidPpn] = useState(false)
  const [soulPpn, setSoulPpn] = useState(false)

  const refresh = async (): Promise<void> => {
    const [picovoiceRes, vBytesRes, sBytesRes] = await Promise.allSettled([
      vs.secrets.has('picovoice'),
      vs.wakeWord.keywordBytes('void'),
      vs.wakeWord.keywordBytes('soul')
    ])
    setHasKey(picovoiceRes.status === 'fulfilled' ? picovoiceRes.value : false)
    setVoidPpn(vBytesRes.status === 'fulfilled' ? Boolean(vBytesRes.value) : false)
    setSoulPpn(sBytesRes.status === 'fulfilled' ? Boolean(sBytesRes.value) : false)
  }

  useEffect(() => {
    void refresh()
  }, [voice.wakeWord.enabled])

  const openFolder = async (): Promise<void> => {
    await vs.wakeWord.openFolder()
    pushToast('info', 'Drop void.ppn / soul.ppn here, then toggle the wake word off and on.')
  }

  return (
    <>
      <div className="mb-1 flex items-center justify-end py-1">
        <Toggle
          checked={voice.wakeWord.enabled}
          onChange={(enabled) => {
            if (!enabled) {
              void setVoice({ wakeWord: { enabled } })
              return
            }
            void (async () => {
              const perms = useConfigStore.getState().config?.permissions
              if (!perms?.microphone.granted) {
                const granted = await useUiStore
                  .getState()
                  .promptPermission('microphone', 'Wake word')
                if (!granted) {
                  pushToast('info', 'Microphone permission is needed for wake word.')
                  return
                }
                await useConfigStore.getState().setPermission('microphone', true)
              }
              await setVoice({ wakeWord: { enabled: true } })
            })()
          }}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        Continuous listening for "Hey Void" / "Hey Soul". Works keyless via the local Whisper
        model (~75 MB, downloads once — same model used for voice input). With a Picovoice access
        key, the engine upgrades to Porcupine for lower CPU and faster detection; custom .ppn
        keyword files dropped in the wake-words folder override the defaults.
      </p>
      {voice.wakeWord.enabled && <ArmRow />}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
        <span className={hasKey ? 'text-emerald-400' : 'text-cyan-300'}>
          {hasKey ? '✓ Porcupine (key set)' : '✓ Whisper (keyless default)'}
        </span>
        {hasKey && (
          <>
            <span className={voidPpn ? 'text-emerald-400' : 'text-slate-500'}>
              {voidPpn ? '✓ void.ppn loaded' : 'void.ppn missing (fallback: "computer")'}
            </span>
            <span className={soulPpn ? 'text-emerald-400' : 'text-slate-500'}>
              {soulPpn ? '✓ soul.ppn loaded' : 'soul.ppn missing (fallback: "jarvis")'}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => void openFolder()}
          className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/5"
        >
          <FolderOpen size={10} />
          Open folder
        </button>
      </div>

      {/* v1.7.1 — "What Whisper heard" diagnostic ticker. Only useful for
       *  the Whisper path (Porcupine doesn't transcribe). Catches the
       *  silent-failure case where the wake phrase is being mis-heard
       *  ("Hey Boyd" instead of "Hey Void"). */}
      {!hasKey && voice.wakeWord.enabled && <WakeHeardTicker />}
    </>
  )
}

/**
 * Whisper diagnostic ticker — last 8 events. Each event is one of:
 *   · matched=true        green row with "match" pill
 *   · text="…"            grey row (heard but no match)
 *   · text="" + no error  silence-beat (cyan dot, "(silence)")
 *   · error set           red row with the error message
 *
 * Plus a one-line stats header counting each kind so the user can see
 * "Whisper has heard X things but matched 0" at a glance.
 *
 * Empty state nudges the user to speak. Once any event has fired the
 * ticker shows it instead of the empty hint.
 */
function WakeHeardTicker(): JSX.Element {
  const heard = useWidgetStore((s) => s.wakeHeard)
  const scans = useWidgetStore((s) => s.wakeScans)
  const blockedReason = useWidgetStore((s) => s.wakeLastBlockedReason)
  const clear = useWidgetStore((s) => s.clearWakeHeard)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const pushToast = useUiStore((s) => s.pushToast)

  // Cross-window state sync is mounted at the SettingsRoot level via
  // useWakeBroadcastSync(). No per-component subscription needed.

  const stats = heard.reduce(
    (acc, h) => {
      if (h.error) acc.errors++
      else if (h.matched) acc.matched++
      else if (h.text) acc.heard++
      else acc.silence++
      return acc
    },
    { matched: 0, heard: 0, silence: 0, errors: 0 }
  )

  /** Fires a one-off transcribe with a 1-second silence buffer to
   *  isolate the IPC path from the wake-word scan loop. Tells the user
   *  whether the bug is in the engine (loop not running / short-
   *  circuiting) or in the transcribe pipeline (model not loaded /
   *  IPC broken). */
  const handleTestTranscribe = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const sampleRate = 16_000
      const pcm = new Float32Array(sampleRate) // 1 second of silence
      const t0 = performance.now()
      const result = await vs.ai.transcribe({ pcm, sampleRate })
      const ms = Math.round(performance.now() - t0)
      if (result.error) {
        setTestResult(`error (${ms}ms): ${result.error}`)
        pushToast('error', `Transcribe failed: ${result.error}`)
      } else if (!result.text) {
        setTestResult(`ok (${ms}ms): empty text — model loaded, mic input was silence`)
        pushToast('success', 'Transcribe IPC works. Model is loaded.')
      } else {
        setTestResult(`ok (${ms}ms): "${result.text}"`)
        pushToast('success', `Transcribe returned: "${result.text}"`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestResult(`threw: ${msg}`)
      pushToast('error', `Transcribe threw: ${msg}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mt-2 rounded-md border border-white/5 bg-black/20 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          What Whisper heard
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleTestTranscribe()}
            disabled={testing}
            className="rounded-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/15 disabled:opacity-50"
          >
            {testing ? 'testing…' : 'Test transcribe'}
          </button>
          {heard.length > 0 && (
            <button
              type="button"
              onClick={() => clear()}
              className="text-[9px] text-slate-500 transition hover:text-slate-300"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* v1.7.3 — Always-on diagnostics. Shows the scan counter +
       *  most-recent short-circuit reason whether or not any events
       *  have fired. If Scans=0 after the engine reports listening,
       *  the loop isn't running. If Scans>0 but no events, every scan
       *  is short-circuiting — reason shows why. */}
      <p className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[9px] text-slate-500">
        <span className={scans === 0 ? 'text-rose-300' : 'text-slate-300'}>
          Scans: {scans}
        </span>
        {heard.length > 0 && (
          <>
            <span className="text-emerald-400">· {stats.matched} matched</span>
            <span>· {stats.heard} heard</span>
            <span>· {stats.silence} silent</span>
            {stats.errors > 0 && <span className="text-rose-300">· {stats.errors} errors</span>}
          </>
        )}
      </p>
      {blockedReason && (
        <p className="mb-1 truncate font-mono text-[9px] text-amber-300">
          Last block: {blockedReason}
        </p>
      )}
      {testResult && (
        <p className="mb-1 truncate font-mono text-[9px] text-cyan-200">
          Test transcribe: {testResult}
        </p>
      )}
      {heard.length === 0 ? (
        <p className="text-[10px] italic text-slate-500">
          {scans === 0
            ? "Scan loop hasn't fired yet. If this stays at 0 for more than 10 seconds, the engine isn't actually running — check the activity log."
            : 'Scan loop is alive. Waiting on a transcription or silence beat (every ~9s).'}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {heard.map((h) => {
            const isError = Boolean(h.error)
            const isSilence = !h.error && !h.text && !h.matched
            return (
              <li
                key={h.at}
                className={cn(
                  'flex items-baseline gap-1.5 truncate font-mono text-[10px]',
                  isError
                    ? 'text-rose-300'
                    : h.matched
                      ? 'text-emerald-300'
                      : isSilence
                        ? 'text-cyan-500/60'
                        : 'text-slate-400'
                )}
              >
                <span className="shrink-0 text-[8px] text-slate-600">
                  {new Date(h.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </span>
                <span className="truncate">
                  {isError
                    ? `error: ${h.error}`
                    : isSilence
                      ? '(silence — engine alive, mic quiet)'
                      : h.text}
                </span>
                {h.matched && (
                  <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1 text-[8px] uppercase tracking-wide">
                    match
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-1 text-[9px] leading-relaxed text-slate-500">
        Green = matched. Grey = heard but no match. Cyan = silence beat
        (proves the engine is alive). Red = transcribe error — check the activity log.
      </p>
    </div>
  )
}
