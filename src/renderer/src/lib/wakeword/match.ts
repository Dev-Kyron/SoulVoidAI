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
 *
 * Input is normalized to lowercase ASCII before matching (NFKD decompose +
 * strip combining marks). That way "É isso" → "e isso", "Café" → "cafe",
 * and so on — Whisper's accent-bearing hallucinations land on the same
 * regex set as the ASCII path without doubling up the patterns. JS regex
 * `\b` doesn't treat `é` as a word char anyway, so normalization is the
 * cheap fix.
 */
import type { VoicePersona } from '@shared/types'

interface WakePattern {
  rx: RegExp
  persona: VoicePersona
  label: string
}

// Whisper-tolerant wake-phrase matcher. Two layers of forgiveness here:
//
// 1) PUNCTUATION SEPARATOR — Whisper consistently inserts a comma after
//    the greeting ("Hey, soul." not "Hey soul"). The separator class
//    [\s,.\-—–]+ accepts space, comma, period, hyphen, em-dash,
//    en-dash so the comma stops breaking the match.
//
// 2) PHONETIC ALTERNATES — "Void" → Boyd/Voyd; "Soul" → Sol/Sole.
//    These are matcher-side only; documentation still teaches just the
//    canonical phrases so users don't get flooded with alternates.
//
// 3) TRUNCATION TAIL — the wake-word scan window is 1.6s; if the user
//    starts speaking mid-window Whisper may transcribe "Hey so..."
//    instead of "Hey Soul" because audio cuts off mid-word. A separate
//    end-of-string pattern handles this safely: only matches when "so"
//    is at the very end of the transcription (so "hey so what's up"
//    is not a wake but "hey so..." or "hey so." is).
// v1.7.5 — aggressive fuzzy matching. User feedback: "Soul" and "Void"
// both fire infrequently because they're single-syllable English words
// Whisper rarely transcribes consistently. Trade-off accepted: more
// false wakes (silence-stop closes the mic in ~5s if no follow-up
// speech) is much better than missed wakes (frustrating, makes the
// feature feel broken). Each persona pattern now lists every phonetic
// rhyme + truncation Whisper has been observed to emit for the wake
// phrase. Documentation still teaches just the canonical phrases.
const WAKE_PATTERNS: WakePattern[] = [
  // VOID rhymes & mistranscriptions —
  //   void, voyd, boyd (rhyming), voided/avoided/devoid (substring),
  //   boy/boys/boyed (single-syllable substitution), voids
  {
    rx: /\b(?:hey|ok|hi|hello|okay)[\s,.\-—–]+(?:void|voids|voyd|voyds|boyd|boyds|boyed|voided|avoid|avoided|devoid|boy|boys)\b/i,
    persona: 'void',
    label: 'Hey Void'
  },
  // VOID truncation — "Hey vo..." / "Hey vo" at end of transcript.
  // Anchored to end so "hey vote for me" can't false-fire.
  {
    rx: /\b(?:hey|ok|hi|hello|okay)[\s,.\-—–]+vo[\s.,…]*$/i,
    persona: 'void',
    label: 'Hey Void'
  },
  // SOUL rhymes & mistranscriptions —
  //   soul, sole, sol, souls/soles (plural), sould (typo), saul/sault
  //   (rare proper nouns rhyming with Soul), cole (less common as a
  //   standalone word).
  //
  // v1.12.1 — dropped bowl/hole/pole/role/mole/whole/coal/goal and their
  //   plurals. They're common standalone English nouns ("in a bowl", "my
  //   role", "the whole thing", "go for the goal"), so a "hey role…" in
  //   normal conversation was firing a false wake. Trade-off: slightly
  //   more missed wakes on accent-heavy mis-transcriptions, no more
  //   accidental wakes mid-conversation.
  {
    rx: /\b(?:hey|ok|hi|hello|okay)[\s,.\-—–]+(?:soul|souls|sole|soles|sol|sould|saul|sault|cole)\b/i,
    persona: 'soul',
    label: 'Hey Soul'
  },
  // SOUL truncation — "Hey so..." / "Hey so" / "Hey sou..." at end of
  // transcript. Anchored so "hey so what are we doing" can't fire.
  {
    rx: /\b(?:hey|ok|hi|hello|okay)[\s,.\-—–]+s(?:o|ou)[\s.,…]*$/i,
    persona: 'soul',
    label: 'Hey Soul'
  },
  // SOUL — Whisper's `.en` checkpoint sometimes leaks a Portuguese
  // hallucination on "Hey Soul" → "É isso." (literally "that's it"
  // in Portuguese). After NFKD normalize the leading `É` becomes
  // bare `e`, so we match the distinctive `isso` token directly —
  // it's not an English word, so a bare \bisso\b can't collide with
  // anything the user would actually be saying. Greeting prefix is
  // intentionally NOT required because the hallucination almost
  // never includes one.
  {
    rx: /\bisso\b/i,
    persona: 'soul',
    label: 'Hey Soul'
  },
  // v1.6+ COMPANION — primary neutral fallback after the rebrand.
  // "Companion" is multi-syllable so it transcribes more reliably;
  // alternates are minimal (plural + companion-without-i typo).
  {
    rx: /\b(?:hey|ok|okay)[\s,.\-—–]+(?:companion|companions|companyon)\b/i,
    persona: 'void',
    label: 'Hey Companion'
  },
  // Pre-v1.6 alias kept for muscle-memory continuity — beta users trained
  // on "Hey Assistant" don't suddenly find their wake phrase broken. The
  // label still reads as "Hey Assistant" so the toast that surfaces in
  // the HUD reflects what the user actually said.
  {
    rx: /\b(?:hey|ok|okay)[\s,.\-—–]+(?:assistant|voidsoul)\b/i,
    persona: 'void',
    label: 'Hey Assistant'
  }
]

/** Regex matching the Unicode "combining diacritical marks" block
 *  (U+0300 – U+036F) — exactly what NFKD splits off from accented
 *  characters. Module-scope `const` so JS doesn't recompile it on
 *  every wake-word scan tick. */
const DIACRITICS = /[̀-ͯ]/g

/**
 * Pure phrase matcher — returns the persona + label of the first matching
 * pattern, or null when nothing matches.
 *
 * NFKD-normalizes accented characters into base + combining mark, then strips
 * the marks before regex match. Whisper occasionally outputs accent-bearing
 * tokens even on the `.en` model ("É isso") and the regex set is ASCII; without
 * this step the leading `É` would defeat the `\b` anchor and silently miss.
 */
export function matchWakePhrase(text: string): { persona: VoicePersona; label: string } | null {
  const lc = text.normalize('NFKD').replace(DIACRITICS, '').toLowerCase().trim()
  if (!lc) return null
  for (const pat of WAKE_PATTERNS) {
    if (pat.rx.test(lc)) return { persona: pat.persona, label: pat.label }
  }
  return null
}
