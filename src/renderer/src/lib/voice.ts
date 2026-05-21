/**
 * Voice output for the two VoidSoul personas — Void (male) and Soul (female) —
 * built on the browser Speech Synthesis API. No external services: it speaks
 * with whichever voices the operating system provides.
 */
import type { VoiceConfig, VoicePersona } from '@shared/types'

export interface SimpleVoice {
  uri: string
  name: string
  lang: string
}

const MALE_HINT = /\b(david|mark|george|james|guy|paul|ryan|eric|daniel|alex|fred|tom|william)\b/i
const FEMALE_HINT =
  /\b(zira|hazel|susan|catherine|linda|eva|aria|jenny|sonia|samantha|victoria|karen|moira|tessa|female)\b/i

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

/** Best-guess default voice for a persona, preferring English voices. */
export function guessVoice(persona: VoicePersona): string {
  refresh()
  const english = cache.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : cache
  const hint = persona === 'void' ? MALE_HINT : FEMALE_HINT
  const match = pool.find((v) => hint.test(v.name))
  return (match ?? pool[0] ?? cache[0])?.voiceURI ?? ''
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

export function speak(text: string, voiceURI: string, rate = 1): void {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(forSpeech(text))
  const voice = cache.find((v) => v.voiceURI === voiceURI)
  if (voice) utterance.voice = voice
  utterance.rate = Math.min(1.6, Math.max(0.5, rate))
  utterance.pitch = 1
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

