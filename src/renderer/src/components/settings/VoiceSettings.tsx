/**
 * Voice settings: enable spoken replies and bind the two personas — Void and
 * Soul — to concrete system speech-synthesis voices, with a test button each.
 */
import { useEffect, useReducer, useState } from 'react'
import { Play, FolderOpen, Ear } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { availableVoices, guessVoice, onVoicesChanged, speak } from '../../lib/voice'
import { vs } from '../../lib/bridge'
import type { VoiceConfig, VoicePersona } from '@shared/types'

function VoicePicker({
  persona,
  voice,
  onPick
}: {
  persona: VoicePersona
  voice: VoiceConfig
  onPick: (uri: string) => void
}): JSX.Element {
  const voices = availableVoices()
  const current = (persona === 'void' ? voice.voidVoiceURI : voice.soulVoiceURI) || guessVoice(persona)

  const test = (): void => {
    speak(
      persona === 'void' ? 'This is the Void voice.' : 'This is the Soul voice.',
      current,
      voice.rate
    )
  }

  return (
    <div className="mb-2">
      <label className="mb-1 block text-[10px] text-slate-400">
        {persona === 'void' ? 'Void voice (male)' : 'Soul voice (female)'}
      </label>
      <div className="flex gap-1.5">
        <select
          value={current}
          onChange={(e) => onPick(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
        >
          {voices.length === 0 && <option>Loading system voices…</option>}
          {voices.map((v) => (
            <option key={v.uri} value={v.uri} className="bg-void-700">
              {v.name} · {v.lang}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={test}
          title="Test voice"
          className="flex w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:bg-white/5"
        >
          <Play size={13} />
        </button>
      </div>
    </div>
  )
}

export function VoiceSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setVoice = useConfigStore((s) => s.setVoice)
  const [, refresh] = useReducer((n: number) => n + 1, 0)

  // System voices populate asynchronously — re-render when they arrive.
  useEffect(() => onVoicesChanged(refresh), [])

  if (!config) return null
  const voice = config.voice

  return (
    <CollapsibleSection
      title="Voice"
      hint="Spoken replies in two voices — Void and Soul. Voice input transcribes locally via Whisper-tiny (downloads ~75 MB on first use); add an OpenAI or Gemini key for higher-quality cloud transcription."
    >
      <div className="flex items-center justify-between py-1.5">
        <div>
          <p className="text-[12px] text-slate-200">Spoken replies</p>
          <p className="text-[10px] text-slate-500">Read assistant responses aloud</p>
        </div>
        <Toggle
          checked={voice.enabled}
          onChange={(enabled) =>
            void setVoice({
              enabled,
              voidVoiceURI: voice.voidVoiceURI || guessVoice('void'),
              soulVoiceURI: voice.soulVoiceURI || guessVoice('soul')
            })
          }
        />
      </div>

      <VoicePicker
        persona="void"
        voice={voice}
        onPick={(uri) => void setVoice({ voidVoiceURI: uri })}
      />
      <VoicePicker
        persona="soul"
        voice={voice}
        onPick={(uri) => void setVoice({ soulVoiceURI: uri })}
      />

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

      <p className="text-[10px] leading-relaxed text-slate-500">
        Active persona: <span className="uppercase text-[var(--accent)]">{voice.persona}</span> —
        switch between Void and Soul from the Nexus HUD. Voices come from your operating system.
      </p>

      <WakeWordRow voice={voice} />
    </CollapsibleSection>
  )
}

function WakeWordRow({ voice }: { voice: VoiceConfig }): JSX.Element {
  const setVoice = useConfigStore((s) => s.setVoice)
  const pushToast = useUiStore((s) => s.pushToast)
  const [hasKey, setHasKey] = useState(false)
  const [voidPpn, setVoidPpn] = useState(false)
  const [soulPpn, setSoulPpn] = useState(false)

  const refresh = async (): Promise<void> => {
    // allSettled so one missing .ppn file or a secrets-bridge hiccup doesn't
    // blank the whole row of badges. Each result is treated independently.
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
    pushToast(
      'info',
      'Drop void.ppn / soul.ppn here, then toggle the wake word off and on.'
    )
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
            // No Picovoice key required — the router falls back to the
            // local Whisper engine when there's no key. The mic permission
            // gate is the only hard prerequisite.
            void (async () => {
              // Engine boot calls getUserMedia immediately — fail loudly here
              // if the Microphone permission isn't granted, otherwise the
              // engine errors silently and the toggle stays "on" with nothing
              // actually listening.
              const perms = useConfigStore.getState().config?.permissions
              if (!perms?.microphone.granted) {
                const granted = await useUiStore
                  .getState()
                  .promptPermission('microphone', 'Wake word')
                if (!granted) {
                  pushToast(
                    'info',
                    'Microphone permission is needed for wake word.'
                  )
                  return
                }
                // Go through the store, not the bridge directly: the IPC
                // handler intentionally skips broadcasting to the sender
                // window, so this is what actually patches local state. A
                // raw vs.permissions.set leaves the next read in the same
                // window seeing the stale "not granted" value, which is
                // why the toggle used to silently re-prompt forever.
                await useConfigStore.getState().setPermission('microphone', true)
              }
              await setVoice({ wakeWord: { enabled: true } })
            })()
          }}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        Continuous listening for "Hey Void" / "Hey Soul". Works keyless via the local Whisper
        model (~75 MB, downloads once — same model used for voice input). With a Picovoice
        access key, the engine upgrades to Porcupine for lower CPU and faster detection;
        custom .ppn keyword files dropped in the wake-words folder override the defaults.
      </p>
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
