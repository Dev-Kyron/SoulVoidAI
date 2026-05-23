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

  async function scan(): Promise<void> {
    if (stopped || !ring) return
    if (performance.now() < cooldownUntil) return
    // Skip while voice input is actively capturing — both code paths open
    // their own mic stream, and running Whisper on the user's actual
    // question would trigger another wake-detect on its own contents.
    if (useVoiceInputStore.getState().status !== 'idle') return
    if (!scanLock.tryAcquire()) return
    try {
      const pcm = snapshot()
      if (!pcm) return
      const result = await vs.ai.transcribe({ pcm, sampleRate: SAMPLE_RATE })
      // `stop()` can have run during the await — re-check both the stopped
      // flag and the ring reference (which `stop()` nulls). Without this,
      // the ring.fill(0) below would NPE on a stop-mid-transcribe.
      if (stopped || !ring) return
      if (result.error || !result.text) return
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
      // Transcription failed (model download issue, worker crash, partial
      // hf-cache). Log at warn level so users with wake-word that mysteriously
      // never fires have something to find in the activity log — silent
      // swallow meant a permanently-broken wake-word looked identical to
      // "user isn't speaking".
      void vs.logs.write(
        'warn',
        'system',
        'Wake-word scan transcribe failed',
        err instanceof Error ? err.message : String(err)
      )
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
