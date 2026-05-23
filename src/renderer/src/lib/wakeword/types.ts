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
 * Diagnostic surface — fired by transcription-based engines (Whisper)
 * so the Wake Word settings panel can show what the engine is actually
 * doing. Three event shapes (discriminated by which fields are set):
 *
 *   · text="hey void", matched=true            → green match row
 *   · text="hey boyd", matched=false           → grey heard-but-no-match
 *   · text="", matched=false, no error         → silence beat (engine alive,
 *                                                 mic capturing, model silent)
 *   · text="", matched=false, error set        → red error row
 *
 * Without ALL of these, a wake word that's "silently broken" looks
 * identical to "user isn't talking" — impossible to diagnose. The
 * panel renders distinct visuals for each shape so the user can tell
 * "Whisper is mishearing me" from "the transcribe call is erroring"
 * from "the mic isn't picking up anything".
 *
 * v1.7.1 introduced this with just (text, matched). v1.7.2 added the
 * optional error field and the silence-beat protocol. Porcupine never
 * fires this callback (keyword-based, no text).
 */
export type WakeHeardCallback = (text: string, matched: boolean, error?: string) => void
