/**
 * Usage & cost panel. Lives in Settings. Shows month-to-date dollar spend,
 * per-model breakdown, recent calls, and the optional monthly budget — with
 * a progress bar that turns amber at 75%, red at 100%.
 *
 * Numbers are estimates: tokens are derived from text length unless the
 * provider reports them. The bar is for budget discipline, not exact billing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DollarSign,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Activity,
  Check,
  X as XIcon,
  Clock,
  TrendingUp
} from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { CollapsibleSection } from './CollapsibleSection'
import { SectionHint } from '../common/ui'
import { DailySpendChart, ProviderShareBar } from './UsageChart'
import { cn, relativeTime } from '../../lib/utils'
import {
  CURRENCIES,
  formatLocal,
  formatUsdAsLocal,
  getCurrencyMeta,
  localToUsd,
  type CurrencyCode
} from '../../lib/currencies'
import type { ProviderPerformance, UsageBudget, UsageSummary } from '@shared/types'

/** v1.12.0 — formatter factory honouring the user's budget currency + rate.
 *  Replaces the old USD-only dollar helper. Returns a function so the
 *  component can pass it down to subcomponents (performance dashboard,
 *  chart tooltip) without each one needing to know about the budget shape. */
function makeFormatter(
  currency: CurrencyCode,
  usdRate: number
): (usd: number, digits?: number) => string {
  return (usd, digits = 2) => {
    if (usd === 0) return formatLocal(0, currency, digits)
    return formatUsdAsLocal(usd, currency, usdRate)
  }
}

export function UsageSettings(): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [budget, setBudget] = useState<UsageBudget | null>(null)
  const [draftBudget, setDraftBudget] = useState('')
  // v1.12.0 — draft currency + rate live in component state so the user
  // can tinker with the dropdown / rate field before committing via Save.
  // Initialised from the loaded budget on every refresh.
  const [draftCurrency, setDraftCurrency] = useState<CurrencyCode>('USD')
  const [draftRate, setDraftRate] = useState('1')
  const [confirmClear, setConfirmClear] = useState(false)
  const [performance, setPerformance] = useState<ProviderPerformance[]>([])
  const [performanceWindow, setPerformanceWindow] = useState<7 | 30 | 90>(30)

  const refresh = useCallback(async (): Promise<void> => {
    const [s, b, p] = await Promise.all([
      vs.usage.summary(),
      vs.usage.getBudget(),
      vs.usage.providerPerformance(performanceWindow)
    ])
    setSummary(s)
    setBudget(b)
    const currency = (b.currency as CurrencyCode) ?? 'USD'
    const usdRate = b.usdRate ?? 1
    setDraftCurrency(currency)
    setDraftRate(String(usdRate))
    // Budget input shows the local-currency equivalent of the stored USD
    // amount — what the user thinks of as "their budget".
    setDraftBudget(b.monthlyUsd != null ? (b.monthlyUsd * usdRate).toFixed(2) : '')
    setPerformance(p)
  }, [performanceWindow])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSetBudget = async (): Promise<void> => {
    const rate = Number(draftRate)
    if (!isFinite(rate) || rate <= 0) {
      pushToast('error', 'Exchange rate must be a positive number.')
      return
    }
    const value = draftBudget.trim()
    const localAmount = value === '' ? null : Number(value)
    if (localAmount != null && (Number.isNaN(localAmount) || localAmount < 0)) {
      pushToast('error', 'Budget must be a positive number or empty.')
      return
    }
    // Storage is always canonical USD — local input divided by the rate
    // the user told us about. The percent bar reads totalCost (USD) /
    // monthlyUsd (USD) so no per-render conversion is needed for the bar.
    const monthlyUsd = localAmount != null ? localToUsd(localAmount, rate) : null
    const next = await vs.usage.setBudget(monthlyUsd, {
      currency: draftCurrency,
      usdRate: rate
    })
    setBudget(next)
    pushToast(
      'success',
      localAmount == null
        ? 'Monthly budget cleared.'
        : `Monthly budget set to ${formatLocal(localAmount, draftCurrency, 2)}.`
    )
  }

  const handleClear = async (): Promise<void> => {
    await vs.usage.clear()
    setConfirmClear(false)
    await refresh()
    pushToast('info', 'Usage history cleared.')
  }

  // v1.12.0 — currency-aware formatter. Built from the COMMITTED budget
  // (not the draft) so all the always-visible numbers honour what's
  // saved; the draft values only affect the budget input panel itself.
  // CRITICAL: this useMemo MUST live above the early return for the
  // loading state — putting hooks after a conditional return is a
  // hooks-order violation that crashes the whole component tree on
  // the second render. Default values cover the !budget loading case.
  const currentCurrency = ((budget?.currency as CurrencyCode | undefined) ?? 'USD')
  const currentRate = budget?.usdRate ?? 1
  const fmt = useMemo(
    () => makeFormatter(currentCurrency, currentRate),
    [currentCurrency, currentRate]
  )

  /** v1.12.0 — auto-save on currency change so every display in the
   *  panel flips immediately. Picking EUR from the dropdown shouldn't
   *  require finding the Save button just to see numbers in your
   *  currency. The default reference rate for the new currency is
   *  committed atomically; the user can refine it later via the rate
   *  input + Save. Budget amount stays unchanged (canonical USD), so
   *  the budgeted EUR figure recomputes against the new rate. */
  const handleCurrencyChange = async (next: CurrencyCode): Promise<void> => {
    const newRate = getCurrencyMeta(next).defaultUsdRate
    setDraftCurrency(next)
    setDraftRate(String(newRate))
    // Persist immediately so the committed `budget` (which drives the
    // formatter) updates and all display sites re-render in the new
    // currency in the same tick.
    const persisted = await vs.usage.setBudget(budget?.monthlyUsd ?? null, {
      currency: next,
      usdRate: newRate
    })
    setBudget(persisted)
    // Refresh the budget input to show the equivalent in the new currency.
    setDraftBudget(
      persisted.monthlyUsd != null ? (persisted.monthlyUsd * newRate).toFixed(2) : ''
    )
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
              {fmt(summary.totalCost)}
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
            <span className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Daily spend
              <SectionHint text="Bar per calendar day this month, scaled to the day with the highest spend. Empty days render as zero-height bars so the rhythm of the month is visible." />
            </span>
            <span className="text-[9px] text-slate-500">{monthName}</span>
          </div>
          <DailySpendChart dailyCost={summary.dailyCost} />
          {summary.byProvider.length > 0 && (
            <div className="mt-2.5 border-t border-white/5 pt-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                By provider
                <SectionHint text="Share of this month's spend split across providers. Stacked bar means one strip per provider sized to their slice of the total." />
              </p>
              <ProviderShareBar
                byProvider={summary.byProvider}
                total={summary.totalCost}
              />
            </div>
          )}
        </div>

        {/* v1.12.0 — Provider performance dashboard. Surfaces the
          * latency / success-rate / cost trade-off per provider so the
          * user can pick a favourite based on data, not vibes. Empty
          * state shows when no rows match (e.g. fresh install with no
          * recorded calls yet) — keeps the panel from rendering an
          * empty bordered box. */}
        <ProviderPerformanceDashboard
          performance={performance}
          windowDays={performanceWindow}
          onWindowChange={setPerformanceWindow}
        />

        {/* Budget */}
        <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <DollarSign size={12} className="text-[var(--accent)]" />
            <span className="text-[11px] font-semibold text-slate-200">Monthly budget</span>
            <SectionHint text="Optional spending cap. Pick a currency to display everything in (the dropdown change is instant — no Save needed). Override the rate if your bank applies a different one. The progress bar warns at 75% / 90% / 100% of the limit." />
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
          {/* v1.12.0 — currency-aware budget controls. Two rows:
            *   1) currency dropdown + "1 USD = X" rate input (hidden for USD)
            *   2) amount + Save + remaining
            * Single Save commits all three so the user can adjust currency,
            * rate, AND amount in one shot without partial state confusion. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500">Currency</span>
              <select
                value={draftCurrency}
                onChange={(e) => void handleCurrencyChange(e.target.value as CurrencyCode)}
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
                title="Display currency. Picking a new currency immediately flips every number in this panel. Provider APIs always bill in USD."
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
              {draftCurrency !== 'USD' && (
                <>
                  <span className="ml-2 text-[10px] text-slate-500">1 USD =</span>
                  <input
                    type="number"
                    min={0}
                    step="0.0001"
                    value={draftRate}
                    onChange={(e) => setDraftRate(e.target.value)}
                    title={`Exchange rate. Default ${getCurrencyMeta(draftCurrency).defaultUsdRate} ${draftCurrency}/USD — override with your bank's rate.`}
                    className="w-24 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 tabular-nums outline-none focus:border-[var(--accent-ring)]"
                  />
                  <span className="text-[10px] text-slate-500">{draftCurrency}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500">{draftCurrency} / month</span>
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
                  {fmt(Math.max(0, budget.monthlyUsd - summary.totalCost))} left
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Per-model breakdown */}
        {summary.byModel.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              By model
              <SectionHint text="Per-model rollup of this month's spend. Token counts are estimated from message length unless the provider returned exact numbers." />
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
                    {fmt(row.cost, row.cost < 1 ? 3 : 2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent calls */}
        {summary.recent.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Recent activity
              <SectionHint text="The 20 most recent API calls — provider, model, token counts, cost, and time. Useful for spotting an unexpectedly expensive call right after it happens." />
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
                    {entry.cost != null ? fmt(entry.cost, 3) : '—'}
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

/* -------------------- Provider Performance Dashboard -------------------- */

/** Format milliseconds as a compact human string (1.2s / 480ms / 12.3s). */
function formatLatency(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

/** Pick a success-rate colour. Greener = healthier; amber for soft
 *  trouble; rose for outright unreliable. The thresholds split at 99% /
 *  90% so a provider that's only "mostly working" reads as cautionary
 *  even when most calls succeed. */
function successRateColor(rate: number | null): string {
  if (rate == null) return 'text-slate-400'
  if (rate >= 99) return 'text-emerald-300'
  if (rate >= 90) return 'text-amber-300'
  return 'text-rose-300'
}

function ProviderPerformanceDashboard({
  performance,
  windowDays,
  onWindowChange
}: {
  performance: ProviderPerformance[]
  windowDays: 7 | 30 | 90
  onWindowChange: (days: 7 | 30 | 90) => void
}): JSX.Element {
  // Sort by callCount desc was already done in the aggregator. Showing
  // the top 8 keeps the panel from sprawling when many providers are
  // active; users with more diverse usage can still see the rest in the
  // raw "Recent activity" list below.
  const rows = performance.slice(0, 8)

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Activity size={12} className="text-[var(--accent)]" />
        <span className="text-[11px] font-semibold text-slate-200">Provider performance</span>
        <SectionHint text="Per-provider rollup over a rolling window. Calls = total requests; Success = % that returned a usable response; Avg/p95 = wall-clock latency for successful calls; Cost = USD spent. Use it to decide which provider to favour." />
        <span className="text-[9px] text-slate-500">latency · success · cost</span>
        {/* Window toggle — three short pills. Defaulting to 30d matches
          * the spec; 7d for "what's broken right now" and 90d for "what
          * has the long track record". */}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-white/10 bg-black/30 p-0.5">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onWindowChange(d)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[9px] font-semibold transition',
                windowDays === d
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-2 text-[10px] text-slate-500">
          No calls recorded in the last {windowDays} days. Send a message to start tracking.
        </p>
      ) : (
        <>
          {/* Column headers — tiny labels so the row data dominates. */}
          <div className="mb-1 grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
            <span>Provider</span>
            <span className="w-10 text-right">Calls</span>
            <span className="w-12 text-right">Success</span>
            <span className="w-16 text-right">Avg / p95</span>
            <span className="w-14 text-right">Cost</span>
          </div>
          <div className="space-y-1">
            {rows.map((row) => (
              <div
                key={row.provider}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 rounded-md bg-white/[0.03] px-2 py-1.5 text-[10px]"
              >
                <span className="min-w-0 truncate font-mono text-slate-200">{row.provider}</span>
                <span className="w-10 text-right text-slate-300 tabular-nums">
                  {row.callCount}
                </span>
                <span
                  className={cn(
                    'flex w-12 items-center justify-end gap-0.5 font-semibold tabular-nums',
                    successRateColor(row.successRate)
                  )}
                  title={`${row.successCount} ok · ${row.failureCount} failed`}
                >
                  {row.failureCount === 0 ? (
                    <Check size={9} />
                  ) : row.successRate != null && row.successRate < 90 ? (
                    <XIcon size={9} />
                  ) : (
                    <TrendingUp size={9} />
                  )}
                  {row.successRate != null ? `${row.successRate.toFixed(0)}%` : '—'}
                </span>
                <span
                  className="flex w-16 items-center justify-end gap-0.5 text-slate-300 tabular-nums"
                  title={
                    row.p95LatencyMs != null
                      ? `avg ${formatLatency(row.avgLatencyMs)} · p95 ${formatLatency(row.p95LatencyMs)}`
                      : `avg ${formatLatency(row.avgLatencyMs)}`
                  }
                >
                  <Clock size={9} className="text-slate-500" />
                  {formatLatency(row.avgLatencyMs)}
                  {row.p95LatencyMs != null && (
                    <span className="text-slate-500">/{formatLatency(row.p95LatencyMs)}</span>
                  )}
                </span>
                <span className="w-14 text-right font-semibold text-white tabular-nums">
                  {row.totalCost > 0
                    ? row.totalCost < 0.01
                      ? '<$0.01'
                      : `$${row.totalCost.toFixed(row.totalCost < 1 ? 3 : 2)}`
                    : '—'}
                </span>
              </div>
            ))}
          </div>
          {/* Footnote — keeps the legend honest. Latency only includes
            * recorded successful calls (failures don't always capture
            * timing); p95 only shows with 5+ samples. */}
          <p className="mt-2 text-[9px] italic text-slate-600">
            Latency from successful calls with recorded timing. p95 needs 5+ samples to surface.
          </p>
        </>
      )}
    </div>
  )
}
