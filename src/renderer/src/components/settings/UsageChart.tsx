/**
 * Hand-rolled SVG charts for the cost dashboard. Two visualisations:
 *
 *  - **Daily spend bars** — one bar per day of the current month, height
 *    scaled to that day's USD total. Lets the user spot anomaly days at
 *    a glance ("that Tuesday I left web_search running on a loop").
 *  - **Provider share** — stacked horizontal bar + legend. Shows which
 *    provider ate which share of the month's spend.
 *
 * No chart-library dependency — at this scale (one panel, two charts) the
 * 20 KB of `recharts` or `victory` is bigger than the implementation. The
 * SVG palette flows through the existing `--accent` variable so the chart
 * follows the user's accent and theme choices.
 */
import type { UsageSummary } from '@shared/types'

function dollars(value: number, digits = 2): string {
  if (value === 0) return '$0'
  if (value < 0.01) return '<$0.01'
  return `$${value.toFixed(digits)}`
}

/** Daily spend bar chart for the current month. */
export function DailySpendChart({
  dailyCost
}: {
  dailyCost: UsageSummary['dailyCost']
}): JSX.Element {
  const max = dailyCost.reduce((acc, d) => Math.max(acc, d.cost), 0)
  const monthLabel =
    dailyCost.length > 0
      ? new Date(dailyCost[0].date).toLocaleDateString([], { month: 'long' })
      : ''

  if (max === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-white/10 text-[10px] text-slate-500">
        No spend recorded for {monthLabel || 'this month'} yet.
      </div>
    )
  }

  // Bar layout — fixed pixel sizing tuned to the settings column width.
  const width = 320
  const height = 64
  const padX = 4
  const gap = 1
  const dayCount = dailyCost.length
  const barWidth = (width - padX * 2 - gap * (dayCount - 1)) / dayCount

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Daily spend for ${monthLabel}`}
      className="block h-16 w-full"
    >
      {dailyCost.map(({ date, cost }, i) => {
        const h = cost === 0 ? 1 : Math.max(1, (cost / max) * (height - 6))
        const x = padX + i * (barWidth + gap)
        const y = height - h
        const isPeak = cost > 0 && cost === max
        const d = new Date(date)
        return (
          <rect
            key={date}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={1}
            // `fill-[var(--accent)]/40` doesn't compose — Tailwind's alpha
            // modifier needs a palette-tracked colour, not an arbitrary
            // CSS var. Use the SVG `fillOpacity` attribute instead so the
            // off-peak bars actually look fainter.
            className="fill-[var(--accent)]"
            fillOpacity={isPeak ? 1 : 0.4}
          >
            <title>
              {`${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${dollars(cost, 3)}`}
            </title>
          </rect>
        )
      })}
    </svg>
  )
}

const PROVIDER_PALETTE = [
  'var(--accent)',
  '#22d3ee',
  '#22c55e',
  '#f59e0b',
  '#f43f5e',
  '#a855f7',
  '#3b82f6',
  '#14b8a6'
] as const

/** Stacked horizontal bar — provider share of total spend. */
export function ProviderShareBar({
  byProvider,
  total
}: {
  byProvider: UsageSummary['byProvider']
  total: number
}): JSX.Element | null {
  if (total <= 0 || byProvider.length === 0) return null
  const ordered = [...byProvider].sort((a, b) => b.cost - a.cost)
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/5">
        {ordered.map((row, i) => {
          const pct = (row.cost / total) * 100
          if (pct < 0.5) return null
          return (
            <div
              key={row.provider}
              title={`${row.provider} — ${dollars(row.cost)} (${pct.toFixed(1)}%)`}
              style={{
                width: `${pct}%`,
                background: PROVIDER_PALETTE[i % PROVIDER_PALETTE.length]
              }}
            />
          )
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2 text-[9px]">
        {ordered.slice(0, 6).map((row, i) => (
          <span key={row.provider} className="flex items-center gap-1 text-slate-400">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: PROVIDER_PALETTE[i % PROVIDER_PALETTE.length] }}
            />
            {row.provider} · {dollars(row.cost)}
          </span>
        ))}
      </div>
    </div>
  )
}
