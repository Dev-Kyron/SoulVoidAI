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

  it('does NOT fire on word fragments', () => {
    // \b boundaries — "voiding" / "souls" must not trigger.
    expect(matchWakePhrase('hey voiding the form')).toBeNull()
    expect(matchWakePhrase('hey souls of the world')).toBeNull()
  })

  it('falls back to the neutral "assistant" alias', () => {
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
})
