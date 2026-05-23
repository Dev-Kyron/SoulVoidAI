import { describe, expect, it } from 'vitest'
import {
  StreamingVoiceExtractor,
  codeBlockDensity,
  fallbackSegment,
  normalizeTone,
  parseVoiceSegments,
  stripVoiceTagsOnly
} from './voiceMarkers'

/* ----------------------------- normalizeTone ----------------------------- */

describe('normalizeTone', () => {
  it('passes known tones through unchanged', () => {
    expect(normalizeTone('casual')).toBe('casual')
    expect(normalizeTone('focused')).toBe('focused')
    expect(normalizeTone('excited')).toBe('excited')
    expect(normalizeTone('serious')).toBe('serious')
    expect(normalizeTone('dry')).toBe('dry')
  })

  it('is case-insensitive', () => {
    expect(normalizeTone('CASUAL')).toBe('casual')
    expect(normalizeTone('Focused')).toBe('focused')
  })

  it('trims whitespace', () => {
    expect(normalizeTone('  excited  ')).toBe('excited')
  })

  it('defaults unknown tones to casual', () => {
    expect(normalizeTone('happy')).toBe('casual')
    expect(normalizeTone('whatever')).toBe('casual')
  })

  it('defaults missing/null to casual', () => {
    expect(normalizeTone(null)).toBe('casual')
    expect(normalizeTone(undefined)).toBe('casual')
    expect(normalizeTone('')).toBe('casual')
  })
})

/* ----------------------------- parseVoiceSegments ------------------------ */

describe('parseVoiceSegments', () => {
  it('extracts a single tagged segment', () => {
    const r = parseVoiceSegments(
      'Here is the plan.\n<voice tone="focused">Step one is the API.</voice>\nThen step two.'
    )
    expect(r.segments).toEqual([{ tone: 'focused', text: 'Step one is the API.' }])
    expect(r.stripped).toBe('Here is the plan.\nStep one is the API.\nThen step two.')
  })

  it('extracts multiple segments in document order with mixed tones', () => {
    const r = parseVoiceSegments(
      '<voice tone="casual">Hey.</voice> Middle <voice tone="serious">Now listen.</voice>'
    )
    expect(r.segments).toEqual([
      { tone: 'casual', text: 'Hey.' },
      { tone: 'serious', text: 'Now listen.' }
    ])
  })

  it('defaults to casual when tone attribute is missing', () => {
    const r = parseVoiceSegments('<voice>Just a note.</voice>')
    expect(r.segments).toEqual([{ tone: 'casual', text: 'Just a note.' }])
  })

  it('defaults to casual for unknown tones', () => {
    const r = parseVoiceSegments('<voice tone="zen">breathe</voice>')
    expect(r.segments[0].tone).toBe('casual')
  })

  it('accepts single-quoted attributes', () => {
    const r = parseVoiceSegments("<voice tone='dry'>Sure.</voice>")
    expect(r.segments[0].tone).toBe('dry')
  })

  it('accepts unquoted attributes', () => {
    const r = parseVoiceSegments('<voice tone=excited>Big news!</voice>')
    expect(r.segments[0].tone).toBe('excited')
  })

  it('tolerates loose whitespace inside the open tag', () => {
    const r = parseVoiceSegments('<voice   tone =  "focused"  >ok</voice>')
    expect(r.segments[0].tone).toBe('focused')
  })

  it('skips empty / whitespace-only segments', () => {
    const r = parseVoiceSegments('<voice tone="casual">   \n  </voice>')
    expect(r.segments).toEqual([])
  })

  it('handles nested tags by treating outer as the span + lifting inner content', () => {
    // The model SHOULDN'T do this — but if it does, don't crash and
    // don't double-extract. We keep the outer tone and strip the inner
    // tag tokens.
    const r = parseVoiceSegments(
      '<voice tone="casual">Hey <voice tone="serious">listen</voice> again.</voice>'
    )
    // Regex is non-greedy, so the FIRST </voice> closes the outer span.
    // That leaves the inner open tag in the captured content — we strip it.
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].tone).toBe('casual')
    expect(r.segments[0].text).toMatch(/Hey/)
    expect(r.segments[0].text).not.toMatch(/<voice/)
  })

  it('ignores false positives like <voicemail>', () => {
    const r = parseVoiceSegments('Check your <voicemail>inbox</voicemail> later.')
    expect(r.segments).toEqual([])
    expect(r.stripped).toContain('voicemail')
  })

  it('is tag-case-insensitive', () => {
    const r = parseVoiceSegments('<Voice tone="casual">Hi.</Voice>')
    expect(r.segments[0]).toEqual({ tone: 'casual', text: 'Hi.' })
  })

  it('trims leading and trailing whitespace inside the tag', () => {
    const r = parseVoiceSegments('<voice tone="dry">\n\n  Sure thing.  \n</voice>')
    expect(r.segments[0].text).toBe('Sure thing.')
  })

  it('preserves chat content outside tags in stripped output', () => {
    const src = 'before <voice tone="dry">whatever</voice> after'
    expect(stripVoiceTagsOnly(src)).toBe('before whatever after')
  })

  it('collapses excess blank lines around stripped tags', () => {
    const src = 'paragraph one\n\n\n<voice tone="casual">spoken</voice>\n\n\nparagraph two'
    const out = stripVoiceTagsOnly(src)
    // No more than two consecutive newlines in the output.
    expect(out).not.toMatch(/\n{3,}/)
  })

  it('returns empty result for input without any tags', () => {
    const r = parseVoiceSegments('Just plain chat with no markers at all.')
    expect(r.segments).toEqual([])
    expect(r.stripped).toBe('Just plain chat with no markers at all.')
  })

  it('drops orphan <voice> with no close tag from segments (one-shot mode)', () => {
    // Truncated stream replay — the SEGMENT_RE requires a closing tag.
    const r = parseVoiceSegments('chat <voice tone="casual">never closed')
    expect(r.segments).toEqual([])
  })
})

/* ----------------------------- streaming --------------------------------- */

describe('StreamingVoiceExtractor', () => {
  it('emits one segment from a single in-chunk pair', () => {
    const ex = new StreamingVoiceExtractor()
    const out = ex.feed('text <voice tone="casual">hello</voice> more')
    expect(out).toEqual([{ tone: 'casual', text: 'hello' }])
  })

  it('emits two segments across two feeds when both close in their chunks', () => {
    const ex = new StreamingVoiceExtractor()
    expect(ex.feed('a <voice tone="dry">one</voice>')).toEqual([
      { tone: 'dry', text: 'one' }
    ])
    expect(ex.feed(' b <voice tone="serious">two</voice>')).toEqual([
      { tone: 'serious', text: 'two' }
    ])
  })

  it('does not re-emit the same segment across feeds', () => {
    const ex = new StreamingVoiceExtractor()
    ex.feed('<voice tone="casual">a</voice>')
    expect(ex.feed('')).toEqual([])
    expect(ex.feed(' more text ')).toEqual([])
  })

  it('handles a chunk split mid-content', () => {
    const ex = new StreamingVoiceExtractor()
    expect(ex.feed('<voice tone="focused">part on')).toEqual([])
    expect(ex.feed('e and part two</voice>')).toEqual([
      { tone: 'focused', text: 'part one and part two' }
    ])
  })

  it('handles a chunk split mid-open-tag (before >)', () => {
    const ex = new StreamingVoiceExtractor()
    // Open tag broken across chunks — extractor must wait for the `>`
    // before claiming a complete open tag.
    expect(ex.feed('chat <voice tone="ex')).toEqual([])
    expect(ex.feed('cited">yay</voice>')).toEqual([
      { tone: 'excited', text: 'yay' }
    ])
  })

  it('handles a chunk split mid-attribute value', () => {
    const ex = new StreamingVoiceExtractor()
    expect(ex.feed('<voice tone="ser')).toEqual([])
    expect(ex.feed('ious">heavy</voice>')).toEqual([
      { tone: 'serious', text: 'heavy' }
    ])
  })

  it('handles a chunk ending with a partial close tag', () => {
    const ex = new StreamingVoiceExtractor()
    expect(ex.feed('<voice tone="casual">hi</voi')).toEqual([])
    expect(ex.feed('ce> after')).toEqual([{ tone: 'casual', text: 'hi' }])
  })

  it('handles many tiny chunks (worst case: one char per feed)', () => {
    const ex = new StreamingVoiceExtractor()
    const full = '<voice tone="dry">deadpan</voice>'
    let collected: ReturnType<typeof ex.feed> = []
    for (const ch of full) {
      collected = collected.concat(ex.feed(ch))
    }
    expect(collected).toEqual([{ tone: 'dry', text: 'deadpan' }])
  })

  it('drops segments with empty content (whitespace only)', () => {
    const ex = new StreamingVoiceExtractor()
    expect(ex.feed('<voice tone="casual">  </voice>')).toEqual([])
  })

  it('tolerates a malformed close tag by waiting for a real one', () => {
    const ex = new StreamingVoiceExtractor()
    // First close has a typo; second is correct — extractor doesn't
    // accept the broken one (it's looking for the literal '</voice>').
    expect(ex.feed('<voice tone="casual">hello</viceo></voice>')).toEqual([
      // The actual match: opening tag then content up to the first
      // real </voice>. The malformed </viceo> is part of the content.
      { tone: 'casual', text: 'hello</viceo>' }
    ])
  })

  it('flush returns empty when segments already emitted', () => {
    const ex = new StreamingVoiceExtractor()
    ex.feed('<voice tone="casual">a</voice>')
    expect(ex.flush()).toEqual([])
  })

  it('flush emits fallback segment when no segments seen and reply is conversational', () => {
    const ex = new StreamingVoiceExtractor()
    ex.feed('Hey, just a quick note — the build is green.\n\nWant me to push?')
    const out = ex.flush()
    expect(out).toHaveLength(1)
    expect(out[0].tone).toBe('casual')
    expect(out[0].text).toBe('Hey, just a quick note — the build is green.')
  })

  it('flush stays silent when no segments seen and reply is code-heavy', () => {
    const ex = new StreamingVoiceExtractor()
    const codeHeavy =
      'Here:\n\n```ts\n' + 'const x = 1;\n'.repeat(50) + '```\n\nDone.'
    ex.feed(codeHeavy)
    expect(ex.flush()).toEqual([])
  })

  it('flush honours fallbackOnNoTags: false', () => {
    const ex = new StreamingVoiceExtractor()
    ex.feed('A perfectly conversational reply.')
    expect(ex.flush({ fallbackOnNoTags: false })).toEqual([])
  })

  it('exposes totalChars for external diagnostics', () => {
    const ex = new StreamingVoiceExtractor()
    ex.feed('abc')
    ex.feed('defg')
    expect(ex.totalChars).toBe(7)
  })
})

/* ---------------------------- code density ------------------------------- */

describe('codeBlockDensity', () => {
  it('returns 0 for empty text', () => {
    expect(codeBlockDensity('')).toBe(0)
  })

  it('returns 0 when there are no fenced blocks', () => {
    expect(codeBlockDensity('Just prose, no code at all.')).toBe(0)
  })

  it('returns ~1 for input that is entirely a fenced block', () => {
    const code = '```\nlots of code\n```'
    expect(codeBlockDensity(code)).toBeCloseTo(1, 2)
  })

  it('returns a sensible fraction for mixed input', () => {
    // 30 chars of code in a ~70-char total → ~0.43
    const d = codeBlockDensity('intro text and then ```code block stuff``` outro')
    expect(d).toBeGreaterThan(0.3)
    expect(d).toBeLessThan(0.7)
  })
})

/* ---------------------------- fallbackSegment ---------------------------- */

describe('fallbackSegment', () => {
  it('returns first-paragraph segment for conversational reply', () => {
    const seg = fallbackSegment('First paragraph here.\n\nSecond paragraph.')
    expect(seg).toEqual({ tone: 'casual', text: 'First paragraph here.' })
  })

  it('returns null for code-heavy reply', () => {
    const code = '```\n' + 'x'.repeat(200) + '\n```\nshort'
    expect(fallbackSegment(code)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(fallbackSegment('')).toBeNull()
    expect(fallbackSegment('   ')).toBeNull()
  })

  it('caps at 400 chars to keep the fallback from monopolising TTS', () => {
    const long = 'x'.repeat(1000)
    const seg = fallbackSegment(long)
    expect(seg?.text.length).toBeLessThanOrEqual(400)
  })

  it('strips existing voice tags before deriving the paragraph', () => {
    // Edge case: a half-tagged reply where the fallback fires anyway.
    const seg = fallbackSegment('<voice tone="dry">hi</voice>\n\nNext block.')
    // The tagged content stays as part of the chat layer; fallback uses
    // the first paragraph of the stripped text. With the tag stripped
    // inline, the first paragraph is "hi" — short but valid.
    expect(seg?.text).toBeDefined()
  })
})
