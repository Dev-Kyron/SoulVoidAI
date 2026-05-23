/**
 * Whisper-based wake-word engine. Reuses the local Whisper-tiny.en pipeline
 * already shipped for voice input (no new model download, no new dependency)
 * by running a rolling-buffer transcription scan and pattern-matching the
 * output against the configured wake phrases.
 *
 * **Why not Porcupine / Vosk / OpenWakeWord:**
 *  - Porcupine — gold standard for efficiency but requires a Picovoice
 *    account + .ppn keyword files. Bad for plug-and-play. Kept as opt-in for
 *    users with a key.
 *  - Vosk-browser — would work, but means a +40 MB model download on top of
 *    the 75 MB Whisper we already ship. Maintenance has been quiet since
 *    2022. Net: more bytes, no quality win.
 *  - OpenWakeWord — best-in-class for the task, but no first-class JS port;
 *    a custom onnxruntime-web pipeline (mel-spec → embedding → classifier)
 *    is ~2 sessions of fiddly work.
 *  - **Whisper rolling-buffer (this file)** — reuses what's already on disk,
 *    matches arbitrary phrases without retraining, ships in one session.
 *
 * **Trade-offs to know:**
 *  - Higher CPU than Porcupine — one Whisper-tiny inference per second per
 *    user with wake word enabled. ~80-150ms inference on a modern CPU, so
 *    well under 20% of one core continuously.
 *  - Slightly higher latency to detection (~0.5-1.5s) due to window/scan
 *    timing. Porcupine fires within 100ms; this lands in the second after
 *    the user finishes the phrase.
 *  - Echo cancellation from getUserMedia handles most self-trigger from TTS
 *    playback. Post-detection cooldown also gates that.
 */
import { vs } from '../bridge'
import { createLock } from '../utils'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { stopSpeaking } from '../voice'
import { matchWakePhrase } from './match'
import { useConfigStore } from '../../store/useConfigStore'
import { isQuietNow } from '@shared/types'
import type { WakeDetectCallback, WakeEngine, WakeHeardCallback } from './types'
import { useWidgetStore } from '../../store/useWidgetStore'
import { relayWakeState as relayDiagnostic } from '../wakeBridge'

/** Whisper's native sample rate; AudioContext resamples the mic to match. */
const SAMPLE_RATE = 16_000
/** Length of audio we transcribe each scan. Long enough to catch a 2-word phrase. */
const WINDOW_SECONDS = 1.6
/** How often to run a scan. Lower = lower detection latency, higher CPU. */
const SCAN_INTERVAL_MS = 900
/**
 * After a successful detection, ignore the buffer for this long so the user's
 * actual question (which follows the wake phrase) doesn't accidentally fire
 * another wake — and so TTS playback that follows can't loop back via the
 * mic and re-trigger.
 */
const POST_DETECTION_COOLDOWN_MS = 3000

/**
 * RMS threshold and sustain window for the barge-in detector. When the
 * assistant is speaking and the mic picks up sustained energy above this
 * floor for {@link BARGE_IN_SUSTAIN_MS}, the TTS is cut so the user can
 * interject without having to wait the sentence out — same UX as ChatGPT
 * voice mode. The threshold is calibrated above echo-cancelled TTS bleed
 * (which typically lands around 0.005-0.01 RMS) so playback alone doesn't
 * trigger it; a real spoken word reaches ~0.05-0.15.
 */
const BARGE_IN_RMS = 0.05
const BARGE_IN_SUSTAIN_MS = 250

// `matchWakePhrase` and its pattern set live in `./match` so the pure
// matching logic can be tested without dragging in the audio/store deps
// this engine pulls.

export function createWhisperWakeEngine(
  onDetect: WakeDetectCallback,
  onHeard?: WakeHeardCallback
): WakeEngine {
  let stream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  /** Circular buffer of {@link WINDOW_SECONDS} of 16kHz mono PCM. */
  let ring: Float32Array | null = null
  /**
   * Reusable scratch buffer for `snapshot()` — same shape as `ring`. Saves
   * ~100 KB of allocation per scan tick (1 Hz) when wake-word is armed; the
   * transcribe IPC structured-clones the payload so reusing this buffer is
   * safe between awaited calls (serialized by the lock).
   */
  let snapshotScratch: Float32Array | null = null
  let writePos = 0
  // `window.setInterval` returns number in the DOM lib while `setInterval`
  // resolves to NodeJS.Timeout in the Node lib; we want the former so
  // `clearInterval` works without a cast. The browser's interval id is
  // always a number, so `number | undefined` is the simplest correct type.
  let scanTimer: number | undefined
  /** Single-occupant lock — same helper used by conversationSummarizer. */
  const scanLock = createLock()
  /** performance.now() value before which scans short-circuit. */
  let cooldownUntil = 0
  let stopped = false

  /**
   * Copies the ring buffer into a contiguous time-ordered Float32Array so
   * transcription sees the audio in real-world order (oldest first). Reuses
   * `snapshotScratch` between calls.
   */
  function snapshot(): Float32Array | null {
    if (!ring) return null
    if (!snapshotScratch || snapshotScratch.length !== ring.length) {
      snapshotScratch = new Float32Array(ring.length)
    }
    const out = snapshotScratch
    const tailLen = ring.length - writePos
    out.set(ring.subarray(writePos), 0)
    out.set(ring.subarray(0, writePos), tailLen)
    return out
  }

  // v1.7.2 — silence-beat counter. We don't want to flood the diagnostic
  // ticker with a "(silence)" entry every 900ms (it'd be unreadable), but
  // we DO want occasional heartbeat entries so the user can tell the
  // engine is alive when their wake phrase isn't being heard at all.
  // Fire one silence beat every SILENCE_BEAT_EVERY silent scans
  // (~every 9s at the default cadence). Both VAD-gated and Whisper-
  // returned-empty scans count as "silent".
  const SILENCE_BEAT_EVERY = 10
  let silentStreak = 0

  /** Count one silent scan; emit the heartbeat event once per
   *  SILENCE_BEAT_EVERY ticks. Shared so the VAD-skipped path and the
   *  Whisper-returned-empty path stay in sync on a single counter. */
  const tickSilenceBeat = (): void => {
    silentStreak++
    if (silentStreak >= SILENCE_BEAT_EVERY) {
      silentStreak = 0
      onHeard?.('', false)
    }
  }

  // v1.7.5 — VAD pre-filter. Whisper's training was heavily YouTube-
  // weighted, so feeding it ~1.6 seconds of mostly-silence reliably
  // produces hallucinated transcriptions like "Thank you for watching"
  // / "Bye" / "Please subscribe" / 🤩 emoji runs. Those then get
  // logged as "heard" in the diagnostic but never match a wake phrase
  // because the user wasn't actually saying anything.
  //
  // The fix: check the RMS energy of the audio buffer BEFORE calling
  // transcribe. If it's below the threshold, the buffer is silence —
  // skip Whisper entirely. Saves a transcribe IPC + worker round-trip
  // per silent scan AND eliminates the hallucinations.
  //
  // 0.015 is calibrated for typical room noise vs spoken voice; bump
  // to ~0.025 for noisier environments at the cost of needing the user
  // to speak louder.
  const VAD_RMS_THRESHOLD = 0.015

  function computeRms(samples: Float32Array): number {
    let sumSq = 0
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
    return Math.sqrt(sumSq / samples.length)
  }

  async function scan(): Promise<void> {
    // v1.7.3 — count + reason logged on EVERY scan attempt, before any
    // short-circuit. Without this a wake-word loop that's stuck behind
    // a gate looks identical to a wake-word loop that isn't running at
    // all. The diagnostic panel in Wake Word settings reads from these
    // values, mirrored across renderer windows via `relayDiagnostic`.
    const widget = useWidgetStore.getState()
    const recordAndRelay = (reason: string | null): void => {
      widget.recordWakeScan(reason)
      relayDiagnostic()
    }
    if (stopped || !ring) {
      recordAndRelay(stopped ? 'engine stopped' : 'ring buffer not initialised')
      return
    }
    if (performance.now() < cooldownUntil) {
      recordAndRelay('post-detection cooldown')
      return
    }
    // Skip while voice input is actively capturing — both code paths open
    // their own mic stream, and running Whisper on the user's actual
    // question would trigger another wake-detect on its own contents.
    const voiceStatus = useVoiceInputStore.getState().status
    if (voiceStatus !== 'idle') {
      recordAndRelay(`voice input busy (${voiceStatus})`)
      return
    }
    if (!scanLock.tryAcquire()) {
      recordAndRelay('previous scan still in flight')
      return
    }
    try {
      const pcm = snapshot()
      if (!pcm) {
        recordAndRelay('snapshot returned null')
        return
      }
      // VAD pre-filter — skip Whisper entirely when the buffer is
      // silence. Eliminates the "Thank you for watching" / "Bye" /
      // emoji hallucinations that flood the diagnostic when nobody
      // is speaking. Counts toward silence-beats so the user still
      // sees the engine alive.
      const rms = computeRms(pcm)
      if (rms < VAD_RMS_THRESHOLD) {
        recordAndRelay(null)
        tickSilenceBeat()
        return
      }
      // Reached transcribe — clear any prior block reason.
      recordAndRelay(null)
      const result = await vs.ai.transcribe({ pcm, sampleRate: SAMPLE_RATE })
      // `stop()` can have run during the await — re-check both the stopped
      // flag and the ring reference (which `stop()` nulls). Without this,
      // the ring.fill(0) below would NPE on a stop-mid-transcribe.
      if (stopped || !ring) return
      if (result.error) {
        // Transcribe succeeded technically but the provider returned an
        // error envelope (worker not ready, model not loaded, etc).
        // Surface it to the diagnostic ticker so the user can SEE the
        // problem instead of staring at "Listening" with no feedback.
        onHeard?.('', false, result.error)
        return
      }
      if (!result.text) {
        // Whisper returned empty text (silence / inaudible). Emit a
        // throttled "silence beat" so the user knows the engine is
        // alive — without it, a stuck mic looks identical to a
        // working mic listening to a quiet room.
        tickSilenceBeat()
        return
      }
      silentStreak = 0
      const match = matchWakePhrase(result.text)
      // v1.7.1 — surface EVERY transcription to the diagnostic ticker
      // (whether matched or not). Lets users see "Hey Boyd" mishearings
      // in Settings → Voice → Wake word instead of silent failure.
      onHeard?.(result.text, Boolean(match))
      if (match) {
        // Cooldown FIRST so a slow downstream handler can't let the next
        // scan slip through and re-fire on the lingering tail of the
        // phrase still in the ring buffer.
        cooldownUntil = performance.now() + POST_DETECTION_COOLDOWN_MS
        ring.fill(0)
        onDetect(match.persona, match.label)
      }
    } catch (err) {
      // Transcription threw — IPC bridge crashed, structured-clone error,
      // etc. Log to the activity log AND surface to the diagnostic ticker
      // so the user has visibility from inside Settings.
      const msg = err instanceof Error ? err.message : String(err)
      onHeard?.('', false, msg)
      void vs.logs.write('warn', 'system', 'Wake-word scan transcribe failed', msg)
    } finally {
      scanLock.release()
    }
  }

  async function start(): Promise<void> {
    if (stream) return // already started — idempotent
    // Asking AudioContext for 16kHz directly is the cleanest way to guarantee
    // the rate Whisper wants — the browser resamples the mic input for us.
    // echoCancellation/noiseSuppression block most app-self-trigger from TTS.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    // v1.7.3 — explicitly resume. Chromium creates AudioContext in
    // `suspended` state unless tied to a fresh user-gesture frame; our
    // boot() chain awaits enough things (secrets.get, getUserMedia)
    // that the gesture context is lost by the time we get here. Without
    // resume(), processor.onaudioprocess NEVER fires, the ring buffer
    // stays zero-filled, and Whisper transcribes silence — which it
    // hallucinates as "you" because of training-data bias. Spent a week
    // chasing this masquerading as "mic not working".
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume()
      } catch {
        // Browser refused to resume; log via the diagnostic relay
        // so the Settings panel can surface it as an error row.
        useWidgetStore.getState().pushWakeHeard('', false, 'AudioContext could not resume')
        relayDiagnostic()
      }
    }
    source = audioCtx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated in favour of AudioWorklet, but worklets
    // require a separate worklet file URL that's awkward with electron-vite's
    // bundler. Wake-word's latency budget tolerates the main-thread cost.
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    ring = new Float32Array(Math.ceil(SAMPLE_RATE * WINDOW_SECONDS))
    writePos = 0

    let bargeInStartedAt = 0
    processor.onaudioprocess = (event) => {
      if (stopped || !ring) return
      const input = event.inputBuffer.getChannelData(0)
      // Only pay for VAD energy accumulation when TTS is actually playing
      // — the common case is "user isn't being talked at," and the
      // sample-multiply per frame adds up at ~10 Hz x 4096 samples.
      const ttsActive = window.speechSynthesis?.speaking ?? false
      let sumSq = 0
      for (let i = 0; i < input.length; i++) {
        const sample = input[i]
        ring[writePos] = sample
        writePos = (writePos + 1) % ring.length
        if (ttsActive) sumSq += sample * sample
      }
      // Barge-in: if the mic picked up sustained voice-level energy WHILE
      // the assistant is speaking, cut TTS so the user's interjection isn't
      // drowned out. Reset the sustain timer outside the TTS window so a
      // stale "almost barged in" timestamp can't fire on the next reply.
      if (!ttsActive) {
        bargeInStartedAt = 0
        return
      }
      const rms = Math.sqrt(sumSq / input.length)
      if (rms < BARGE_IN_RMS) {
        bargeInStartedAt = 0
        return
      }
      if (bargeInStartedAt === 0) bargeInStartedAt = performance.now()
      else if (performance.now() - bargeInStartedAt >= BARGE_IN_SUSTAIN_MS) {
        stopSpeaking()
        bargeInStartedAt = 0
        // Real "voice mode" feel: not only cut the assistant off but also
        // start capturing the user's follow-up — they shouldn't have to tap
        // mic AND speak. Honour DND so a quiet-hours user isn't surprised
        // by a mic prompt, and only trigger when the input store is idle
        // (a recording-in-progress already owns the mic).
        const cfg = useConfigStore.getState().config
        const dndActive = cfg ? isQuietNow(cfg.appearance.dnd) : false
        const voice = useVoiceInputStore.getState()
        if (!dndActive && voice.status === 'idle') void voice.toggle()
      }
    }

    source.connect(processor)
    // ScriptProcessor only fires onaudioprocess while connected to a
    // destination — connect to the audio context destination but rely on the
    // mic gain being near-zero through processor (we never write back).
    processor.connect(audioCtx.destination)

    scanTimer = window.setInterval(() => void scan(), SCAN_INTERVAL_MS)
  }

  async function stop(): Promise<void> {
    stopped = true
    if (scanTimer !== undefined) {
      window.clearInterval(scanTimer)
      scanTimer = undefined
    }
    if (processor) {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
      } catch {
        /* already disconnected */
      }
      processor = null
    }
    if (source) {
      try {
        source.disconnect()
      } catch {
        /* already disconnected */
      }
      source = null
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close().catch(() => {
        /* best-effort */
      })
    }
    audioCtx = null
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }
    ring = null
    snapshotScratch = null
  }

  return { start, stop }
}
