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
import {
  getCurrentSpoken,
  getSpeakerState,
  subscribeCurrentSpoken,
  subscribeSpeakerState,
  type SpeakerState
} from '../lib/voice'

export function useCurrentSpoken(): string | null {
  const [sentence, setSentence] = useState<string | null>(() => getCurrentSpoken())
  useEffect(() => subscribeCurrentSpoken(setSentence), [])
  return sentence
}

/**
 * 3-state speaker signal: 'idle' | 'warming' | 'speaking'.
 *
 * `warming` covers the period between clicking Read Aloud and audio
 * actually playing — Piper synthesis on a cold cache or a long input
 * can take 1-3 seconds. Without this state the button stays in `idle`
 * the whole time and the user thinks the click was ignored.
 *
 * Components that only care about play/stop can use `useIsSpeaking`
 * (derived from this hook). Use this directly when you need to show
 * a "preparing voice…" spinner.
 */
export function useSpeakerState(): SpeakerState {
  const [state, setState] = useState<SpeakerState>(() => getSpeakerState())
  useEffect(() => subscribeSpeakerState(setState), [])
  return state
}

/**
 * Like `useCurrentSpoken` but collapses the signal to a boolean — true
 * only while audio is actively playing. Derived from `useSpeakerState`
 * so there's one subscription path; React's setState equality short-
 * circuits the warming↔idle transitions where the boolean doesn't
 * change. Cheap to call from many bubbles simultaneously.
 */
export function useIsSpeaking(): boolean {
  return useSpeakerState() === 'speaking'
}
