/**
 * Public API for the cost tracker. Records every billable API call, returns
 * monthly summaries, and fires renderer notifications when configured budget
 * thresholds are crossed (75% / 90% / 100%).
 */
import { randomUUID } from 'node:crypto'
import {
  appendEntry,
  clearEntries,
  getBudget,
  getEntries,
  markWarned,
  setBudget
} from './store'
import { pricingFor, estimateTokensFromText, TOKENS_PER_IMAGE } from '../pricing/models'
import { broadcast } from '../../events'
import type {
  ProviderId,
  ProviderPerformance,
  UsageBudget,
  UsageEntry,
  UsageKind,
  UsageSummary
} from '@shared/types'

interface RecordInput {
  provider: ProviderId
  model: string
  kind: UsageKind
  inputText?: string
  outputText?: string
  inputTokens?: number
  outputTokens?: number
  imageCount?: number
  imageSize?: string
  estimated?: boolean
  /** v1.12.0 — wall-clock time from request issue to response, in ms.
   *  Optional so legacy callers without timing capture still work. */
  durationMs?: number
  /** v1.12.0 — false when the provider call errored. Default true keeps
   *  the existing success-path callers no-op. */
  success?: boolean
  /** v1.12.0 — short error category (e.g. "401 unauthorized", "timeout").
   *  Set when `success=false`; ignored on the success path. */
  errorKind?: string
}

/** Records one billable call. Computes cost, persists, fires budget warnings. */
export function recordUsage(input: RecordInput): UsageEntry {
  const inputTokens =
    input.inputTokens ??
    (input.inputText ? estimateTokensFromText(input.inputText) : 0) +
      (input.imageCount && input.kind !== 'image' ? input.imageCount * TOKENS_PER_IMAGE : 0)
  const outputTokens =
    input.outputTokens ?? (input.outputText ? estimateTokensFromText(input.outputText) : 0)

  // Image-generation calls use a synthetic model key like `dall-e-3-1024`
  // so the pricing table can carry per-size flat rates.
  const lookupModel =
    input.kind === 'image' && input.imageSize
      ? `dall-e-3-${input.imageSize.split('x')[0]}`
      : input.model
  const pricing = pricingFor(input.provider, lookupModel)

  let cost: number | null = null
  if (pricing) {
    const tokenCost =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    const imageCost = (pricing.image ?? 0) * (input.imageCount ?? 0)
    cost = tokenCost + imageCost
  }

  const entry: UsageEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    provider: input.provider,
    model: input.model,
    kind: input.kind,
    inputTokens,
    outputTokens,
    cost,
    estimated: input.estimated ?? true,
    ...(input.imageCount ? { imageCount: input.imageCount } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(input.success != null ? { success: input.success } : {}),
    ...(input.errorKind ? { errorKind: input.errorKind } : {})
  }
  appendEntry(entry)
  checkBudgetThresholds()
  return entry
}

function monthStart(): Date {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
}

export function getSummary(): UsageSummary {
  const all = getEntries()
  const since = monthStart()
  const month = all.filter((e) => new Date(e.ts) >= since)

  const byProviderMap = new Map<ProviderId, { cost: number; entries: number }>()
  const byModelMap = new Map<
    string,
    { provider: ProviderId; cost: number; entries: number; tokens: number }
  >()
  let totalCost = 0
  let unknownPricing = 0

  // Daily totals — one bucket per calendar day in this month so the chart can
  // render zero-spend days at the same width as the others. Local timezone
  // matters here (a late-night session shouldn't split across two bars).
  const daysInMonth = new Date(
    since.getFullYear(),
    since.getMonth() + 1,
    0
  ).getDate()
  const dailyCost: Array<{ date: string; cost: number }> = []
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(since.getFullYear(), since.getMonth(), d)
    dailyCost.push({ date: date.toISOString(), cost: 0 })
  }

  for (const e of month) {
    if (e.cost == null) {
      unknownPricing++
    } else {
      totalCost += e.cost
      const ts = new Date(e.ts)
      const dayIdx = ts.getDate() - 1
      if (dayIdx >= 0 && dayIdx < dailyCost.length) {
        dailyCost[dayIdx].cost += e.cost
      }
    }
    const pp = byProviderMap.get(e.provider) ?? { cost: 0, entries: 0 }
    pp.cost += e.cost ?? 0
    pp.entries++
    byProviderMap.set(e.provider, pp)

    const mm = byModelMap.get(e.model) ?? {
      provider: e.provider,
      cost: 0,
      entries: 0,
      tokens: 0
    }
    mm.cost += e.cost ?? 0
    mm.entries++
    mm.tokens += e.inputTokens + e.outputTokens
    byModelMap.set(e.model, mm)
  }

  return {
    totalCost,
    totalEntries: month.length,
    unknownPricing,
    byProvider: Array.from(byProviderMap.entries())
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.cost - a.cost),
    byModel: Array.from(byModelMap.entries())
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    dailyCost,
    recent: month.slice(-20).reverse(),
    windowStart: since.toISOString(),
    windowEnd: new Date().toISOString()
  }
}

export function getBudgetState(): UsageBudget {
  return getBudget()
}

export function updateBudget(
  monthlyUsd: number | null,
  opts: { currency?: string; usdRate?: number } = {}
): UsageBudget {
  return setBudget(monthlyUsd, opts)
}

export function clearUsage(): void {
  clearEntries()
}

/**
 * v1.12.0 — pure aggregator. Exported separately from the DB-reading
 * `getProviderPerformance` so the rules below can be pinned by unit
 * tests without needing better-sqlite3 (which is compiled for Electron's
 * Node, not the host Node the tests run on).
 *
 * Aggregation rules:
 *  - Window = entries with ts >= now() - days. Inclusive of partial day.
 *  - successCount counts entries with explicit `success: true` OR legacy
 *    entries with no success field (treated as success-by-omission so
 *    upgrading the app doesn't make every historical call read as a
 *    failure).
 *  - failureCount counts only explicit `success: false`.
 *  - successRate is null when callCount == 0 (avoids 0/0).
 *  - Latency aggregates ignore entries without durationMs (legacy or
 *    image-gen with no captured timing). avgLatencyMs is null when zero
 *    timed entries; p95LatencyMs is null with fewer than 5 timed entries
 *    (too few to be meaningful — surfacing it would mislead).
 *  - Results sorted by callCount descending so the most-used providers
 *    surface first ("of the providers I actually use, which performs
 *    best").
 */
export function computeProviderPerformance(
  entries: UsageEntry[],
  days: number,
  nowMs: number = Date.now()
): ProviderPerformance[] {
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000
  const recent = entries.filter((e) => new Date(e.ts).getTime() >= cutoffMs)

  const grouped = new Map<ProviderId, UsageEntry[]>()
  for (const e of recent) {
    const bucket = grouped.get(e.provider)
    if (bucket) bucket.push(e)
    else grouped.set(e.provider, [e])
  }

  const results: ProviderPerformance[] = []
  for (const [provider, providerEntries] of grouped) {
    const failureCount = providerEntries.filter((e) => e.success === false).length
    const successCount = providerEntries.length - failureCount
    const totalCost = providerEntries.reduce((sum, e) => sum + (e.cost ?? 0), 0)

    // Only timed entries contribute to latency math. Sort ascending once
    // so both the mean and p95 read from the same sorted view (a single
    // pass is cheaper than two sorts for the same window).
    const latencies = providerEntries
      .filter((e): e is UsageEntry & { durationMs: number } => typeof e.durationMs === 'number')
      .map((e) => e.durationMs)
      .sort((a, b) => a - b)

    const avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length)
        : null
    // p95 needs at least 5 samples to be meaningful — fewer and a single
    // outlier swings the percentile wildly enough to mislead.
    const p95LatencyMs =
      latencies.length >= 5
        ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : null

    results.push({
      provider,
      callCount: providerEntries.length,
      successCount,
      failureCount,
      successRate:
        providerEntries.length > 0 ? (successCount / providerEntries.length) * 100 : null,
      avgLatencyMs,
      p95LatencyMs,
      totalCost
    })
  }

  return results.sort((a, b) => b.callCount - a.callCount)
}

/** Thin DB-reading wrapper around the pure aggregator. The renderer
 *  calls this via IPC; tests exercise `computeProviderPerformance`
 *  directly. */
export function getProviderPerformance(days: number): ProviderPerformance[] {
  return computeProviderPerformance(getEntries(), days)
}

/** Fires a renderer toast when the configured budget threshold is first hit. */
function checkBudgetThresholds(): void {
  const budget = getBudget()
  if (!budget.monthlyUsd || budget.monthlyUsd <= 0) return
  const { totalCost } = getSummary()
  const pct = (totalCost / budget.monthlyUsd) * 100
  if (pct >= 100 && !budget.warned100) {
    markWarned(100)
    broadcast('usage:budget-warning', {
      level: 100,
      total: totalCost,
      budget: budget.monthlyUsd
    })
  } else if (pct >= 90 && !budget.warned90) {
    markWarned(90)
    broadcast('usage:budget-warning', {
      level: 90,
      total: totalCost,
      budget: budget.monthlyUsd
    })
  } else if (pct >= 75 && !budget.warned75) {
    markWarned(75)
    broadcast('usage:budget-warning', {
      level: 75,
      total: totalCost,
      budget: budget.monthlyUsd
    })
  }
}
