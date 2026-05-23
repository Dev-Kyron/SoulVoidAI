/**
 * Microphone capture for voice input. Records with MediaRecorder, then decodes
 * the webm/opus blob into 16kHz mono PCM via the Web Audio API so the main
 * process receives one consistent format regardless of which transcription
 * backend it routes to (cloud Whisper, Gemini, or local Whisper).
 *
 * Doing the decoding here avoids bundling an opus decoder into the Node main
 * process — Chromium already has a hardware-accelerated one.
 */

let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []

/** Silence-monitor handles — torn down on every stop/cancel. */
let silenceTimer: number | undefined
let silenceAudioCtx: AudioContext | null = null
let silenceAnalyser: AnalyserNode | null = null
let silenceSource: MediaStreamAudioSourceNode | null = null

/** 16kHz is Whisper's native sample rate, and what all three backends want. */
const TARGET_SAMPLE_RATE = 16_000

/**
 * Silence-detection defaults — voice-mode hands-free auto-stop.
 *
 * v1.7.4 adds this so users don't have to manually tap mic after speaking.
 * Tuning notes:
 *   · RMS threshold 0.015 catches normal indoor speech without picking
 *     up keyboard / fan noise. Bump to 0.025 for noisy environments.
 *   · 5s of sustained silence triggers stop — long enough for a natural
 *     pause mid-thought, short enough to feel responsive.
 *   · 16s "no voice ever" timeout prevents a stuck mic if the user
 *     never speaks at all (e.g. wake-word false positive).
 *   · Tick every 100ms — cheap RMS math, plenty fast for human-scale
 *     silence detection.
 */
const SILENCE_RMS_THRESHOLD = 0.015
const SILENCE_AFTER_VOICE_MS = 5_000
const NO_VOICE_TIMEOUT_MS = 16_000
const SILENCE_TICK_MS = 100

export interface RecordedAudioClip {
  /** Mono PCM, float32 in the range [-1, 1]. */
  pcm: Float32Array
  /** Always {@link TARGET_SAMPLE_RATE} — kept on the wire so main doesn't assume. */
  sampleRate: number
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return 'audio/webm'
}

function releaseStream(): void {
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
}

/**
 * Decodes an encoded audio blob into mono PCM at {@link TARGET_SAMPLE_RATE}.
 * Uses OfflineAudioContext for resampling so the result is deterministic and
 * matches what Whisper expects — float32, single channel, 16kHz.
 */
async function decodeBlobToPcm(blob: Blob): Promise<Float32Array> {
  const buffer = await blob.arrayBuffer()
  // First decode at the native sample rate so we don't double-resample.
  const decodeCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(buffer)
  } finally {
    void decodeCtx.close()
  }

  // Render into a mono 16kHz OfflineAudioContext — letting Web Audio do
  // both the channel downmix AND the resample saves a hand-rolled sum-mono
  // pass. The OfflineCtx applies equal-power downmixing automatically when
  // the source has more channels than the destination.
  const targetLength = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE))
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE)
  const source = offlineCtx.createBufferSource()
  source.buffer = decoded
  source.connect(offlineCtx.destination)
  source.start(0)
  const rendered = await offlineCtx.startRendering()
  // `.slice()` detaches from the OfflineCtx so the typed array survives GC.
  return rendered.getChannelData(0).slice()
}

export interface RecordingOptions {
  /**
   * Called when the silence-detector decides recording should auto-stop
   * (5s of silence after at least one moment of voice, OR 16s with no
   * voice at all). Caller should invoke their normal stop path
   * (`useVoiceInputStore.toggle()`) which decodes + sends the audio.
   *
   * Omit to disable silence-stop and require manual stop.
   */
  onSilenceAutoStop?: () => void
}

export async function startRecording(options?: RecordingOptions): Promise<void> {
  // Re-entrancy guard: a rapid second call would otherwise orphan the prior
  // MediaStream's tracks without stopping them (mic stays hot until GC).
  // Tear down any leftover state first so the new recording owns the mic.
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null
    recorder.stop()
  }
  stopSilenceMonitor()
  releaseStream()
  recorder = null
  chunks = []

  stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.start()

  // v1.7.4 — start a parallel silence monitor on the same mic stream
  // so the recording auto-stops after the user finishes speaking. This
  // is the hands-free voice-mode UX (wake → speak → silence → send),
  // matching ChatGPT/Claude's voice-mode pattern. The onSilenceAutoStop
  // callback decides what stop-and-send path to take.
  if (options?.onSilenceAutoStop) {
    startSilenceMonitor(options.onSilenceAutoStop)
  }
}

/**
 * Watches the live mic stream for RMS audio level. Calls `onTrigger`
 * exactly once when silence has been sustained long enough to count as
 * "user finished talking". Self-cleans on trigger.
 */
function startSilenceMonitor(onTrigger: () => void): void {
  if (!stream) return
  try {
    silenceAudioCtx = new AudioContext()
    silenceSource = silenceAudioCtx.createMediaStreamSource(stream)
    silenceAnalyser = silenceAudioCtx.createAnalyser()
    silenceAnalyser.fftSize = 1024
    silenceSource.connect(silenceAnalyser)
  } catch {
    // AudioContext refused — best-effort, recording still works without
    // silence-detection. User can still tap mic to stop manually.
    return
  }

  const buf = new Float32Array(silenceAnalyser.fftSize)
  const startedAt = performance.now()
  let voiceFirstHeardAt = 0
  let silenceStartedAt = 0
  let fired = false

  silenceTimer = window.setInterval(() => {
    if (fired || !silenceAnalyser) return
    silenceAnalyser.getFloatTimeDomainData(buf)
    let sumSq = 0
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i]
    const rms = Math.sqrt(sumSq / buf.length)
    const now = performance.now()

    if (rms > SILENCE_RMS_THRESHOLD) {
      // Voice — note the first moment so we know whether the user has
      // actually said anything yet (vs total silence from the start).
      if (voiceFirstHeardAt === 0) voiceFirstHeardAt = now
      silenceStartedAt = 0
    } else {
      if (silenceStartedAt === 0) silenceStartedAt = now
      const silenceFor = now - silenceStartedAt
      const sessionFor = now - startedAt
      const trigger =
        // Post-speech silence — natural end of utterance.
        (voiceFirstHeardAt > 0 && silenceFor >= SILENCE_AFTER_VOICE_MS) ||
        // Never-spoke-at-all timeout — stops a stuck mic if wake-word
        // fired but user didn't follow up.
        (voiceFirstHeardAt === 0 && sessionFor >= NO_VOICE_TIMEOUT_MS)
      if (trigger) {
        fired = true
        stopSilenceMonitor()
        onTrigger()
      }
    }
  }, SILENCE_TICK_MS)
}

function stopSilenceMonitor(): void {
  if (silenceTimer !== undefined) {
    clearInterval(silenceTimer)
    silenceTimer = undefined
  }
  if (silenceSource) {
    try {
      silenceSource.disconnect()
    } catch {
      /* already disconnected */
    }
    silenceSource = null
  }
  silenceAnalyser = null
  if (silenceAudioCtx && silenceAudioCtx.state !== 'closed') {
    void silenceAudioCtx.close().catch(() => {
      /* best-effort */
    })
  }
  silenceAudioCtx = null
}

/** Stops recording, decodes to PCM, resolves with the clip (or null if empty). */
export function stopRecording(): Promise<RecordedAudioClip | null> {
  stopSilenceMonitor()
  return new Promise((resolve, reject) => {
    const active = recorder
    if (!active || active.state === 'inactive') {
      releaseStream()
      recorder = null
      resolve(null)
      return
    }
    active.onstop = async () => {
      releaseStream()
      recorder = null
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      const blob = new Blob(chunks, { type: active.mimeType })
      chunks = []
      try {
        const pcm = await decodeBlobToPcm(blob)
        resolve({ pcm, sampleRate: TARGET_SAMPLE_RATE })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    active.stop()
  })
}

export function cancelRecording(): void {
  stopSilenceMonitor()
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null
    recorder.stop()
  }
  releaseStream()
  recorder = null
  chunks = []
}
