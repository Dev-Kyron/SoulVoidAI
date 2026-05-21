/**
 * Wake-word orchestrator. Picks one of two engines based on whether the user
 * has paid the Picovoice signup tax:
 *
 *   - **Whisper-based engine** (default, keyless) — reuses the local
 *     Whisper-tiny model already shipped for voice input. No setup, no
 *     account, matches arbitrary phrases. See `wakeword/whisper.ts` for the
 *     detailed rationale.
 *   - **Porcupine engine** (upgrade) — runs when a Picovoice access key is
 *     configured. Lower CPU + lower detection latency, but requires the
 *     external signup.
 *
 * On detection, fires the existing push-to-talk capture flow so the user can
 * speak their question immediately — same UX shape for either engine.
 *
 * Race safety: a generation counter guards against fast on/off toggles. If
 * the user flips the toggle before a boot finishes, the half-built engine
 * is torn down on the spot instead of being left subscribed to the mic
 * alongside the latest one. Both engines expose `stop()` so the router can
 * roll them back cleanly via the standard interface.
 */
import { useEffect } from 'react'
import { vs } from './bridge'
import { useConfigStore } from '../store/useConfigStore'
import { useWidgetStore } from '../store/useWidgetStore'
import { useUiStore } from '../store/useUiStore'
import { useVoiceInputStore } from '../store/useVoiceInputStore'
import { isQuietNow, type VoicePersona } from '@shared/types'
import { createWhisperWakeEngine } from './wakeword/whisper'
import { createPorcupineWakeEngine } from './wakeword/porcupine'
import type { WakeEngine } from './wakeword/types'

let activeEngine: WakeEngine | null = null
/** Bumped on every boot/shutdown; engines started for stale generations are dropped. */
let bootGen = 0
/**
 * Has the local Whisper model been loaded into the worker this session? After
 * the first successful warmup (or any other transcribe call) subsequent
 * boots skip the "preparing model" toast — the cost is gone.
 */
let whisperModelWarm = false

async function shutdown(): Promise<void> {
  bootGen++
  useWidgetStore.getState().setWakeListening(false)
  if (!activeEngine) return
  const engine = activeEngine
  activeEngine = null
  await engine.stop().catch(() => {
    /* best-effort */
  })
}

async function boot(): Promise<void> {
  await shutdown()
  const generation = ++bootGen

  // Engine selection: a stored Picovoice key opts the user into Porcupine.
  // Anyone else gets the keyless Whisper engine — which works out of the
  // box assuming the user has done at least one voice-input call (so the
  // Whisper model has been downloaded) OR is willing to wait through the
  // ~75 MB cold-download on first wake detection.
  const picovoiceKey = await vs.secrets.get('picovoice')
  if (generation !== bootGen) return

  const engine = picovoiceKey
    ? createPorcupineWakeEngine(picovoiceKey, onWakeDetected)
    : createWhisperWakeEngine(onWakeDetected)

  // Whisper-engine cold path: the first transcribe call has to download
  // ~75 MB of model weights, taking 5-15s on a typical connection. Without
  // a heads-up the orb shows the "listening" pulse for that whole window
  // while the engine is actually waiting on the worker — visual lie.
  //
  // Warmup with a 100ms silent PCM buffer to trigger the model load BEFORE
  // we flip the orb. If the model's already cached this is a ~50ms no-op.
  // If it isn't, the toast tells the user what's happening.
  if (!picovoiceKey) {
    const warmupNeeded = !whisperModelWarm
    if (warmupNeeded) {
      useUiStore
        .getState()
        .pushToast('info', 'Preparing wake-word model (one-time download)…')
    }
    try {
      await vs.ai.transcribe({ pcm: new Float32Array(1600), sampleRate: 16_000 })
      whisperModelWarm = true
      if (generation !== bootGen) return
    } catch {
      // If warmup failed (no provider key, network down, etc.) the engine's
      // first real scan will surface the same error — let it. Skipping the
      // toast on the actual start path keeps the failure mode singular.
    }
  }

  // Flip the orb baseline BEFORE engine.start() so the wake-listening pulse
  // shows up on the same frame the user toggled the switch — start() can
  // take ~50-300ms (mic permission, AudioContext init). The catch block
  // below rolls this back if start fails.
  useWidgetStore.getState().setWakeListening(true)
  try {
    await engine.start()
    if (generation !== bootGen) {
      // Lost the race — user toggled off (or a second boot is in flight)
      // before we finished starting. Roll back the half-built engine.
      await engine.stop().catch(() => {
        /* best-effort */
      })
      useWidgetStore.getState().setWakeListening(false)
      return
    }
    activeEngine = engine
    void vs.logs.write(
      'success',
      'system',
      `Wake-word engine listening (${picovoiceKey ? 'Porcupine' : 'Whisper'}).`
    )
  } catch (err) {
    useWidgetStore.getState().setWakeListening(false)
    void vs.logs.write(
      'error',
      'system',
      'Wake-word engine failed to start',
      err instanceof Error ? err.message : String(err)
    )
    useUiStore
      .getState()
      .pushToast(
        'error',
        `Wake word could not start: ${err instanceof Error ? err.message : 'unknown error'}`
      )
  }
}

async function onWakeDetected(persona: VoicePersona, label: string): Promise<void> {
  const cfg = useConfigStore.getState()
  // Honour DND — wake word still listens, but suppresses the response so a
  // quiet-hours user isn't surprised by audio when they didn't intend it.
  if (cfg.config && isQuietNow(cfg.config.appearance.dnd)) return

  useUiStore.getState().pushToast('info', `"${label}" — listening.`)

  // Swap persona if the matched phrase belongs to the other voice.
  if (cfg.config && cfg.config.voice.persona !== persona) {
    await cfg.setVoice({ persona })
  }
  // Kick the existing push-to-talk capture flow. The orb states (
  // wake-listening → listening → processing → speaking) make the loop
  // visible without forcing the panel open.
  const voice = useVoiceInputStore.getState()
  if (voice.status === 'idle') void voice.toggle()
}

/**
 * Mounts (and tears down) the wake-word engine based on TWO gates:
 *
 *   1. `voice.wakeWord.enabled`  (persisted setting — user wants the feature)
 *   2. `wakeArmed`               (per-session flag — user has explicitly armed)
 *
 * Both must be true for the engine to start. The session flag defaults to
 * `false` on every app launch even if the persisted setting is on; users
 * arm via the orb context menu or the Voice settings page. This avoids the
 * "panel opens and looks like it's recording me" reaction that beta testers
 * had — the mic only goes hot after explicit per-session consent.
 *
 * Re-runs when either gate flips. While disabled, neither engine's modules
 * are imported — the lazy chunks stay out of the initial bundle.
 */
export function useWakeWord(): void {
  const enabled = useConfigStore((s) => s.config?.voice.wakeWord.enabled ?? false)
  const armed = useWidgetStore((s) => s.wakeArmed)

  useEffect(() => {
    if (!enabled || !armed) {
      void shutdown()
      return
    }
    void boot()
    return () => {
      void shutdown()
    }
  }, [enabled, armed])
}
