/**
 * Wake-phrase pattern matching. Split out from `whisper.ts` so the pure
 * matching logic stays free of audio / store dependencies — that lets the
 * tests import it without transitively loading the whole renderer module
 * graph (including the chat store's module-scope event subscriptions).
 *
 * The patterns are listed most-specific first so "hey void" wins the regex
 * race over a bare "hey". `\b` boundaries keep "hey voiding" or similar from
 * mis-firing. The greeting alternation tolerates Whisper's casual spelling
 * differences ("ok"/"OK", missing apostrophes, etc.).
 */
import type { VoicePersona } from '@shared/types'

interface WakePattern {
  rx: RegExp
  persona: VoicePersona
  label: string
}

const WAKE_PATTERNS: WakePattern[] = [
  { rx: /\b(?:hey|ok|hi|hello|okay)\s+void\b/i, persona: 'void', label: 'Hey Void' },
  { rx: /\b(?:hey|ok|hi|hello|okay)\s+soul\b/i, persona: 'soul', label: 'Hey Soul' },
  // A few neutral fallbacks so users not yet attached to the persona names
  // can still trigger the loop. Default to the user's active persona.
  { rx: /\b(?:hey|ok|okay)\s+(?:assistant|voidsoul)\b/i, persona: 'void', label: 'Hey Assistant' }
]

/**
 * Pure phrase matcher — returns the persona + label of the first matching
 * pattern, or null when nothing matches.
 */
export function matchWakePhrase(text: string): { persona: VoicePersona; label: string } | null {
  const lc = text.toLowerCase().trim()
  if (!lc) return null
  for (const pat of WAKE_PATTERNS) {
    if (pat.rx.test(lc)) return { persona: pat.persona, label: pat.label }
  }
  return null
}
