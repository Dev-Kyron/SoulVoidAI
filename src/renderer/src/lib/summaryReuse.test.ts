import { describe, expect, it } from 'vitest'
import { canReuseSummary } from './summaryReuse'
import type { ChatMessage, HistorySummary } from '@shared/types'

const KEEP = 8

function msg(id: string): ChatMessage {
  return { id, role: 'user', content: id, createdAt: '2026-01-01T00:00:00.000Z' }
}

function summary(coversUpToId: string): HistorySummary {
  return {
    text: 'cached',
    coversUpToId,
    generatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('canReuseSummary', () => {
  it('returns null when no summary is cached', () => {
    expect(canReuseSummary(null, [msg('a')], KEEP)).toBeNull()
  })

  it('returns null when the boundary id is empty', () => {
    expect(canReuseSummary(summary(''), [msg('a')], KEEP)).toBeNull()
  })

  it('returns null when the boundary id is no longer in the list', () => {
    const all = [msg('a'), msg('b'), msg('c')]
    expect(canReuseSummary(summary('z'), all, KEEP)).toBeNull()
  })

  it('returns null when the boundary is the very last message (no tail left)', () => {
    const all = Array.from({ length: 20 }, (_, i) => msg(`m${i}`))
    // Boundary = the last id → tail length would be 0.
    expect(canReuseSummary(summary('m19'), all, KEEP)).toBeNull()
  })

  it('returns null when the tail is shorter than keepRecentMin', () => {
    const all = Array.from({ length: 12 }, (_, i) => msg(`m${i}`))
    // Boundary at index 8 → tail = [m9, m10, m11] = 3 messages, < 8.
    expect(canReuseSummary(summary('m8'), all, KEEP)).toBeNull()
  })

  it('returns the cutoff just past the boundary when reuse is safe', () => {
    const all = Array.from({ length: 30 }, (_, i) => msg(`m${i}`))
    const result = canReuseSummary(summary('m10'), all, KEEP)
    expect(result).toEqual({ cutoffIdx: 11 })
    // The tail handed to the model is everything from `cutoffIdx` onward.
    const tail = all.slice(result!.cutoffIdx)
    expect(tail).toHaveLength(19)
    expect(tail[0].id).toBe('m11')
  })

  it('survives a reshape that shifts the boundary index — id lookup wins', () => {
    // Before reshape: boundary "m10" was at index 10.
    // After reshape (e.g. messages prepended via backup import): boundary
    // "m10" is now at index 13 — the id-based finder still locks onto it.
    const reshaped = [
      msg('extra0'),
      msg('extra1'),
      msg('extra2'),
      msg('extra3'),
      ...Array.from({ length: 30 }, (_, i) => msg(`m${i}`))
    ]
    const result = canReuseSummary(summary('m10'), reshaped, KEEP)
    expect(result).toBeTruthy()
    expect(reshaped[result!.cutoffIdx].id).toBe('m11')
    // And there's still plenty of verbatim tail.
    expect(reshaped.length - result!.cutoffIdx).toBeGreaterThanOrEqual(KEEP)
  })

  it('handles a thread that has been trimmed back to just past the boundary', () => {
    // Exactly KEEP messages of tail — minimum reusable case.
    const tail = Array.from({ length: KEEP }, (_, i) => msg(`tail${i}`))
    const all = [msg('older0'), msg('older1'), msg('boundary'), ...tail]
    const result = canReuseSummary(summary('boundary'), all, KEEP)
    expect(result).toEqual({ cutoffIdx: 3 })
  })

  it('survives a legacy summary that still carries the dead `coversCount` field', () => {
    const all = Array.from({ length: 30 }, (_, i) => msg(`m${i}`))
    // Older app versions wrote `coversCount`. The type no longer declares it,
    // but a backup bundle imported from a v4 install could still carry it on
    // disk — the reuse predicate must ignore extra fields cleanly.
    const legacy = {
      text: 'cached',
      coversUpToId: 'm10',
      coversCount: 999,
      generatedAt: '2026-01-01T00:00:00.000Z'
    } as unknown as HistorySummary
    expect(canReuseSummary(legacy, all, KEEP)).toEqual({ cutoffIdx: 11 })
  })
})
