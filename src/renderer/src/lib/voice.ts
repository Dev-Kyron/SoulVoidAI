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
import {
  parseVoiceSegments,
  stripVoiceTagsOnly,
  StreamingVoiceExtractor,
  type ToneTag,
  type VoiceSegment
} from '@shared/voiceMarkers'

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
/** Tracks whether the current AudioContext has ever made it to 'running'.
 *  Used to surface a single warning if resume() never succeeds — quieter
 *  than logging every failed playback. */
let audioCtxEverRunning = false

/**
 * Lazy AudioContext accessor with awaitable resume — the v1.3.0 version
 * called resume() fire-and-forget, which is the canonical "audio context
 * stays suspended through the first batch of synth calls" bug. Even with
 * autoplayPolicy: 'no-user-gesture-required' set on the BrowserWindow,
 * Chromium creates a fresh context in 'suspended' state and resume() is
 * async. decodeAudioData resolves before resume does → source.start()
 * schedules into a suspended timeline → user hears nothing.
 *
 * This version awaits the resume so callers can be sure ctx.state ===
 * 'running' by the time they call source.start(). Logged to the Logs
 * tab on every state transition so future "voice silent" reports leave
 * a clean trail.
 */
async function getAudioContext(): Promise<AudioContext> {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    void vs.logs.write(
      'info',
      'system',
      `[voice] AudioContext created — initial state: ${audioCtx.state}`
    )
  }
  // Cache state in a local so TS doesn't narrow audioCtx.state to the
  // 'suspended' literal — the resume() call below transitions it and
  // subsequent state reads need the full AudioContextState union.
  const initialState: AudioContextState = audioCtx.state
  if (initialState === 'suspended') {
    try {
      await audioCtx.resume()
      const stateAfter: AudioContextState = audioCtx.state
      if (!audioCtxEverRunning && stateAfter === 'running') {
        audioCtxEverRunning = true
        void vs.logs.write('info', 'system', '[voice] AudioContext resumed')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stateAfter: AudioContextState = audioCtx.state
      void vs.logs.write(
        'error',
        'system',
        `[voice] AudioContext.resume() rejected — state is ${stateAfter}: ${msg}`
      )
    }
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
    const ctx = await getAudioContext()

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
    // Make-up gain on top of the user's slider. Piper voices peak around
    // -20 dBFS (much quieter than typical OS TTS or YouTube playback) so
    // a literal 0.15 slider value renders sub-audible on most desktop
    // speakers. 1.7× lifts the perceived loudness into the range users
    // expect WITHOUT clipping (headroom math: -20 dBFS + ~4.6 dB = still
    // -15 dBFS, well under 0 dBFS clip). Hard-cap at 1.5 final-gain so
    // a 100% slider doesn't push the signal into distortion territory.
    const PIPER_MAKEUP_GAIN = 1.7
    const PIPER_GAIN_CEILING = 1.5
    gain.gain.value = Math.min(
      PIPER_GAIN_CEILING,
      clampVolume(item.volume) * PIPER_MAKEUP_GAIN
    )
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
    // Surface playback in the Logs tab too — when voice goes silent the
    // user can't tell from the console alone whether the source ever
    // even started. The state field catches the suspended-context case
    // explicitly (state should be 'running' for actual audio output).
    void vs.logs.write(
      'info',
      'system',
      `[voice] playing ${buffer.duration.toFixed(2)}s @ ${buffer.sampleRate} Hz (vol ${gain.gain.value.toFixed(2)}, ctx ${ctx.state})`
    )
    if (ctx.state !== 'running') {
      void vs.logs.write(
        'warn',
        'system',
        `[voice] AudioContext is ${ctx.state} — source will start but may not be audible until a user gesture resumes the context.`
      )
    }
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
  volume: number,
  tone?: ToneTag
): void {
  const myGen = synthGeneration
  synthChain = synthChain.then(async () => {
    // Bail if stopSpeaking() bumped the generation while we were waiting
    // in line — without this guard, late-arriving synth bytes would
    // queue audio after the user explicitly stopped.
    if (myGen !== synthGeneration) return
    try {
      console.info(
        `[voice] synth start (${persona}${tone ? `/${tone}` : ''}, ${text.length} chars)`
      )
      const bytes = await vs.voice.synthesise({ persona, text, rate, tone })
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
 *
 * `tone` (v1.3.0+) selects the Piper preset that shapes length_scale /
 * noise_scale / noise_w. Defaults to 'casual' which matches the
 * pre-v1.3.0 sound.
 */
export function speak(
  text: string,
  persona: VoicePersona,
  rate = 1,
  volume = 1,
  tone?: ToneTag
): void {
  stopSpeaking()
  enqueueSpeak(text, persona, rate, volume, tone)
}

/**
 * Append a sentence to the playback queue without clearing what's
 * already playing. Used by `StreamingSpeaker` to feed voice-tagged
 * segments as a streaming reply arrives.
 */
export function enqueueSpeak(
  text: string,
  persona: VoicePersona,
  rate = 1,
  volume = 1,
  tone?: ToneTag
): void {
  if (!text.trim()) return
  const spoken = forSpeech(text)
  if (!spoken) return
  queueOne(spoken, text.trim(), persona, rate, volume, tone)
}

/**
 * Queue a single VoiceSegment extracted from the model's <voice> markup.
 * Thin convenience wrapper around enqueueSpeak — the chat store streams
 * segments via this so call sites don't have to thread tone manually.
 */
export function queueSpeakSegment(segment: VoiceSegment, voice: VoiceConfig): void {
  enqueueSpeak(segment.text, voice.persona, voice.rate, voice.volume, segment.tone)
}

/**
 * Speak a stored message (the speaker button on a chat bubble, the
 * persona greet on toggle, etc). If the message contains `<voice>` tags,
 * speak just those segments with their tones — that's the voice layer
 * the user heard live, replayed faithfully. Otherwise strip any stray
 * markup and speak the whole thing as one casual utterance.
 */
export function speakWith(voice: VoiceConfig, text: string): void {
  const { segments } = parseVoiceSegments(text)
  stopSpeaking()
  if (segments.length > 0) {
    for (const seg of segments) {
      queueSpeakSegment(seg, voice)
    }
    return
  }
  // No tags: speak the stripped chat text. Casual tone — we can't infer
  // a richer one from raw prose without an extra classifier call, and
  // beta sessions show the manual speaker button is rarely a "be
  // dramatic" moment anyway.
  const fallback = stripVoiceTagsOnly(text).trim()
  if (fallback) {
    enqueueSpeak(fallback, voice.persona, voice.rate, voice.volume, 'casual')
  }
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
 * v1.3.0 architecture: voice layer is whatever the model wraps in
 * <voice tone="...">...</voice> markers. Everything outside those
 * markers is chat-only (silent). The model has full context to decide
 * what's worth speaking — code blocks, file paths, long lists go
 * outside the tags; reactions, key insights, questions, nudges go
 * inside with an appropriate tone.
 *
 * The chat store calls feed(fullText) on every streaming delta with
 * the accumulated text so far. We compute the delta (slice past
 * lastFeedLength), feed it to a StreamingVoiceExtractor, and queue
 * any newly-completed segments. flush() at stream end handles any
 * trailing content + the fallback heuristic (speak first paragraph
 * if the model emitted zero tags and the reply isn't code-heavy).
 *
 * Pre-v1.3.0 path (sentence-boundary chunking) is gone — it
 * mechanically spoke everything in the reply including code blocks,
 * which is exactly what this update is meant to fix.
 * --------------------------------------------------------------------- */

export class StreamingSpeaker {
  private readonly extractor = new StreamingVoiceExtractor()
  /** Index in the most-recent feed text past which we've already
   *  fed deltas to the extractor. The chat store hands us accumulated
   *  text each call, so we slice the new tail off here. */
  private lastFeedLength = 0
  private readonly persona: VoicePersona
  private readonly rate: number
  private readonly volume: number
  private readonly fallbackOnNoTags: boolean

  /**
   * @param voice  active voice config — persona / rate / volume
   * @param opts   `fallbackOnNoTags` (default true) controls whether
   *               flush() should emit a soft "speak the first paragraph"
   *               fallback if the model never wrapped any segment in
   *               <voice> tags. Set false for fully-agentic replies
   *               where pure silence on untagged output is correct.
   */
  constructor(voice: VoiceConfig, opts: { fallbackOnNoTags?: boolean } = {}) {
    this.persona = voice.persona
    this.rate = voice.rate
    this.volume = voice.volume
    this.fallbackOnNoTags = opts.fallbackOnNoTags ?? true
  }

  /** Called per streaming delta with the accumulated text so far. */
  feed(fullText: string): void {
    if (fullText.length <= this.lastFeedLength) return
    const delta = fullText.slice(this.lastFeedLength)
    this.lastFeedLength = fullText.length
    const segments = this.extractor.feed(delta)
    for (const segment of segments) {
      this.enqueue(segment)
    }
  }

  /**
   * Called when the stream ends. Catches any trailing content, then
   * applies the no-tags fallback if appropriate.
   */
  flush(finalText: string): void {
    if (finalText.length > this.lastFeedLength) {
      this.feed(finalText)
    }
    const tail = this.extractor.flush({ fallbackOnNoTags: this.fallbackOnNoTags })
    for (const segment of tail) {
      this.enqueue(segment)
    }
  }

  private enqueue(segment: VoiceSegment): void {
    enqueueSpeak(segment.text, this.persona, this.rate, this.volume, segment.tone)
  }
}
