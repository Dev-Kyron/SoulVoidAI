/**
 * v1.12.0 — tests for the per-provider performance aggregator.
 *
 * Tests target the pure `computeProviderPerformance` function — the
 * DB-reading `getProviderPerformance` wrapper is a one-liner trivially
 * covered by the e2e path. Pure-function testing means we don't depend
 * on better-sqlite3 (which is compiled for Electron's Node, not the host
 * Node these tests run on — that's why the other storage tests skip).
 */
import { describe, it, expect } from 'vitest'
import { computeProviderPerformance } from './index'
import type { UsageEntry } from '@shared/types'

function makeEntry(over: Partial<UsageEntry>): UsageEntry {
  return {
    id: Math.random().toString(36).slice(2),
    ts: new Date().toISOString(),
    provider: 'openai',
    model: 'gpt-4',
    kind: 'chat',
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.001,
    estimated: true,
    ...over
  }
}

describe('computeProviderPerformance', () => {
  it('returns empty array when no entries exist', () => {
    expect(computeProviderPerformance([], 30)).toEqual([])
  })

  it('groups entries by provider', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai' }),
        makeEntry({ provider: 'openai' }),
        makeEntry({ provider: 'anthropic' })
      ],
      30
    )
    expect(perf).toHaveLength(2)
    const byProvider = Object.fromEntries(perf.map((p) => [p.provider, p]))
    expect(byProvider.openai.callCount).toBe(2)
    expect(byProvider.anthropic.callCount).toBe(1)
  })

  it('sorts results by callCount descending', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai' }),
        makeEntry({ provider: 'anthropic' }),
        makeEntry({ provider: 'anthropic' }),
        makeEntry({ provider: 'anthropic' })
      ],
      30
    )
    expect(perf[0].provider).toBe('anthropic')
    expect(perf[1].provider).toBe('openai')
  })

  it('excludes entries older than the window', () => {
    const now = Date.now()
    const oldTs = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString()
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', ts: oldTs }),
        makeEntry({ provider: 'openai', ts: new Date(now).toISOString() })
      ],
      30,
      now
    )
    expect(perf[0].callCount).toBe(1)
  })

  it('v1.12.4 — counts ONLY entries with explicit success field toward the rate', () => {
    // Legacy entries (no success field) used to count as successes by
    // omission, which inflated the rate during the v1.12 upgrade
    // transition. Now they're excluded from the rate calculation so the
    // dashboard reflects honest v1.12+ telemetry only. callCount still
    // counts everything so the headline number stays accurate.
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai' /* legacy: success omitted */ }),
        makeEntry({ provider: 'openai', success: true })
      ],
      30
    )
    expect(perf[0].callCount).toBe(2)
    expect(perf[0].successCount).toBe(1)
    expect(perf[0].failureCount).toBe(0)
    expect(perf[0].successRate).toBe(100)
  })

  it('successRate is null when no entry in the window has explicit success data', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai' /* no success field */ }),
        makeEntry({ provider: 'openai' /* no success field */ })
      ],
      30
    )
    expect(perf[0].callCount).toBe(2)
    expect(perf[0].successCount).toBe(0)
    expect(perf[0].failureCount).toBe(0)
    expect(perf[0].successRate).toBe(null)
  })

  it('counts explicit success: false as a failure', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', success: true }),
        makeEntry({ provider: 'openai', success: false }),
        makeEntry({ provider: 'openai', success: false })
      ],
      30
    )
    expect(perf[0].successCount).toBe(1)
    expect(perf[0].failureCount).toBe(2)
    expect(perf[0].successRate).toBeCloseTo(33.33, 1)
  })

  it('computes avg latency only from entries with durationMs', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', durationMs: 100 }),
        makeEntry({ provider: 'openai', durationMs: 200 }),
        makeEntry({ provider: 'openai' /* no timing */ })
      ],
      30
    )
    expect(perf[0].avgLatencyMs).toBe(150)
  })

  it('returns null avgLatencyMs when no timed entries exist', () => {
    const perf = computeProviderPerformance(
      [makeEntry({ provider: 'openai' }), makeEntry({ provider: 'openai' })],
      30
    )
    expect(perf[0].avgLatencyMs).toBe(null)
  })

  it('returns null p95 with fewer than 5 timed samples', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', durationMs: 100 }),
        makeEntry({ provider: 'openai', durationMs: 200 }),
        makeEntry({ provider: 'openai', durationMs: 300 }),
        makeEntry({ provider: 'openai', durationMs: 400 })
      ],
      30
    )
    expect(perf[0].p95LatencyMs).toBe(null)
  })

  it('computes p95 when at least 5 timed samples exist', () => {
    const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) =>
      makeEntry({ provider: 'openai', durationMs: ms })
    )
    const perf = computeProviderPerformance(entries, 30)
    // Floor(10 * 0.95) = 9 → sorted[9] = 100
    expect(perf[0].p95LatencyMs).toBe(100)
  })

  it('sums totalCost across all entries, treating null cost as 0', () => {
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', cost: 0.01 }),
        makeEntry({ provider: 'openai', cost: 0.02 }),
        makeEntry({ provider: 'openai', cost: null })
      ],
      30
    )
    expect(perf[0].totalCost).toBeCloseTo(0.03, 6)
  })

  it('uses the injected nowMs for windowing (determinism)', () => {
    // Two entries 100 days apart; 30-day window relative to the later one
    // should keep only the later one.
    const later = Date.parse('2025-01-01T00:00:00Z')
    const earlier = Date.parse('2024-09-01T00:00:00Z')
    const perf = computeProviderPerformance(
      [
        makeEntry({ provider: 'openai', ts: new Date(earlier).toISOString() }),
        makeEntry({ provider: 'openai', ts: new Date(later).toISOString() })
      ],
      30,
      later
    )
    expect(perf[0].callCount).toBe(1)
  })
})
