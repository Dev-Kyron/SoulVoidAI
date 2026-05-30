import { describe, expect, it } from 'vitest'
import { __test__ } from './sentiment'

const { parseClassifierOutput } = __test__

describe('parseClassifierOutput', () => {
  it('parses a clean JSON object with all fields', () => {
    const r = parseClassifierOutput(
      '{"sentiment":"stressed","intensity":4,"summary":"Crunching on the auth refactor"}'
    )
    expect(r).toEqual({
      sentiment: 'stressed',
      intensity: 4,
      summary: 'Crunching on the auth refactor'
    })
  })

  it('accepts all five known sentiment labels', () => {
    for (const label of ['stressed', 'productive', 'stuck', 'excited', 'neutral']) {
      const r = parseClassifierOutput(`{"sentiment":"${label}","intensity":3,"summary":""}`)
      expect(r?.sentiment).toBe(label)
    }
  })

  it('normalises sentiment to lowercase', () => {
    const r = parseClassifierOutput('{"sentiment":"STRESSED","intensity":3,"summary":""}')
    expect(r?.sentiment).toBe('stressed')
  })

  it('rejects unknown sentiment labels', () => {
    const r = parseClassifierOutput('{"sentiment":"happy","intensity":3,"summary":"good"}')
    expect(r).toBeNull()
  })

  it('clamps intensity to [1, 5]', () => {
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":7,"summary":""}')?.intensity
    ).toBe(5)
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":0,"summary":""}')?.intensity
    ).toBe(1)
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":-3,"summary":""}')?.intensity
    ).toBe(1)
  })

  it('rounds non-integer intensity values', () => {
    const r = parseClassifierOutput('{"sentiment":"productive","intensity":3.7,"summary":""}')
    expect(r?.intensity).toBe(4)
  })

  it('strips markdown code fences (gemini quirk)', () => {
    const r = parseClassifierOutput(
      '```json\n{"sentiment":"excited","intensity":5,"summary":"shipped"}\n```'
    )
    expect(r?.sentiment).toBe('excited')
    expect(r?.summary).toBe('shipped')
  })

  it('strips bare ``` fences too', () => {
    const r = parseClassifierOutput(
      '```\n{"sentiment":"stuck","intensity":3,"summary":"can\'t crack it"}\n```'
    )
    expect(r?.sentiment).toBe('stuck')
  })

  it('truncates oversized summary to 200 chars', () => {
    const huge = 'x'.repeat(500)
    const r = parseClassifierOutput(`{"sentiment":"neutral","intensity":1,"summary":"${huge}"}`)
    expect(r?.summary.length).toBeLessThanOrEqual(200)
  })

  it('returns null for non-JSON input', () => {
    expect(parseClassifierOutput('this is not json at all')).toBeNull()
    expect(parseClassifierOutput('')).toBeNull()
    expect(parseClassifierOutput('the user is stressed')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseClassifierOutput('{"sentiment":"neutral",')).toBeNull()
    expect(parseClassifierOutput('{not valid}')).toBeNull()
  })

  it('floors missing or non-numeric intensity to 1', () => {
    // Missing or non-numeric intensity → safest default is 1 (minimum
    // valid value), not a null reject — better to surface a weak signal
    // than discard the whole classification because of a missing number.
    expect(parseClassifierOutput('{"sentiment":"neutral","summary":""}')?.intensity).toBe(1)
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":"high","summary":""}')?.intensity
    ).toBe(1)
  })

  it('handles empty / null summary gracefully', () => {
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":1,"summary":""}')?.summary
    ).toBe('')
    expect(
      parseClassifierOutput('{"sentiment":"neutral","intensity":1,"summary":null}')?.summary
    ).toBe('')
  })

  it('trims summary whitespace', () => {
    const r = parseClassifierOutput(
      '{"sentiment":"productive","intensity":3,"summary":"  shipped a thing  "}'
    )
    expect(r?.summary).toBe('shipped a thing')
  })

  it('rejects when sentiment is not a string', () => {
    expect(parseClassifierOutput('{"sentiment":42,"intensity":3,"summary":""}')).toBeNull()
  })

  it('ignores extra fields the model might add', () => {
    const r = parseClassifierOutput(
      '{"sentiment":"productive","intensity":3,"summary":"good","confidence":0.9,"extra":"ignored"}'
    )
    expect(r).toEqual({
      sentiment: 'productive',
      intensity: 3,
      summary: 'good'
    })
  })
})
