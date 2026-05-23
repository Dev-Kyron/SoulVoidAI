/**
 * Voice output, powered by Piper TTS (https://github.com/rhasspy/piper).
 *
 * v1.1.x ran on the browser Web Speech API, which on Windows meant SAPI
 * voices (David, Mark, Zira) plus whatever extra SAPI packs the user had
 * installed — collectively pretty robotic. v1.2.0 swaps to Piper neural
 * voices: each persona (Void, Soul) has a single .onnx voice file under
 * `<userData>/voices/<persona>/`, and the main process spawns the bundled
 * piper binary per sentence to render WAV audio we play in the renderer.
 *
 * Streaming TTS architecture (unchanged in shape): the model streams
 * tokens; we chunk on sentence boundaries via `extractCompleteSentences`,
 * call `enqueueSpeak` per sentence the moment it closes, and an internal
 * audio queue plays them in FIFO order. The user hears the assistant
 * start talking before typing finishes — same UX as v1.1.x, just with
 * voices that don't sound like a 2002 GPS unit.
 *
 * Per-sentence cost: ~300 ms cold start (piper loads the .onnx into
 * memory the first time) + ~70 ms per second of audio. For a 4-sentence
 * reply, the user hears sentence 1 within 600 ms of token-arrival, then
 * each subsequent sentence is gapless.
 */
import { vs } from './bridge'
import type { VoiceConfig, VoicePersona } from '@shared/types'

/* ---------------- currently-spoken-sentence signal ---------------------
 *
 * A small reactive slot pointing at the sentence the audio queue is
 * playing RIGHT NOW. Drives the Nexus panel's rolling-line preview —
 * instead of spilling the whole reply into a scrollable box, the panel
 * shows just the line being voiced and lets it tick to the next as the
 * queue advances.
 *
 * Updated from the HTMLAudioElement.onplaying / onended hooks the audio
 * queue attaches per chunk. Cleared when the queue drains, when
 * stopSpeaking() cancels, or on an audio error.
 * --------------------------------------------------------------------- */

let currentSpoken: string | null = null
const currentSpokenListeners = new Set<(s: string | null) => void>()

function setCurrentSpoken(value: string | null): void {
  if (value === currentSpoken) return
  currentSpoken = value
  currentSpokenListeners.forEach((listener) => listener(value))
}

export function subscribeCurrentSpoken(callback: (sentence: string | null) => void): () => void {
  currentSpokenListeners.add(callback)
  return () => currentSpokenListeners.delete(callback)
}

export function getCurrentSpoken(): string | null {
  return currentSpoken
}

/* ----------------------- text → speech-friendly ----------------------- */

/**
 * Strips markdown so the spoken output reads naturally. Identical to the
 * v1.1.x helper — Piper takes plain text, same as Web Speech did.
 * Code blocks collapse to a brief tone, inline code drops backticks,
 * link text survives, markdown markers vanish.
 */
function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '. (code block) .')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------ audio queue manager ------------------------- */

interface QueueItem {
  /** Raw WAV bytes from piper. Decoded lazily inside playNext() so the
   *  AudioContext only fires up once playback actually starts. */
  bytes: Uint8Array
  display: string // unstripped sentence shown in the rolling preview
  volume: number // 0-1, applied via a per-source GainNode
}

/**
 * Single shared AudioContext. Created lazily on first use because some
 * Chromium versions still demand a user-gesture before resuming a suspended
 * context — the very first speech happens behind a click anyway (test
 * preview button, mic mute, send button), so by the time we synthesise
 * audio the context is allowed to run. We hold one for the app lifetime
 * rather than creating per-utterance to avoid the cold-start latency
 * (~30 ms on Windows the first time a sample rate is negotiated).
 */
let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  if (audioCtx.state === 'suspended') {
    // Best-effort resume — if Chromium hasn't seen a user gesture this
    // session, this still rejects, but we'll log it in playNext().
    void audioCtx.resume()
  }
  return audioCtx
}

/**
 * FIFO playback queue for synthesised WAV chunks, played through the Web
 * Audio API rather than `<audio>` elements.
 *
 * Why Web Audio: HTMLAudioElement's WAV decoder is finicky about header
 * layout — it rejects valid PCM streams when chunk sizes are 0xFFFFFFFF
 * (streaming WAVs), when extra LIST/INFO chunks are present, or when the
 * file uses WAVE_FORMAT_EXTENSIBLE (0xFFFE) instead of plain PCM. Piper
 * 2023.11.14-2 on Windows writes one of these flavours and Chromium's
 * `<audio>` rejects it with the unhelpful "no supported source was found"
 * error, leaving only a brief decoder-state buzz behind. AudioContext.
 * decodeAudioData uses a separate, more permissive decoder that handles
 * all these WAV variants correctly.
 *
 * Trade-offs: slightly more code (decode + buffer source + gain), but
 * the cost is one decodeAudioData call per sentence (~5 ms for 4 sec
 * of audio) and we get cleaner stop semantics — `source.stop()` is
 * truly instant, unlike `audio.pause()` which can leave a partial buffer
 * draining for a few ms.
 */
class AudioQueue {
  private current: AudioBufferSourceNode | null = null
  private currentGain: GainNode | null = null
  private pending: QueueItem[] = []
  /**
   * Bumped on clear() so a decodeAudioData() that resolves AFTER the
   * user pressed Stop doesn't sneak its source into playback. Same idea
   * as synthGeneration, scoped to playback.
   */
  private playbackGeneration = 0

  enqueue(item: QueueItem): void {
    this.pending.push(item)
    if (!this.current) void this.playNext()
  }

  private async playNext(): Promise<void> {
    const item = this.pending.shift()
    if (!item) {
      this.current = null
      this.currentGain = null
      setCurrentSpoken(null)
      return
    }
    const myGen = this.playbackGeneration
    const ctx = getAudioContext()

    let buffer: AudioBuffer
    try {
      // decodeAudioData wants an ArrayBuffer it owns — slice() makes a
      // copy detached from the Uint8Array's underlying buffer so we don't
      // hand the decoder a view that could be modified mid-decode.
      const arrayBuffer = item.bytes.buffer.slice(
        item.bytes.byteOffset,
        item.bytes.byteOffset + item.bytes.byteLength
      ) as ArrayBuffer
      buffer = await ctx.decodeAudioData(arrayBuffer)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void vs.logs.write(
        'error',
        'system',
        `[voice] decodeAudioData failed (${item.bytes.length} bytes): ${msg}`
      )
      console.warn('[voice] decodeAudioData failed', err)
      // Skip to the next chunk so the queue doesn't lock up.
      this.current = null
      this.currentGain = null
      void this.playNext()
      return
    }

    // Bail if clear() ran while we were decoding — playbackGeneration
    // bumped, this source no longer belongs to the active queue.
    if (myGen !== this.playbackGeneration) return

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = clampVolume(item.volume)
    source.connect(gain).connect(ctx.destination)

    source.onended = (): void => {
      // Only advance if THIS source is still the current one — clear()
      // calls source.stop() which fires onended, and we don't want to
      // chain into another playNext after an explicit cancel.
      if (myGen !== this.playbackGeneration) return
      this.current = null
      this.currentGain = null
      void this.playNext()
    }

    this.current = source
    this.currentGain = gain
    setCurrentSpoken(item.display)
    console.info(
      `[voice] playing ${buffer.duration.toFixed(2)}s @ ${buffer.sampleRate} Hz (vol ${gain.gain.value.toFixed(2)})`
    )
    source.start()
  }

  /** Stop in-flight audio, throw away pending. Instant — Web Audio's
   *  stop() is synchronous, unlike <audio>'s drain-then-pause. */
  clear(): void {
    this.playbackGeneration++
    if (this.current) {
      try {
        this.current.stop()
      } catch {
        /* already stopped or never started — both safe to ignore */
      }
      this.current.disconnect()
      this.currentGain?.disconnect()
      this.current = null
      this.currentGain = null
    }
    this.pending = []
    setCurrentSpoken(null)
  }
}

const audioQueue = new AudioQueue()

/* --------------------- piper IPC + chained synth ---------------------- */

/**
 * Sequential promise chain so streaming sentences end up in the audio
 * queue in the order they were fed, even though `vs.voice.synthesise()`
 * is async and faster sentences could otherwise finish out of order.
 * Replaced with a fresh resolved Promise on `stopSpeaking()` so any
 * in-flight synth becomes a no-op once it lands.
 */
let synthChain: Promise<void> = Promise.resolve()
/** Generation counter — bumped on stopSpeaking so chained .then callbacks
 *  can detect they're stale and bail. */
let synthGeneration = 0

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.min(1, Math.max(0, volume))
}

/**
 * Queue one sentence through the piper IPC → audio queue pipeline.
 * Async work happens inside `synthChain` so order is preserved.
 *
 * `displayText` is the original (pre-`forSpeech`) text so the rolling
 * preview shows what the user reads on screen, not the bracket-stripped
 * variant we hand to Piper.
 */
function queueOne(
  text: string,
  displayText: string,
  persona: VoicePersona,
  rate: number,
  volume: number
): void {
  const myGen = synthGeneration
  synthChain = synthChain.then(async () => {
    // Bail if stopSpeaking() bumped the generation while we were waiting
    // in line — without this guard, late-arriving synth bytes would
    // queue audio after the user explicitly stopped.
    if (myGen !== synthGeneration) return
    try {
      console.info(`[voice] synth start (${persona}, ${text.length} chars)`)
      const bytes = await vs.voice.synthesise({ persona, text, rate })
      if (myGen !== synthGeneration) {
        console.info('[voice] synth result dropped — superseded by stop')
        return
      }
      if (bytes.length === 0) {
        void vs.logs.write('warn', 'system', '[voice] synth returned 0 bytes — piper produced no audio')
        return
      }
      console.info(`[voice] synth ok — ${bytes.length} bytes, enqueuing audio`)
      // Pass raw bytes directly — AudioQueue uses Web Audio API's
      // decodeAudioData, which wants an ArrayBuffer it can own. We
      // skip the Blob/URL hop entirely.
      audioQueue.enqueue({ bytes, display: displayText, volume })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void vs.logs.write('error', 'system', `[voice] synth failed: ${msg}`)
      console.warn('[voice] piper synthesis failed', err)
    }
  })
}

/* ---------------------------- public API ------------------------------ */

/**
 * Speak text immediately, replacing anything currently playing. Used by
 * the test buttons in voice settings, the persona-greet on toggle, etc.
 */
export function speak(text: string, persona: VoicePersona, rate = 1, volume = 1): void {
  stopSpeaking()
  enqueueSpeak(text, persona, rate, volume)
}

/**
 * Append a sentence to the playback queue without clearing what's
 * already playing. Used by `StreamingSpeaker` to feed sentence-chunks
 * as a streaming reply arrives.
 */
export function enqueueSpeak(text: string, persona: VoicePersona, rate = 1, volume = 1): void {
  if (!text.trim()) return
  const spoken = forSpeech(text)
  if (!spoken) return
  queueOne(spoken, text.trim(), persona, rate, volume)
}

/** Speak text using the given config's persona + rate + volume. */
export function speakWith(voice: VoiceConfig, text: string): void {
  speak(text, voice.persona, voice.rate, voice.volume)
}

/**
 * Cancel everything — drop the in-flight synth chain, clear the audio
 * queue, clear the currently-spoken signal. Safe to call when nothing is
 * playing.
 */
export function stopSpeaking(): void {
  synthGeneration++
  synthChain = Promise.resolve()
  audioQueue.clear()
}

/* --------------------------- streaming TTS ---------------------------- *
 *
 * Same architecture as v1.1.x — chunk on sentence boundaries, enqueue
 * each as it closes. The chunking logic is identical because Piper
 * speaks sentences the same way Web Speech did. Only the per-chunk
 * dispatch is different (IPC → piper → WAV vs. utterance.speak).
 * --------------------------------------------------------------------- */

/**
 * Walks `text` from `startIndex` looking for completed sentence
 * boundaries. Returns the new sentences ready to be spoken, plus the
 * `nextIndex` the caller should pass back on the following call.
 *
 * Unclosed code fences are respected — text past an unclosed ```
 * is held back until the fence closes, otherwise we'd speak half a
 * code block and it sounds awful.
 */
export function extractCompleteSentences(
  text: string,
  startIndex: number
): { sentences: string[]; nextIndex: number } {
  if (startIndex >= text.length) return { sentences: [], nextIndex: startIndex }
  let tail = text.slice(startIndex)
  const fenceMatches = tail.match(/```/g)
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    const lastFence = tail.lastIndexOf('```')
    tail = tail.slice(0, lastFence)
  }
  // Period / question / exclamation + whitespace, OR paragraph break.
  const boundary = /[.!?]+\s+|\n{2,}/g
  const sentences: string[] = []
  let pos = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(tail)) !== null) {
    const end = match.index + match[0].length
    const sentence = tail.slice(pos, end).trim()
    if (sentence) sentences.push(sentence)
    pos = end
  }
  return { sentences, nextIndex: startIndex + pos }
}

/**
 * Stateful helper around enqueueSpeak — owns the spokenIndex pointer
 * so the agent loop doesn't have to manage it. One instance per send()
 * (or per agent run); the caller resets via `new` each turn.
 *
 *   const speaker = new StreamingSpeaker(cfg.voice)
 *   // on every chunk arrival:
 *   speaker.feed(updatedText)
 *   // when the stream finishes:
 *   speaker.flush(finalText)
 */
export class StreamingSpeaker {
  private spokenIndex = 0
  private readonly persona: VoicePersona
  private readonly rate: number
  private readonly volume: number

  constructor(voice: VoiceConfig) {
    this.persona = voice.persona
    this.rate = voice.rate
    this.volume = voice.volume
  }

  /** Append newly-arrived text; emit any sentences that just completed. */
  feed(text: string): void {
    const { sentences, nextIndex } = extractCompleteSentences(text, this.spokenIndex)
    for (const sentence of sentences) {
      enqueueSpeak(sentence, this.persona, this.rate, this.volume)
    }
    this.spokenIndex = nextIndex
  }

  /**
   * Speak the trailing fragment that didn't close with punctuation.
   * Call at end-of-stream so the last bare-tail-sentence still gets read.
   */
  flush(text: string): void {
    const tail = text.slice(this.spokenIndex).trim()
    if (tail) enqueueSpeak(tail, this.persona, this.rate, this.volume)
    this.spokenIndex = text.length
  }
}
