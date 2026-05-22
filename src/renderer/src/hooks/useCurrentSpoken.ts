/**
 * React adapter for the `voice.ts` "currently-spoken sentence" signal.
 *
 * The signal lives at module scope inside voice.ts (because it's driven by
 * SpeechSynthesisUtterance lifecycle hooks that fire outside React's render
 * cycle). This hook subscribes a component to it so it can re-render when
 * the spoken line ticks over to the next sentence.
 *
 * Returns null when no TTS is currently speaking.
 *
 * `useCurrentSpoken` re-renders on EVERY sentence boundary (used by the
 * Nexus rolling-line preview, which actually needs the text). For widgets
 * that only care about the on/off state — like the per-message mute icon
 * — use `useIsSpeaking` instead so a 50-sentence reply doesn't trigger 50
 * re-renders across every visible message bubble.
 */
import { useEffect, useState } from 'react'
import { getCurrentSpoken, subscribeCurrentSpoken } from '../lib/voice'

export function useCurrentSpoken(): string | null {
  const [sentence, setSentence] = useState<string | null>(() => getCurrentSpoken())
  useEffect(() => subscribeCurrentSpoken(setSentence), [])
  return sentence
}

/**
 * Like `useCurrentSpoken` but collapses the signal to a boolean. Because
 * setState bails out when the new value equals the old, this only triggers
 * a re-render on the speaking ↔ idle transition, not on every sentence
 * boundary. Cheap to call from many bubbles simultaneously.
 */
export function useIsSpeaking(): boolean {
  const [speaking, setSpeaking] = useState<boolean>(() => getCurrentSpoken() !== null)
  useEffect(
    () =>
      subscribeCurrentSpoken((value) => {
        setSpeaking(value !== null)
      }),
    []
  )
  return speaking
}
