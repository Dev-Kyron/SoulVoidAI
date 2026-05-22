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

/**
 * Per-persona "first-choice" name lists, ordered from best to worst quality.
 * The picker walks these one at a time before falling back to the broad
 * MALE_HINT / FEMALE_HINT regex — so "Microsoft Guy Online (Natural)" wins
 * over "Microsoft Mark Desktop (SAPI)" even though both match the male hint.
 *
 * Listed names are limited to what's actually reachable via the Web Speech
 * API (SAPI on Windows, NSSpeechSynthesizer on macOS, espeak/etc. on Linux).
 * The newer Microsoft "Natural HD" voices (Andrew, Ava, Brian, Emma)
 * installed via Narrator are deliberately omitted — Microsoft has gated
 * them behind a private API that third-party apps can't reach, so even if
 * they appear in Narrator's picker they never surface here.
 */
const PREFERRED_VOID_VOICES = [
  'guy',    // Natural (Win, when available via en-US locale pack)
  'davis',  // Natural (Win)
  'tony',   // Natural (Win)
  'christopher',
  'eric',
  'roger',
  'steffan',
  'mark',   // SAPI fallback
  'david'   // SAPI default
]
const PREFERRED_SOUL_VOICES = [
  'aria',   // Natural (Win, when available)
  'jenny',  // Natural (Win)
  'michelle',
  'sara',
  'nancy',
  'emma',   // some non-HD installs surface Emma via SAPI
  'zira'    // SAPI default
]

const MALE_HINT = /\b(david|mark|george|james|guy|paul|ryan|eric|daniel|alex|fred|tom|william|davis|tony|brandon|nathan|andrew|brian|christopher|roger|steffan)\b/i
const FEMALE_HINT =
  /\b(zira|hazel|susan|catherine|linda|eva|aria|jenny|sonia|samantha|victoria|karen|moira|tessa|nancy|emma|ava|jane|michelle|sara|female)\b/i

let cache: SpeechSynthesisVoice[] = []
const listeners = new Set<() => void>()

function refresh(): void {
  cache = window.speechSynthesis?.getVoices() ?? []
  listeners.forEach((listener) => listener())
}

/* ---------- currently-spoken-sentence signal -----------------------------
 *
 * A small reactive slot pointing at the sentence the synthesizer is reading
 * RIGHT NOW. Drives the Nexus panel's rolling-line preview — instead of
 * spilling the whole reply into a scrollable box, the panel shows just the
 * line being voiced and lets it tick to the next as TTS progresses.
 *
 * Updated from the SpeechSynthesisUtterance.onstart hook attached in
 * enqueueSpeak(). Cleared when the synth queue drains, when stopSpeaking()
 * cancels, or on an utterance error.
 * ------------------------------------------------------------------------- */
let currentSpoken: string | null = null
const currentSpokenListeners = new Set<(s: string | null) => void>()

function setCurrentSpoken(value: string | null): void {
  if (value === currentSpoken) return
  currentSpoken = value
  currentSpokenListeners.forEach((listener) => listener(value))
}

/** Subscribe to changes in the currently-spoken sentence. */
export function subscribeCurrentSpoken(callback: (sentence: string | null) => void): () => void {
  currentSpokenListeners.add(callback)
  return () => currentSpokenListeners.delete(callback)
}

/** Read the currently-spoken sentence synchronously (for `useState` seeding). */
export function getCurrentSpoken(): string | null {
  return currentSpoken
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
 *   1. A name from the per-persona preferred list, in list order
 *      (Andrew → Void, Ava → Soul win when installed; Aria/Guy next; etc.)
 *   2. English neural voice matching the persona hint
 *      (e.g. "Microsoft Aria Online (Natural)" for Soul)
 *   3. Any English voice matching the persona hint
 *      (e.g. "Microsoft Zira Desktop" for Soul)
 *   4. Any English neural voice
 *   5. First English voice
 *   6. First voice overall
 *
 * Walking the preferred-name list first lets us steer the default at
 * "Andrew (Natural HD)" over "Guy (Natural)" over "Mark (SAPI)" without
 * the regex caring — each is a strictly better choice than the next.
 * Beta testers who install just one new voice get the best one auto-
 * selected, which closes the "the voices still sound robotic after I
 * installed Andrew" loop.
 */
export function guessVoice(persona: VoicePersona): string {
  refresh()
  const english = cache.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : cache
  const personaHint = persona === 'void' ? MALE_HINT : FEMALE_HINT
  const preferred = persona === 'void' ? PREFERRED_VOID_VOICES : PREFERRED_SOUL_VOICES

  // First-pick walk: try each preferred name in order, prioritising
  // neural variants when both an SAPI and a neural copy exist (some
  // installs surface "Microsoft Eric" as both a desktop voice AND a
  // Natural voice — we want the Natural one).
  for (const name of preferred) {
    const needle = new RegExp(`\\b${name}\\b`, 'i')
    const neural = pool.find((v) => needle.test(v.name) && NEURAL_HINT.test(v.name))
    if (neural) return neural.voiceURI
    const plain = pool.find((v) => needle.test(v.name))
    if (plain) return plain.voiceURI
  }

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

/**
 * Wires the currently-spoken signal up to an utterance. `display` is the
 * sentence shown in the Nexus rolling preview — it's the ORIGINAL text
 * (with markdown intact), not the speech-stripped variant, so the user
 * sees what they'd read on screen rather than the bracket-free TTS prompt.
 *
 * The onend clear only fires when no more utterances are pending — if the
 * synth queue still has work, the next utterance's onstart will overwrite
 * the signal cleanly without an in-between flicker to null.
 */
function attachSpokenSignal(utterance: SpeechSynthesisUtterance, display: string): void {
  const synth = window.speechSynthesis
  utterance.onstart = (): void => setCurrentSpoken(display)
  const clearIfIdle = (): void => {
    if (!synth || (!synth.speaking && !synth.pending)) setCurrentSpoken(null)
  }
  utterance.onend = clearIfIdle
  utterance.onerror = clearIfIdle
}

/** Clamp a volume to the [0, 1] range the Web Speech API expects. */
function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1
  return Math.min(1, Math.max(0, volume))
}

/**
 * Build a configured `SpeechSynthesisUtterance` for the given text, voice,
 * rate and volume — with rate/volume clamped to the platform's accepted
 * range and the spoken-signal hooks already attached. Shared between
 * `speak` and `enqueueSpeak` so the utterance setup stays in one place;
 * the only thing the callers differ on is whether they cancel the queue
 * first (`speak`) or append to it (`enqueueSpeak`).
 */
function buildUtterance(
  text: string,
  voiceURI: string,
  rate: number,
  volume: number
): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(forSpeech(text))
  const voice = cache.find((v) => v.voiceURI === voiceURI)
  if (voice) utterance.voice = voice
  utterance.rate = Math.min(1.6, Math.max(0.5, rate))
  utterance.pitch = VOICE_PITCH
  utterance.volume = clampVolume(volume)
  attachSpokenSignal(utterance, text.trim())
  return utterance
}

export function speak(text: string, voiceURI: string, rate = 1, volume = 1): void {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return
  synth.cancel()
  setCurrentSpoken(null)
  synth.speak(buildUtterance(text, voiceURI, rate, volume))
}

/**
 * Like speak() but does NOT cancel the existing queue first. Use this
 * when feeding streaming-TTS sentence chunks — each chunk queues behind
 * whatever's already playing, so the voice flows continuously as new
 * text arrives.
 */
export function enqueueSpeak(text: string, voiceURI: string, rate = 1, volume = 1): void {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return
  synth.speak(buildUtterance(text, voiceURI, rate, volume))
}

/** Resolves the configured voice URI for the active persona, with a fallback. */
export function resolveVoiceURI(voice: VoiceConfig): string {
  const stored = voice.persona === 'void' ? voice.voidVoiceURI : voice.soulVoiceURI
  return stored || guessVoice(voice.persona)
}

/** Speaks text using the active persona's configured voice + rate + volume. */
export function speakWith(voice: VoiceConfig, text: string): void {
  speak(text, resolveVoiceURI(voice), voice.rate, voice.volume)
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel()
  setCurrentSpoken(null)
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
  private readonly volume: number

  constructor(voice: VoiceConfig) {
    this.voiceURI = resolveVoiceURI(voice)
    this.rate = voice.rate
    this.volume = voice.volume
  }

  /** Append newly-arrived text; emit any sentences that just completed. */
  feed(text: string): void {
    const { sentences, nextIndex } = extractCompleteSentences(text, this.spokenIndex)
    for (const sentence of sentences) {
      enqueueSpeak(sentence, this.voiceURI, this.rate, this.volume)
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

