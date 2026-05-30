/**
 * v2.0 — at-a-glance budget chip in the chat header.
 *
 * Pre-2.0 the spend tracker was buried in Settings → AI → Usage. Users
 * had to click in to see "how much have I burned this month" — by which
 * point they're often already past the point of caring. The 75/90/100%
 * threshold toasts (see App.tsx onBudgetWarning) catch the late stages
 * but say nothing during the slow climb.
 *
 * This chip:
 *   - Only renders when a monthly budget cap is set (no clutter for
 *     users who don't track spend)
 *   - Shows the percentage used + current dollars
 *   - Colour-codes by usage band (green / amber / red)
 *   - Clicks through to Settings → AI → Usage for the full chart
 *   - Polls every 30s while the chat panel is open so the figure
 *     reflects spend from the LAST minute, not the last app launch
 *
 * Deliberately small — the header has limited horizontal room and the
 * chip's value is "ambient awareness", not a primary surface.
 */
import { useEffect, useState } from 'react'
import { CircleDollarSign } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import type { UsageBudget, UsageSummary } from '@shared/types'

/** Refresh cadence while the chip is mounted. 30s is responsive enough
 *  for human "did I just spend a lot?" curiosity without thrashing the
 *  IPC bridge or the SQLite usage table. */
const POLL_INTERVAL_MS = 30_000

interface BudgetState {
  summary: UsageSummary | null
  budget: UsageBudget | null
}

export function BudgetIndicator(): JSX.Element | null {
  const [state, setState] = useState<BudgetState>({ summary: null, budget: null })

  useEffect(() => {
    let cancelled = false
    let intervalId: number | null = null
    const refresh = async (): Promise<void> => {
      try {
        const [summary, budget] = await Promise.all([vs.usage.summary(), vs.usage.getBudget()])
        if (cancelled) return
        setState({ summary, budget })
        // v2.0 round-5 perf — only poll if the user has actually set a
        // monthly cap. Without one the chip renders null forever; the
        // previous code still fired two IPC round-trips + a SQLite
        // usage-table aggregation every 30s for every user who never
        // configured a budget. Now: poll only when a cap exists, and
        // re-arm the interval the first time we learn one was set.
        if (!budget?.monthlyUsd || budget.monthlyUsd <= 0) {
          if (intervalId !== null) {
            window.clearInterval(intervalId)
            intervalId = null
          }
        } else if (intervalId === null) {
          intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
        }
      } catch {
        // Best-effort — the chip just renders nothing on IPC hiccups.
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (intervalId !== null) window.clearInterval(intervalId)
    }
  }, [])

  const { summary, budget } = state
  // Hide entirely when no cap is set — users who don't track spend
  // get zero header clutter from this.
  if (!summary || !budget?.monthlyUsd || budget.monthlyUsd <= 0) return null

  const pct = Math.min(100, (summary.totalCost / budget.monthlyUsd) * 100)
  const rate = budget.usdRate ?? 1
  const currency = budget.currency ?? 'USD'
  const localTotal = summary.totalCost * rate
  const localCap = budget.monthlyUsd * rate

  const colour =
    pct >= 90
      ? 'border-rose-400/60 bg-rose-500/15 text-rose-300'
      : pct >= 75
        ? 'border-amber-400/60 bg-amber-500/15 text-amber-300'
        : pct >= 50
          ? 'border-yellow-400/40 bg-yellow-500/10 text-yellow-200'
          : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'

  return (
    <button
      type="button"
      onClick={() => void vs.window.openSettings()}
      title={`${pct.toFixed(0)}% of your monthly cap used (${formatMoney(localTotal, currency)} of ${formatMoney(localCap, currency)}). Click to open Usage.`}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-medium tabular-nums transition hover:brightness-110',
        colour
      )}
    >
      <CircleDollarSign size={10} />
      {pct.toFixed(0)}%
    </button>
  )
}

/** Locale-aware money formatter. Uses the user's selected currency
 *  from the budget config so EUR users don't see "$" — UsageSettings
 *  already does this work; we just delegate to the same Intl API.
 *  Strips trailing zeros (e.g. "$12" not "$12.00") because the chip
 *  has no room for cents and the precision is meaningless at "what's
 *  my spend looking like" granularity. */
function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount >= 10 ? 0 : 2
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}
