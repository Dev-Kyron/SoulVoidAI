/**
 * Voice settings — v1.2.0 (Piper edition).
 *
 * Two voice cards (Void / Soul) show the .onnx model picked up from each
 * persona's folder under `<userData>/voices/<persona>/`, with a preview
 * button that synthesises a one-sentence sample. The legacy SAPI voice
 * picker is gone — Piper voices are bundled neural models, not OS voice
 * dropdowns, so there's no "pick from a system list" surface to expose.
 *
 * A credit / promo strip at the bottom links out to rhasspy/piper —
 * Michael Hansen's work is what makes this whole feature possible, and
 * the user explicitly asked for the attribution to be visible.
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
  Sparkles,
  Volume2
} from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore } from '../../store/useWidgetStore'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { speak } from '../../lib/voice'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { Ear } from 'lucide-react'
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

  return (
    <CollapsibleSection
      title="Voice"
      hint="Spoken replies powered by Piper TTS — neural voices that run locally on your machine. No cloud, no API key, no rate limits."
    >
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
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-slate-500">
        Active persona: <span className="uppercase text-[var(--accent)]">{voice.persona}</span> —
        switch between Void and Soul from the Nexus HUD.
      </p>

      <PiperCredit />

      <WakeWordRow voice={voice} />
    </CollapsibleSection>
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
        onClick={() => setArmed(!armed)}
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

function WakeWordRow({ voice }: { voice: VoiceConfig }): JSX.Element {
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
    <div className="mt-3 border-t border-white/5 pt-2">
      <div className="mb-1 flex items-center justify-between py-1">
        <div className="flex items-center gap-1.5">
          <Ear size={12} className="text-[var(--accent)]" />
          <p className="text-[12px] text-slate-200">Wake word</p>
        </div>
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
    </div>
  )
}
