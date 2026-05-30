/**
 * Tests for the shared balanced-brace JSON extractor lifted from
 * deepResearch.ts in v2.0 round 10. The original bug we fixed was a
 * GREEDY `/\{[\s\S]*\}/` regex that span the first `{` to the LAST `}`
 * in the reply — chatty providers wrap JSON in prose and the regex
 * eats both braces, JSON.parse throws, the bio/fact extractors
 * silently record nothing. These tests pin that behavior so a future
 * "simplify" pass doesn't accidentally fall back to a regex.
 */
import { describe, it, expect } from 'vitest'
import { extractFirstBalancedJsonObject } from './jsonExtract'

describe('extractFirstBalancedJsonObject', () => {
  it('extracts a bare object', () => {
    expect(extractFirstBalancedJsonObject('{"a": 1}')).toBe('{"a": 1}')
  })

  it('extracts the object even when the model wraps it in prose (the bug)', () => {
    const reply = 'Sure, here is the JSON: {"updates": [{"category": "identity", "text": "is Kyron"}]}. Note: the entries reflect what was discussed.'
    const block = extractFirstBalancedJsonObject(reply)
    expect(block).toBe('{"updates": [{"category": "identity", "text": "is Kyron"}]}')
    expect(() => JSON.parse(block!)).not.toThrow()
  })

  it('extracts the object out of a ```json fenced block', () => {
    const reply = '```json\n{"facts": ["one", "two"]}\n```'
    expect(extractFirstBalancedJsonObject(reply)).toBe('{"facts": ["one", "two"]}')
  })

  it('handles a closing brace inside a quoted string', () => {
    const reply = '{"text": "value with } in it", "ok": true}'
    expect(extractFirstBalancedJsonObject(reply)).toBe(reply)
  })

  it('handles an opening brace inside a quoted string', () => {
    const reply = '{"text": "value with { unmatched in it", "ok": true}'
    expect(extractFirstBalancedJsonObject(reply)).toBe(reply)
  })

  it('handles escaped quotes inside strings', () => {
    const reply = '{"text": "he said \\"hello\\" and left"}'
    expect(extractFirstBalancedJsonObject(reply)).toBe(reply)
  })

  it('handles nested objects', () => {
    const reply = 'noise {"a": {"b": {"c": 1}}} trailing'
    expect(extractFirstBalancedJsonObject(reply)).toBe('{"a": {"b": {"c": 1}}}')
  })

  it('returns the FIRST object when there are multiple', () => {
    const reply = '{"first": 1} ignored {"second": 2}'
    expect(extractFirstBalancedJsonObject(reply)).toBe('{"first": 1}')
  })

  it('returns null when there is no object', () => {
    expect(extractFirstBalancedJsonObject('plain text only')).toBeNull()
    expect(extractFirstBalancedJsonObject('')).toBeNull()
  })

  it('returns null for an unclosed object (incomplete stream)', () => {
    expect(extractFirstBalancedJsonObject('{"a": 1, "b": ')).toBeNull()
  })

  it('ignores stray closing braces before the first opening', () => {
    expect(extractFirstBalancedJsonObject('}}} {"a": 1}')).toBe('{"a": 1}')
  })

  it('regression — old greedy /\\{[\\s\\S]*\\}/ would have grabbed the wrong span', () => {
    // The chatty pattern that triggered the original bug. With the old
    // regex this came back as the entire `{updates...} ... }` span
    // including the trailing prose's `}`, and JSON.parse threw.
    const reply =
      'Here is what I extracted: {"updates": [{"category": "preferences", "text": "likes dark mode"}]}. Hope this {is} helpful!'
    const block = extractFirstBalancedJsonObject(reply)
    expect(block).toBe(
      '{"updates": [{"category": "preferences", "text": "likes dark mode"}]}'
    )
    expect(JSON.parse(block!)).toEqual({
      updates: [{ category: 'preferences', text: 'likes dark mode' }]
    })
  })
})
