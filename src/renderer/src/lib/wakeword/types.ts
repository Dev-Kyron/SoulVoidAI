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
