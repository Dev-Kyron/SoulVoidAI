/**
 * Voice output for the two VoidSoul personas — Void (male) and Soul (female) —
 * built on the browser Speech Synthesis API. No external services: it speaks
 * with whichever voices the operating system provides.
 *
 * Streaming TTS: rather than wait for the model to finish typing and THEN
 * read the whole reply, we chunk on sentence boundaries and enqueue each
 * sentence as it streams in. The Web Speech API's speechSynthesis.speak()
 * naturally queues utterances, so the user hears the assistant start
 * talking while the text is still arriving. Drops perceived latency on
 * a long answer from "wait for paragraph, then voice" to "voice within
 * the first sentence".
 */
import type { VoiceConfig, VoicePersona } from '@shared/types'

export interface SimpleVoice {
  uri: string
  name: string
  lang: string
}

/**
 * High-priority "neural" voice tells. These names mark modern,
 * non-robotic TTS voices that ship on recent OS versions:
 *   - Windows 10/11 "Microsoft * Online" family (Aria, Guy, Jenny, etc.)
 *   - macOS "(Premium)" and "(Enhanced)" suffixed voices
 *   - Google "Wavenet" / "Neural" entries on Linux + ChromeOS
 * When any of these are present, guessVoice prefers them over the
 * older SAPI defaults (David, Zira) that earlier users described as
 * "robotic and choppy".
 */
const NEURAL_HINT = /\b(online|premium|enhanced|natural|neural|wavenet|studio)\b/i

const MALE_HINT = /\b(david|mark|george|james|guy|paul|ryan|eric|daniel|alex|fred|tom|william|davis|tony|brandon|nathan)\b/i
const FEMALE_HINT =
  /\b(zira|hazel|susan|catherine|linda|eva|aria|jenny|sonia|samantha|victoria|karen|moira|tessa|nancy|emma|ava|jane|female)\b/i

let cache: SpeechSynthesisVoice[] = []
const listeners = new Set<() => void>()

function refresh(): void {
  cache = window.speechSynthesis?.getVoices() ?? []
  listeners.forEach((listener) => listener())
}

if (window.speechSynthesis) {
  refresh()
  window.speechSynthesis.onvoiceschanged = refresh
}

/** The system voice list, refreshed as the OS reports it. */
export function availableVoices(): SimpleVoice[] {
  return cache.map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }))
}

/** Subscribe to voice-list changes (the OS populates them asynchronously). */
export function onVoicesChanged(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/**
 * Best-guess default voice for a persona — preferred order:
 *   1. English neural voice matching the persona hint
 *      (e.g. "Microsoft Aria Online (Natural)" for Soul)
 *   2. Any English voice matching the persona hint
 *      (e.g. "Microsoft Zira Desktop" for Soul)
 *   3. Any English neural voice
 *   4. First English voice
 *   5. First voice overall
 *
 * Neural-first ordering closes the "robotic / choppy" complaint for
 * users on Windows 10/11 (which ships SAPI Zira/David by default but
 * Aria/Guy/Jenny are one settings-click away) and macOS (where
 * "Samantha (Premium)" is downloadable but not the default).
 */
export function guessVoice(persona: VoicePersona): string {
  refresh()
  const english = cache.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : cache
  const personaHint = persona === 'void' ? MALE_HINT : FEMALE_HINT

  const neuralPersona = pool.find((v) => NEURAL_HINT.test(v.name) && personaHint.test(v.name))
  if (neuralPersona) return neuralPersona.voiceURI

  const personaMatch = pool.find((v) => personaHint.test(v.name))
  if (personaMatch) return personaMatch.voiceURI

  const anyNeural = pool.find((v) => NEURAL_HINT.test(v.name))
  if (anyNeural) return anyNeural.voiceURI

  return (pool[0] ?? cache[0])?.voiceURI ?? ''
}

/** Strips markdown so the spoken output stays natural. */
function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '. (code block) .')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pitch tweak — 1.05 rather than the flat 1.0 takes a touch of the
 * monotone-robot edge off the older SAPI voices without sliding into
 * cartoon territory. Subtle but reliably calms the "choppy" perception.
 */
const VOICE_PITCH = 1.05

export function speak(text: string, voiceURI: string, rate = 1): void {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(forSpeech(text))
  const voice = cache.find((v) => v.voiceURI === voiceURI)
  if (voice) utterance.voice = voice
  utterance.rate = Math.min(1.6, Math.max(0.5, rate))
  utterance.pitch = VOICE_PITCH
  synth.speak(utterance)
}

/**
 * Like speak() but does NOT cancel the existing queue first. Use this
 * when feeding streaming-TTS sentence chunks — each chunk queues
 * behind whatever's already playing, so the voice flows continuously
 * as new text arrives.
 */
export function enqueueSpeak(text: string, voiceURI: string, rate = 1): void {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return
  const utterance = new SpeechSynthesisUtterance(forSpeech(text))
  const voice = cache.find((v) => v.voiceURI === voiceURI)
  if (voice) utterance.voice = voice
  utterance.rate = Math.min(1.6, Math.max(0.5, rate))
  utterance.pitch = VOICE_PITCH
  synth.speak(utterance)
}

/** Resolves the configured voice URI for the active persona, with a fallback. */
export function resolveVoiceURI(voice: VoiceConfig): string {
  const stored = voice.persona === 'void' ? voice.voidVoiceURI : voice.soulVoiceURI
  return stored || guessVoice(voice.persona)
}

/** Speaks text using the active persona's configured voice. */
export function speakWith(voice: VoiceConfig, text: string): void {
  speak(text, resolveVoiceURI(voice), voice.rate)
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel()
}

/* --------------------------- streaming TTS --------------------------------
 *
 * The model streams tokens; the user should hear the assistant START
 * talking before the typing finishes. We chunk on sentence boundaries
 * (`. ! ?` followed by whitespace, or paragraph breaks) and enqueue
 * each one as soon as it closes.
 *
 * Subtleties:
 *   - We do NOT split inside an unclosed code fence. A streaming
 *     ```python\ndef foo():` would contain periods (`foo.bar()`) that
 *     are NOT sentence terminators — speaking the half-block sounds
 *     awful. So we cap the safe-to-emit slice at the last fence
 *     opening when the fence count is odd.
 *   - `spokenIndex` tracks how far through the accumulated text we've
 *     already enqueued, so successive feed() calls only emit the new
 *     completed sentences since last time.
 *   - flush(text) speaks whatever fragment remains unspoken — called
 *     when the stream finishes so a trailing sentence-without-punct
 *     still gets read.
 * --------------------------------------------------------------------------
 */

/**
 * Walks `text` from `startIndex` looking for completed sentence
 * boundaries. Returns the new sentences ready to be spoken, plus the
 * `nextIndex` the caller should pass back on the following call.
 *
 * Unclosed code fences are respected — text past an unclosed ```
 * is held back until the fence closes.
 */
export function extractCompleteSentences(
  text: string,
  startIndex: number
): { sentences: string[]; nextIndex: number } {
  if (startIndex >= text.length) return { sentences: [], nextIndex: startIndex }
  let tail = text.slice(startIndex)
  // If there's an odd number of ``` in the tail, the last one is an
  // unclosed fence. Don't emit anything past its opening.
  const fenceMatches = tail.match(/```/g)
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    const lastFence = tail.lastIndexOf('```')
    tail = tail.slice(0, lastFence)
  }
  // Sentence boundary: period / question mark / exclamation followed
  // by whitespace, OR a paragraph break. Conservative — we'd rather
  // delay a sentence than emit a half-formed one.
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
 * so the agent loop doesn't have to manage it. One instance per
 * send() (or per agent run); the caller resets via `new` each turn.
 *
 *   const speaker = new StreamingSpeaker(cfg.voice)
 *   // on every chunk arrival:
 *   speaker.feed(updatedText)
 *   // when the stream finishes:
 *   speaker.flush(finalText)
 */
export class StreamingSpeaker {
  private spokenIndex = 0
  private readonly voiceURI: string
  private readonly rate: number

  constructor(voice: VoiceConfig) {
    this.voiceURI = resolveVoiceURI(voice)
    this.rate = voice.rate
  }

  /** Append newly-arrived text; emit any sentences that just completed. */
  feed(text: string): void {
    const { sentences, nextIndex } = extractCompleteSentences(text, this.spokenIndex)
    for (const sentence of sentences) {
      enqueueSpeak(sentence, this.voiceURI, this.rate)
    }
    this.spokenIndex = nextIndex
  }

  /**
   * Speak the trailing fragment that didn't close with punctuation.
   * Call at end-of-stream so the last bare-tail-sentence still gets read.
   */
  flush(text: string): void {
    const tail = text.slice(this.spokenIndex).trim()
    if (tail) enqueueSpeak(tail, this.voiceURI, this.rate)
    this.spokenIndex = text.length
  }
}

