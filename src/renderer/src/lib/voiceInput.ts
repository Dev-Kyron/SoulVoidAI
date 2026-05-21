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

/** 16kHz is Whisper's native sample rate, and what all three backends want. */
const TARGET_SAMPLE_RATE = 16_000

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

export async function startRecording(): Promise<void> {
  // Re-entrancy guard: a rapid second call would otherwise orphan the prior
  // MediaStream's tracks without stopping them (mic stays hot until GC).
  // Tear down any leftover state first so the new recording owns the mic.
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null
    recorder.stop()
  }
  releaseStream()
  recorder = null
  chunks = []

  stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  recorder.start()
}

/** Stops recording, decodes to PCM, resolves with the clip (or null if empty). */
export function stopRecording(): Promise<RecordedAudioClip | null> {
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
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null
    recorder.stop()
  }
  releaseStream()
  recorder = null
  chunks = []
}
