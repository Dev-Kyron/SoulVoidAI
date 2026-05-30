/**
 * HTML + CSV report generators for a BenchRun.
 *
 * The HTML report opens in the user's default browser via shell.openPath
 * after the run finishes — it's the artefact you'd screenshot in a
 * release blog post or a "we shipped a measurement harness" Twitter
 * thread. CSV is for when you want to pivot in Excel or feed the
 * numbers into a chart.
 *
 * Style is intentionally plain HTML — no React, no bundler, no fonts.
 * The report needs to render from a `file://` URL on any default
 * browser install, which means no `<script type="module">` and no
 * external CSS. Tables + inline styles.
 */
import type { BenchRun } from './types'

export function renderHtmlReport(run: BenchRun): string {
  const heatmap = renderSummaryTable(run)
  const cells = renderResultsTable(run)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>click_on_screen bench — ${escapeHtml(run.startedAt)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, Segoe UI, Roboto, sans-serif; max-width: 1280px; margin: 24px auto; padding: 0 16px; color: #1a1a2e; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 32px; font-size: 12px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.verdict-hit-bbox    { background: #dcfce7; color: #065f46; }
  td.verdict-hit-radius  { background: #fef9c3; color: #854d0e; }
  td.verdict-miss        { background: #fee2e2; color: #991b1b; }
  td.verdict-no-prediction { background: #f3f4f6; color: #6b7280; font-style: italic; }
  td.verdict-no-ground-truth { background: #ede9fe; color: #5b21b6; font-style: italic; }
  .trail { color: #6b7280; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
  .cat-label { color: #6366f1; font-weight: 600; }
</style>
</head>
<body>
<h1>click_on_screen — benchmark report</h1>
<p class="meta">Started ${escapeHtml(run.startedAt)} · Finished ${escapeHtml(run.finishedAt)} · ${run.strategyIds.length} strateg${run.strategyIds.length === 1 ? 'y' : 'ies'} × ${run.results.length / Math.max(1, run.strategyIds.length)} benchmark${run.results.length === run.strategyIds.length ? '' : 's'}</p>

<h2>Strategy summary</h2>
${heatmap}

<h2>Per-cell results</h2>
${cells}

</body>
</html>`
}

function renderSummaryTable(run: BenchRun): string {
  if (run.summary.length === 0) return '<p>No strategies ran.</p>'
  const rows = run.summary
    .map((s) => {
      const pct = s.total > 0 ? ((s.hits / s.total) * 100).toFixed(1) : '—'
      const bboxPct = s.total > 0 ? ((s.hitsBbox / s.total) * 100).toFixed(1) : '—'
      const err = s.avgPixelError !== null ? s.avgPixelError.toFixed(0) + 'px' : '—'
      return `<tr>
        <td>${escapeHtml(s.strategyId)}</td>
        <td class="num">${s.total}</td>
        <td class="num">${s.hits} <span style="color:#6b7280">(${pct}%)</span></td>
        <td class="num">${s.hitsBbox} <span style="color:#6b7280">(${bboxPct}%)</span></td>
        <td class="num">${s.hitsRadius}</td>
        <td class="num">${s.misses}</td>
        <td class="num">${s.noPrediction}</td>
        <td class="num">${err}</td>
        <td class="num">${s.avgMs.toFixed(0)}ms</td>
      </tr>`
    })
    .join('')
  return `<table>
<thead><tr>
  <th>Strategy</th><th>Scored</th><th>Hits (any)</th><th>Hits in bbox</th><th>Hits in radius</th><th>Miss</th><th>No prediction</th><th>Avg error</th><th>Avg latency</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`
}

function renderResultsTable(run: BenchRun): string {
  const rows = run.results
    .map((r) => {
      const predicted = r.strategy.predicted
        ? `(${r.strategy.predicted.x}, ${r.strategy.predicted.y})`
        : '—'
      const gt = r.benchmark.groundTruth
        ? `(${r.benchmark.groundTruth.centerX}, ${r.benchmark.groundTruth.centerY})`
        : '—'
      const err = r.pixelError !== null ? r.pixelError.toFixed(0) + 'px' : '—'
      const conf =
        r.strategy.confidence !== null ? (r.strategy.confidence * 100).toFixed(0) + '%' : '—'
      return `<tr>
        <td><strong>${escapeHtml(r.benchmark.label)}</strong><div class="cat-label">${escapeHtml(r.benchmark.category)}</div></td>
        <td>${escapeHtml(r.strategy.strategyId)}</td>
        <td class="verdict-${r.verdict} num">${escapeHtml(r.verdict)}</td>
        <td class="num">${predicted}</td>
        <td class="num">${gt}</td>
        <td class="num">${err}</td>
        <td class="num">${conf}</td>
        <td class="num">${r.strategy.msElapsed}ms</td>
        <td class="trail">${escapeHtml(r.strategy.trail)}${r.strategy.error ? '\nERROR: ' + escapeHtml(r.strategy.error) : ''}</td>
      </tr>`
    })
    .join('')
  return `<table>
<thead><tr>
  <th>Benchmark</th><th>Strategy</th><th>Verdict</th><th>Predicted</th><th>Ground truth</th><th>Error</th><th>Conf</th><th>ms</th><th>Trail</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`
}

export function renderCsvReport(run: BenchRun): string {
  const head = [
    'benchmark_id',
    'benchmark_label',
    'category',
    'strategy_id',
    'verdict',
    'predicted_x',
    'predicted_y',
    'ground_truth_x',
    'ground_truth_y',
    'pixel_error',
    'confidence',
    'ms_elapsed',
    'source',
    'error'
  ].join(',')
  const rows = run.results.map((r) =>
    [
      r.benchmark.id,
      csvEscape(r.benchmark.label),
      r.benchmark.category,
      r.strategy.strategyId,
      r.verdict,
      r.strategy.predicted?.x ?? '',
      r.strategy.predicted?.y ?? '',
      r.benchmark.groundTruth?.centerX ?? '',
      r.benchmark.groundTruth?.centerY ?? '',
      r.pixelError !== null ? r.pixelError.toFixed(1) : '',
      r.strategy.confidence !== null ? r.strategy.confidence.toFixed(3) : '',
      r.strategy.msElapsed,
      r.strategy.source,
      csvEscape(r.strategy.error ?? '')
    ].join(',')
  )
  return [head, ...rows].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}
