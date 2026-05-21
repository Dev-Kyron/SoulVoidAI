/**
 * Usage & cost panel. Lives in Settings. Shows month-to-date dollar spend,
 * per-model breakdown, recent calls, and the optional monthly budget — with
 * a progress bar that turns amber at 75%, red at 100%.
 *
 * Numbers are estimates: tokens are derived from text length unless the
 * provider reports them. The bar is for budget discipline, not exact billing.
 */
import { useCallback, useEffect, useState } from 'react'
import { DollarSign, AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { CollapsibleSection } from './CollapsibleSection'
import { DailySpendChart, ProviderShareBar } from './UsageChart'
import { cn, relativeTime } from '../../lib/utils'
import type { UsageBudget, UsageSummary } from '@shared/types'

function dollars(value: number, digits = 2): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `<$0.01`
  return `$${value.toFixed(digits)}`
}

export function UsageSettings(): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [budget, setBudget] = useState<UsageBudget | null>(null)
  const [draftBudget, setDraftBudget] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [s, b] = await Promise.all([vs.usage.summary(), vs.usage.getBudget()])
    setSummary(s)
    setBudget(b)
    setDraftBudget(b.monthlyUsd != null ? String(b.monthlyUsd) : '')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSetBudget = async (): Promise<void> => {
    const value = draftBudget.trim()
    const amount = value === '' ? null : Number(value)
    if (amount != null && (Number.isNaN(amount) || amount < 0)) {
      pushToast('error', 'Budget must be a positive number or empty.')
      return
    }
    const next = await vs.usage.setBudget(amount)
    setBudget(next)
    pushToast(
      'success',
      amount == null
        ? 'Monthly budget cleared.'
        : `Monthly budget set to $${amount.toFixed(2)}.`
    )
  }

  const handleClear = async (): Promise<void> => {
    await vs.usage.clear()
    setConfirmClear(false)
    await refresh()
    pushToast('info', 'Usage history cleared.')
  }

  if (!summary || !budget) {
    return (
      <CollapsibleSection
        title="Usage & Cost"
        hint="Estimated dollar spend across all providers this month."
      >
        <p className="text-[11px] text-slate-500">Loading…</p>
      </CollapsibleSection>
    )
  }

  const monthName = new Date().toLocaleDateString([], { month: 'long', year: 'numeric' })
  const pct = budget.monthlyUsd
    ? Math.min(100, (summary.totalCost / budget.monthlyUsd) * 100)
    : null
  const barColor =
    pct == null
      ? 'bg-[var(--accent)]'
      : pct >= 100
        ? 'bg-rose-500'
        : pct >= 75
          ? 'bg-amber-400'
          : 'bg-[var(--accent)]'

  return (
    <CollapsibleSection
      title="Usage & Cost"
      hint="Estimated dollar spend per provider/model this month. Tokens are estimated from message length; image generation is billed per call. Set a monthly budget below to get warnings at 75% / 90% / 100%."
    >
      <div className="space-y-3">
        {/* Header — month total + refresh */}
        <div className="flex items-end justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {monthName}
            </p>
            <p className="mt-0.5 font-display text-[22px] font-semibold text-white tabular-nums">
              {dollars(summary.totalCost)}
            </p>
            <p className="text-[10px] text-slate-500">
              across {summary.totalEntries} call{summary.totalEntries === 1 ? '' : 's'}
              {summary.unknownPricing > 0 &&
                ` · ${summary.unknownPricing} with unknown pricing`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        {/* Daily spend chart */}
        <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Daily spend
            </span>
            <span className="text-[9px] text-slate-500">{monthName}</span>
          </div>
          <DailySpendChart dailyCost={summary.dailyCost} />
          {summary.byProvider.length > 0 && (
            <div className="mt-2.5 border-t border-white/5 pt-2.5">
              <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                By provider
              </p>
              <ProviderShareBar
                byProvider={summary.byProvider}
                total={summary.totalCost}
              />
            </div>
          )}
        </div>

        {/* Budget */}
        <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <DollarSign size={12} className="text-[var(--accent)]" />
            <span className="text-[11px] font-semibold text-slate-200">Monthly budget</span>
            {pct != null && pct >= 75 && (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                  pct >= 100
                    ? 'bg-rose-500/15 text-rose-300'
                    : 'bg-amber-400/15 text-amber-300'
                )}
              >
                <AlertTriangle size={9} />
                {Math.round(pct)}%
              </span>
            )}
          </div>
          {pct != null && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className={cn('h-full rounded-full transition-all', barColor)}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-500">USD / month</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={draftBudget}
              onChange={(e) => setDraftBudget(e.target.value)}
              placeholder="off"
              className="w-24 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 tabular-nums outline-none focus:border-[var(--accent-ring)]"
            />
            <button
              type="button"
              onClick={() => void handleSetBudget()}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[10px] font-semibold text-white transition hover:brightness-110"
            >
              Save
            </button>
            {budget.monthlyUsd != null && (
              <span className="ml-auto text-[10px] text-slate-500">
                {dollars(Math.max(0, budget.monthlyUsd - summary.totalCost))} left
              </span>
            )}
          </div>
        </div>

        {/* Per-model breakdown */}
        {summary.byModel.length > 0 && (
          <div>
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              By model
            </p>
            <div className="space-y-1">
              {summary.byModel.slice(0, 8).map((row) => (
                <div
                  key={row.model}
                  className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-[10px]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-200">
                    {row.model}
                  </span>
                  <span className="text-slate-500 tabular-nums">
                    {row.tokens.toLocaleString()} tok · {row.entries}×
                  </span>
                  <span className="w-14 text-right font-semibold text-white tabular-nums">
                    {dollars(row.cost, row.cost < 1 ? 3 : 2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent calls */}
        {summary.recent.length > 0 && (
          <div>
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Recent activity
            </p>
            <div className="scrollbar-void max-h-44 space-y-1 overflow-y-auto pr-1">
              {summary.recent.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-[10px]"
                >
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide',
                      entry.kind === 'image' && 'bg-magenta-500/20 text-pink-300',
                      entry.kind === 'invoke' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
                      entry.kind === 'chat' && 'bg-white/10 text-slate-300',
                      entry.kind === 'embedding' && 'bg-emerald-500/10 text-emerald-300'
                    )}
                  >
                    {entry.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-300">
                    {entry.model}
                  </span>
                  <span className="shrink-0 text-slate-500 tabular-nums">
                    {entry.inputTokens.toLocaleString()}↑{' '}
                    {entry.outputTokens.toLocaleString()}↓
                  </span>
                  <span className="w-14 shrink-0 text-right text-slate-400 tabular-nums">
                    {relativeTime(entry.ts)}
                  </span>
                  <span className="w-12 shrink-0 text-right font-semibold text-white tabular-nums">
                    {entry.cost != null ? dollars(entry.cost, 3) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reset */}
        {confirmClear ? (
          <div className="flex items-center gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-2">
            <AlertTriangle size={12} className="shrink-0 text-rose-400" />
            <span className="flex-1 text-[10px] text-slate-200">Wipe all usage history?</span>
            <button
              type="button"
              onClick={() => void handleClear()}
              className="rounded px-2 py-0.5 text-[10px] font-semibold text-rose-400 transition hover:bg-rose-500/20"
            >
              Wipe
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="rounded px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        ) : (
          summary.totalEntries > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 text-[10px] text-slate-500 transition hover:text-rose-400"
            >
              <Trash2 size={10} />
              Clear usage history
            </button>
          )
        )}

        <p className="text-[9px] italic text-slate-600">
          Estimates only. Token counts are derived from text length and image counts; the actual
          API bill may differ by a few percent. Pricing refreshed late-2025.
        </p>
      </div>
    </CollapsibleSection>
  )
}
