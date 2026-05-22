/**
 * Voice settings: enable spoken replies and bind the two personas — Void and
 * Soul — to concrete system speech-synthesis voices, with a test button each.
 */
import { useEffect, useReducer, useState } from 'react'
import { Play, FolderOpen, Ear, Sparkles, ExternalLink } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore } from '../../store/useWidgetStore'
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
      voice.rate,
      voice.volume
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

      <NeuralVoiceTip />


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

      {/* Separate from the OS / app volume mixer — lets users dial Void/Soul
          down without muting everything else from the app. 0 silences TTS but
          the queue still runs; flip the "Spoken replies" toggle off to stop
          scheduling utterances entirely. */}
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

      <p className="text-[10px] leading-relaxed text-slate-500">
        Active persona: <span className="uppercase text-[var(--accent)]">{voice.persona}</span> —
        switch between Void and Soul from the Nexus HUD. Voices come from your operating system.
      </p>

      <WakeWordRow voice={voice} />
    </CollapsibleSection>
  )
}

/**
 * Per-session arm switch for the wake-word engine. Sits under the toggle —
 * the toggle controls the persisted preference, this controls whether the
 * mic is actually hot RIGHT NOW. Resets to disarmed on every app launch
 * so the user always opts in fresh; this is the signal that prevents the
 * "panel opens and the orb pulses as if recording me" reaction.
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

/**
 * Beta-tester nudge for the "voices sound robotic" complaint. Windows ships
 * the older SAPI defaults (David / Mark / Zira) on a fresh install — the
 * modern "* Online (Natural)" voices (Aria, Guy, Jenny…) live behind a
 * one-click install in Windows Settings. macOS has a similar Premium /
 * Enhanced voice download path under Accessibility → Spoken Content.
 *
 * The banner is platform-aware:
 *  · Windows — copy targets Aria/Guy + a button that deep-links to
 *    `ms-settings:speech`, the Speech settings page (no further clicks).
 *  · macOS — copy points at System Settings → Accessibility → Spoken
 *    Content → System Voice → Manage Voices.
 *  · Linux — generic note; voice quality is distro-dependent.
 *
 * Once the user installs a new voice, `onVoicesChanged` in voice.ts
 * fires and the VoicePicker selects refresh with the new entries
 * available — no app restart needed.
 */
// `navigator.userAgent` is constant for the renderer's lifetime — compute the
// platform booleans once at module scope so we don't redo the lowercase +
// includes on every settings re-render.
const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase()
const IS_WINDOWS = UA.includes('windows')
const IS_MAC = UA.includes('mac os')

function NeuralVoiceTip(): JSX.Element {
  const openSpeechSettings = (): void => {
    // Speech → Add voices installs additional SAPI language packs. This is
    // the only Windows path that adds voices visible to the Web Speech API
    // that Electron uses. The Narrator "Natural HD" voices (Andrew, Ava,
    // Brian, Emma) live in a private Microsoft pipeline and don't surface
    // here — see the banner copy below for why.
    if (IS_WINDOWS) {
      window.open('ms-settings:speech', '_blank')
    } else if (IS_MAC) {
      window.open('x-apple.systempreferences:com.apple.preference.universalaccess', '_blank')
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles size={12} className="text-[var(--accent)]" />
        <p className="text-[12px] font-semibold text-white">Want smoother voices?</p>
      </div>

      {IS_WINDOWS ? (
        <>
          {/* Honest framing: the new Microsoft "Natural HD" voices (Andrew,
              Ava, Brian, Emma) installed via Narrator are gated behind a
              private API that no third-party app can reach — not via SAPI,
              not via WinRT, not even via the undocumented Edge cloud
              endpoint (Microsoft has hardened it against scraping). We
              point users at Speech → Add voices, which actually does
              install additional SAPI voices we can use. Linking honestly
              beats sending them down a 30-minute install dead-end. */}
          <p className="mb-1.5 text-[10px] leading-relaxed text-slate-300">
            VoidSoul uses the Web Speech API, which reads voices from the Windows{' '}
            <span className="text-[var(--accent)]">SAPI</span> registry. Speech → Add voices lets
            you install extra language packs (e.g., English UK, Australian, Indian) that come with
            their own SAPI voices.
          </p>
          <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
            <span className="font-semibold text-slate-300">Heads up:</span> the new{' '}
            <span className="text-slate-200">Natural HD</span> voices (Andrew, Ava, Brian, Emma)
            installed via Narrator are NOT exposed to third-party apps — Microsoft has kept them
            private to Narrator. We can&apos;t access them, and neither can Chrome or any other
            non-Microsoft app.
          </p>
        </>
      ) : IS_MAC ? (
        <p className="mb-2 text-[10px] leading-relaxed text-slate-300">
          macOS Premium / Enhanced voices sound far smoother than the basic defaults. Install them
          under System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
        </p>
      ) : (
        <p className="mb-2 text-[10px] leading-relaxed text-slate-300">
          Voice quality depends on your distro&apos;s speech synthesis backend. Installing
          espeak-ng-mbrola or Mimic 3 gives noticeably more natural results than the espeak default.
        </p>
      )}

      {(IS_WINDOWS || IS_MAC) && (
        <button
          type="button"
          onClick={openSpeechSettings}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-medium text-slate-200 transition hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)] hover:text-white"
        >
          {IS_WINDOWS ? 'Open Windows Speech settings' : 'Open Accessibility settings'}
          <ExternalLink size={9} />
        </button>
      )}
    </div>
  )
}
