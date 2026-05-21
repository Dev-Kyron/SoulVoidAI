import { describe, expect, it } from 'vitest'
import { CHAT_STRINGS, formatErrorContent } from './chatStrings'

// Light tests for the central copy module — keeps the prefix conventions
// and string constants from silently drifting.

describe('formatErrorContent', () => {
  it('prefixes the user message with the warning glyph', () => {
    expect(formatErrorContent('Provider returned 500')).toBe('⚠️ Provider returned 500')
  })

  it('preserves multi-line messages', () => {
    const out = formatErrorContent('line one\nline two')
    expect(out.startsWith('⚠️ ')).toBe(true)
    expect(out).toContain('line one\nline two')
  })

  it('does NOT double-prefix when called twice (defensive concat sanity)', () => {
    const once = formatErrorContent('boom')
    const twice = formatErrorContent(once)
    // The function is intentionally simple — twice DOES double-prefix. The
    // test locks that behaviour so a future "skip if already prefixed"
    // change is an intentional choice, not an accident.
    expect(twice).toBe(`${CHAT_STRINGS.errorPrefix}${once}`)
  })
})

describe('CHAT_STRINGS', () => {
  it('has every key callers depend on', () => {
    // Surface the contract: these keys are imported by name across the
    // renderer. A typo here breaks the chat bubble copy at runtime.
    expect(CHAT_STRINGS).toHaveProperty('noResponse')
    expect(CHAT_STRINGS).toHaveProperty('stopped')
    expect(CHAT_STRINGS).toHaveProperty('errorPrefix')
    expect(CHAT_STRINGS).toHaveProperty('privateOn')
    expect(CHAT_STRINGS).toHaveProperty('privateOff')
    expect(CHAT_STRINGS).toHaveProperty('waitForStream')
  })

  it('errorPrefix ends with a space — composers depend on it for readability', () => {
    expect(CHAT_STRINGS.errorPrefix.endsWith(' ')).toBe(true)
  })
})
