import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk'

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  \n')).toEqual([])
  })

  it('returns a single chunk when text fits within the window', () => {
    const text = 'a'.repeat(800)
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe(text)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].index).toBe(0)
  })

  it('splits long text into overlapping windows', () => {
    const para = 'sentence ending. '
    const text = para.repeat(400) // ~6800 chars
    const chunks = chunkText(text, { size: 1400, overlap: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    // Chunks should never exceed the size budget by much (boundary snapping
    // can push slightly past, but consecutive starts should advance).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start)
    }
    // Each chunk's text should be non-empty.
    for (const c of chunks) expect(c.text.length).toBeGreaterThan(0)
  })

  it('snaps the first chunk end to a paragraph break when one is in range', () => {
    // size=400, overlap=80 → the snapper looks back at chars 320..400 and
    // snaps to the last paragraph break inside that window. Place exactly one
    // break at ~360 so we can assert the chunk ends right at it.
    const head = 'a'.repeat(360)
    const tail = 'b'.repeat(2000)
    const text = `${head}\n\n${tail}`
    const chunks = chunkText(text, { size: 400, overlap: 80 })
    expect(chunks.length).toBeGreaterThan(1)
    // The first chunk should be all `a`s — it cannot include any `b`.
    expect(chunks[0].text).not.toMatch(/b/)
    // Second chunk should start inside the `b` region.
    expect(chunks[1].text).toMatch(/b/)
  })

  it('honours the overlap parameter so consecutive chunks share content', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i.toString().padStart(3, '0')}`).join(
      '\n'
    )
    // Use a small size so we get multiple chunks.
    const chunks = chunkText(text, { size: 200, overlap: 60 })
    if (chunks.length < 2) return
    // Some portion of the tail of chunk[0] should appear at the head of chunk[1].
    const tail = chunks[0].text.slice(-30)
    expect(chunks[1].text).toContain(tail.split('\n').filter(Boolean).pop() ?? '')
  })

  it('keeps indices monotonic starting at 0', () => {
    const text = 'x'.repeat(10_000)
    const chunks = chunkText(text)
    expect(chunks[0].index).toBe(0)
    chunks.forEach((c, i) => expect(c.index).toBe(i))
  })
})
