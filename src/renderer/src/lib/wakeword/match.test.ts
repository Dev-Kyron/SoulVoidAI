import { describe, expect, it } from 'vitest'
import { matchWakePhrase } from './match'

// The wake-phrase patterns are the surface the user actually interacts with —
// silent regex drift would be invisible until "Hey Void" suddenly stops
// triggering. Locking the matcher to specific in/out cases catches that.
describe('matchWakePhrase', () => {
  it('matches the canonical persona phrases', () => {
    expect(matchWakePhrase('Hey Void')?.persona).toBe('void')
    expect(matchWakePhrase('Hey Soul')?.persona).toBe('soul')
    expect(matchWakePhrase('hey void')?.persona).toBe('void')
    expect(matchWakePhrase('HEY VOID')?.persona).toBe('void')
  })

  it('tolerates the common greeting alternatives Whisper produces', () => {
    expect(matchWakePhrase('ok void')?.persona).toBe('void')
    expect(matchWakePhrase('okay void')?.persona).toBe('void')
    expect(matchWakePhrase('hi void')?.persona).toBe('void')
    expect(matchWakePhrase('hello soul')?.persona).toBe('soul')
  })

  it('matches when the phrase is embedded in a longer transcript', () => {
    // Whisper rolling-buffer scans often catch partial context — the wake
    // phrase needs to fire even when preceded or followed by other words.
    expect(matchWakePhrase('uh hey void are you there')?.persona).toBe('void')
    expect(matchWakePhrase('hey soul whats the weather')?.persona).toBe('soul')
  })

  it('still respects word boundaries on close-but-not-listed words', () => {
    // "voiding" isn't in the alternates list AND has a trailing
    // suffix — \b boundary keeps it from matching the bare "void".
    expect(matchWakePhrase('hey voiding the form')).toBeNull()
    // NOTE: as of v1.7.5 aggressive matching, "souls" IS in the alternates
    // (Whisper plural mishears are common) so phrases like "hey souls of the
    // world" WILL fire a false wake. Trade-off accepted — silence-stop
    // closes the mic in ~5s when no follow-up speech arrives.
  })

  it('matches the v1.6+ neutral "companion" wake phrase', () => {
    // Primary post-rebrand fallback — labelled "Hey Companion" so the HUD
    // toast reflects the rebrand.
    expect(matchWakePhrase('hey companion')?.label).toBe('Hey Companion')
    expect(matchWakePhrase('okay companion')?.label).toBe('Hey Companion')
  })

  it('matches the canonical Void mistranscriptions Whisper produces', () => {
    // v1.7.5 aggressive matching — every rhyme/substring observed in
    // beta. Trade-off: more false wakes, fewer missed wakes. False
    // wakes auto-close via the 5s silence-stop if no follow-up speech.
    expect(matchWakePhrase('hey void')?.persona).toBe('void')
    expect(matchWakePhrase('hey voyd')?.persona).toBe('void')
    expect(matchWakePhrase('hey boyd')?.persona).toBe('void')
    expect(matchWakePhrase('hey boyed')?.persona).toBe('void')
    expect(matchWakePhrase('hey boy')?.persona).toBe('void')
    expect(matchWakePhrase('hey boys')?.persona).toBe('void')
    expect(matchWakePhrase('hey avoid')?.persona).toBe('void')
    expect(matchWakePhrase('hey voided')?.persona).toBe('void')
    expect(matchWakePhrase('hey devoid')?.persona).toBe('void')
  })

  it('matches the canonical Soul mistranscriptions Whisper produces', () => {
    expect(matchWakePhrase('hey soul')?.persona).toBe('soul')
    expect(matchWakePhrase('hey sole')?.persona).toBe('soul')
    expect(matchWakePhrase('hey sol')?.persona).toBe('soul')
    expect(matchWakePhrase('hey saul')?.persona).toBe('soul')
    // Rhyming-word substitutions
    expect(matchWakePhrase('hey bowl')?.persona).toBe('soul')
    expect(matchWakePhrase('hey hole')?.persona).toBe('soul')
    expect(matchWakePhrase('hey pole')?.persona).toBe('soul')
    expect(matchWakePhrase('hey role')?.persona).toBe('soul')
    expect(matchWakePhrase('hey goal')?.persona).toBe('soul')
  })

  it('tolerates the comma + punctuation Whisper inserts after the greeting', () => {
    // The exact strings beta users see in the wake-word diagnostic.
    expect(matchWakePhrase('Hey, soul.')?.persona).toBe('soul')
    expect(matchWakePhrase('Hey, Sol.')?.persona).toBe('soul')
    expect(matchWakePhrase('Hey, void.')?.persona).toBe('void')
    expect(matchWakePhrase('Hey, boy.')?.persona).toBe('void')
    expect(matchWakePhrase('hey-void')?.persona).toBe('void')
  })

  it('matches truncated tails when the audio window cut off mid-word', () => {
    // 1.6s scan window sometimes ends mid-word; Whisper renders
    // "Hey Soul" as "Hey, so..." and "Hey Void" as "Hey, vo...". Both
    // tail patterns anchor to end-of-string so they can't false-fire
    // mid-sentence ("hey so what" / "hey vote for me" stay null).
    expect(matchWakePhrase('Hey, so...')?.persona).toBe('soul')
    expect(matchWakePhrase('Hey, so')?.persona).toBe('soul')
    expect(matchWakePhrase('Hey, sou...')?.persona).toBe('soul')
    expect(matchWakePhrase('Hey, vo...')?.persona).toBe('void')
    expect(matchWakePhrase('Hey, vo')?.persona).toBe('void')
    // End-anchor guards — these should still NOT match.
    expect(matchWakePhrase('hey so what are we doing today')).toBeNull()
    expect(matchWakePhrase('hey vote for the other guy')).toBeNull()
  })

  it('keeps the legacy "assistant" alias for muscle-memory continuity', () => {
    // Pre-v1.6 beta users trained on "Hey Assistant" — kept working so the
    // rebrand doesn't silently break anyone's habit. Label still reads as
    // "Hey Assistant" so the user sees they're hitting the legacy alias.
    expect(matchWakePhrase('hey assistant')?.label).toBe('Hey Assistant')
    expect(matchWakePhrase('hey voidsoul')?.label).toBe('Hey Assistant')
  })

  it('returns null on empty / non-matching input', () => {
    expect(matchWakePhrase('')).toBeNull()
    expect(matchWakePhrase('  ')).toBeNull()
    expect(matchWakePhrase('whats the weather today')).toBeNull()
    // "hey" alone — too common to be a wake; must include a target name.
    expect(matchWakePhrase('hey there')).toBeNull()
  })

  it('void wins over soul when both somehow appear in the same transcript', () => {
    // Order in WAKE_PATTERNS makes void match first — documented behaviour
    // so a "hey void hey soul" doesn't silently flip persona depending on
    // micro-tweaks to the regex set.
    expect(matchWakePhrase('hey void hey soul')?.persona).toBe('void')
  })

  it('catches the Portuguese "É isso" hallucination as Soul', () => {
    // v1.7.3 — Whisper's `.en` checkpoint still leaks the occasional
    // Portuguese hallucination ("É isso." = "that's it") when the user
    // says "Hey Soul." `isso` doesn't collide with any English word so
    // a bare \bisso\b is safe to treat as a Soul wake without requiring
    // a greeting prefix.
    expect(matchWakePhrase('É isso.')?.persona).toBe('soul')
    expect(matchWakePhrase('é isso')?.persona).toBe('soul')
    expect(matchWakePhrase('isso')?.persona).toBe('soul')
    expect(matchWakePhrase('e isso')?.persona).toBe('soul')
    // Should NOT match — "isso" must be a standalone word, not a substring.
    expect(matchWakePhrase('missolar')).toBeNull()
    expect(matchWakePhrase('crissol')).toBeNull()
  })

  it('strips diacritics so accent-bearing Whisper output still matches', () => {
    // v1.7.3 — NFKD normalize + combining-mark strip means any future
    // accented hallucination collapses to ASCII before the regex runs.
    // Catches the next "É" / "í" / "ã" variant for free.
    expect(matchWakePhrase('héy void')?.persona).toBe('void')
    expect(matchWakePhrase('Héy, Soûl.')?.persona).toBe('soul')
  })
})
