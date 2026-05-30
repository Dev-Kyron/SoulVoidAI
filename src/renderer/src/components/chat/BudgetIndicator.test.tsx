/**
 * v2.0 — first renderer-side COMPONENT test (vs. the existing hook tests
 * in lib/). Locks down the BudgetIndicator's three contract points:
 *
 *   1. Hidden entirely when no monthly cap is configured (no clutter for
 *      users who don't track spend).
 *   2. Colour band reflects the usage percentage (green / yellow / amber
 *      / rose) — visual signal users skim without reading the number.
 *   3. Currency-aware formatter doesn't crash on weird inputs.
 *
 * Bridge is mocked at module load via `vi.mock` so the component reads
 * the test's fake `vs.usage.{summary,getBudget}` instead of the real
 * IPC layer. See test-utils.tsx for the mount helper conventions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { mountComponent, waitForAsyncEffects, type MountedComponent } from '../../test-utils'
import type { UsageBudget, UsageSummary } from '@shared/types'

// vi.mock is hoisted before the import below, so BudgetIndicator's
// `import { vs } from '../../lib/bridge'` resolves to our fake.
// Vitest 2's vi.fn uses a single function-type generic.
const summaryFn = vi.fn<() => Promise<UsageSummary>>()
const budgetFn = vi.fn<() => Promise<UsageBudget>>()
const openSettingsFn = vi.fn<() => Promise<void>>()

vi.mock('../../lib/bridge', () => ({
  vs: {
    usage: {
      summary: () => summaryFn(),
      getBudget: () => budgetFn()
    },
    window: {
      openSettings: () => openSettingsFn()
    }
  }
}))

// Imported AFTER the mock so the component picks up the fake bridge.
// eslint-disable-next-line import/first
import { BudgetIndicator } from './BudgetIndicator'

function mockBudget(monthlyUsd: number | null, currency = 'USD', usdRate = 1): UsageBudget {
  return {
    monthlyUsd,
    currency,
    usdRate,
    warned75: false,
    warned90: false,
    warned100: false,
    month: '2026-05'
  }
}

function mockSummary(totalCost: number): UsageSummary {
  return {
    totalCost,
    totalEntries: 0,
    unknownPricing: 0,
    byProvider: [],
    byModel: [],
    dailyCost: [],
    recent: [],
    windowStart: '2026-05-01T00:00:00Z',
    windowEnd: '2026-05-31T23:59:59Z'
  }
}

describe('BudgetIndicator', () => {
  let mounted: MountedComponent | null = null

  beforeEach(() => {
    summaryFn.mockReset()
    budgetFn.mockReset()
    openSettingsFn.mockReset()
  })

  afterEach(() => {
    mounted?.unmount()
    mounted = null
  })

  it('renders nothing when no budget cap is set', async () => {
    summaryFn.mockResolvedValue(mockSummary(0))
    budgetFn.mockResolvedValue(mockBudget(null))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    // No button rendered — the chip is opt-in via cap.
    expect(mounted.container.querySelector('button')).toBeNull()
  })

  it('renders nothing when cap is 0 (treated as not-set)', async () => {
    summaryFn.mockResolvedValue(mockSummary(5))
    budgetFn.mockResolvedValue(mockBudget(0))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    expect(mounted.container.querySelector('button')).toBeNull()
  })

  it('shows percentage when a cap is set', async () => {
    summaryFn.mockResolvedValue(mockSummary(50))
    budgetFn.mockResolvedValue(mockBudget(200))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('25%')
  })

  it('uses the emerald (low) band under 50% usage', async () => {
    summaryFn.mockResolvedValue(mockSummary(20))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button?.className).toContain('emerald')
  })

  it('uses the yellow (mid) band between 50% and 75%', async () => {
    summaryFn.mockResolvedValue(mockSummary(60))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button?.className).toContain('yellow')
  })

  it('uses the amber (warning) band between 75% and 90%', async () => {
    summaryFn.mockResolvedValue(mockSummary(80))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button?.className).toContain('amber')
  })

  it('uses the rose (critical) band at 90% or above', async () => {
    summaryFn.mockResolvedValue(mockSummary(95))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button?.className).toContain('rose')
  })

  it('caps displayed percentage at 100 even when spend exceeds budget', async () => {
    summaryFn.mockResolvedValue(mockSummary(150))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    expect(button?.textContent).toContain('100%')
  })

  it('honours non-USD currency in the tooltip', async () => {
    summaryFn.mockResolvedValue(mockSummary(10)) // USD
    budgetFn.mockResolvedValue(mockBudget(100, 'EUR', 0.9))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    const button = mounted.container.querySelector('button')
    // 10 USD * 0.9 = 9 EUR total; 100 USD * 0.9 = 90 EUR cap
    // Just check the title carries something EUR-shaped — exact Intl
    // formatting varies by locale.
    expect(button?.getAttribute('title')).toMatch(/€|EUR/)
  })

  it('survives an IPC failure on summary fetch (no render)', async () => {
    summaryFn.mockRejectedValue(new Error('IPC down'))
    budgetFn.mockResolvedValue(mockBudget(100))
    mounted = mountComponent(createElement(BudgetIndicator))
    await waitForAsyncEffects()
    // Best-effort fallback — chip stays hidden until next poll succeeds.
    expect(mounted.container.querySelector('button')).toBeNull()
  })
})
