/**
 * Shared interface for wake-word engines. The router in `useWakeWord.ts`
 * picks one based on whether the user has a Picovoice key — Porcupine when
 * yes (purpose-built, lower CPU), Whisper when no (keyless, reuses the STT
 * model already on disk).
 *
 * Engines own their own audio plumbing — start() acquires the mic and any
 * runtime resources, stop() releases everything. Both methods are idempotent
 * and safe to call in either order.
 */
import type { VoicePersona } from '@shared/types'

export interface WakeEngine {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Fired by every engine on detection. Persona drives the voice swap; label is
 * the human-readable phrase used in toasts/logs.
 */
export type WakeDetectCallback = (persona: VoicePersona, label: string) => void

/**
 * v1.7.1 diagnostic surface — fired by transcription-based engines
 * (Whisper) for EVERY non-empty transcription, regardless of whether
 * it matched a wake phrase. Lets the Wake Word settings panel show a
 * "Heard:" ticker so users can see what the model is actually hearing
 * — "Hey Boyd" instead of "Hey Void", "Avoid" instead of "Hey Void",
 * etc. Without this, a failing wake word looks identical to "user
 * isn't talking" and is impossible to debug.
 *
 * Keyword-based engines (Porcupine) don't produce text, so this
 * callback is optional and never fired by Porcupine.
 */
export type WakeHeardCallback = (text: string, matched: boolean) => void
