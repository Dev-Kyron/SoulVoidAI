/**
 * Bench runner — iterates (benchmark × strategy) cells and produces
 * scored results.
 *
 * v2.0 Phase 2 polish — hoists window resolution + screenshot capture
 * to per-benchmark scope so the N strategies for one benchmark share
 * one window-resolve + (lazily) one screenshot. Previously each
 * strategy resolved + captured on its own, paying ~400ms × N for the
 * same compositor flush. UIA-only strategies still skip the capture
 * via the lazy `getShot()` thunk.
 *
 * Per-cell timeout (`CELL_TIMEOUT_MS`) protects the harness from a
 * strategy that hangs on a slow vision call — without it the user
 * sees a frozen ribbon and the runner pegs an API key budget. The
 * timeout fires an abort on the strategy's signal so well-behaved
 * strategies bail at the next await; result lands as a structured
 * error rather than a hang.
 *
 * Scoring policy:
 *   - `hit-bbox`       — predicted point sits inside the captured bbox
 *                        (the click would land where the user intended)
 *   - `hit-radius`     — bbox missed but the predicted point is within
 *                        HIT_RADIUS_PX of the centre (close enough that
 *                        a small nudge by the user would land it)
 *   - `miss`           — predicted point is far from the target
 *   - `no-prediction`  — strategy returned null (no UIA match + vision
 *                        refinement rejected, or strategy errored)
 *   - `no-ground-truth` — benchmark hasn't been captured yet; skipped
 *                         from accuracy aggregates
 *   - `display-mismatch` — ground truth was captured at a different
 *                          resolution; skipped from accuracy aggregates
 *                          (those pixel coords don't mean anything on
 *                          this monitor)
 */
import { screen } from 'electron'
import { HIT_RADIUS_PX } from './types'
import type { BenchResult, BenchRun, Benchmark, BenchmarkContext, ClickStrategy } from './types'
import { log } from '../../logger'
import { broadcast } from '../../../events'
import { invokeAbortSignal } from '../../ai/stream'
import { captureForBench, resolveWindow } from './locate'
import { enumerateClickableElements } from '../uia'
import type { CapturedScreen } from '../screenCapture'
import type { UiaElement } from '../uia'

/** Each (benchmark × strategy) cell aborts after this. Generous enough
 *  for a refined two-pass vision call plus network slop; tight enough
 *  that a hung strategy doesn't burn the harness for an hour. */
const CELL_TIMEOUT_MS = 60_000

interface RunOptions {
  benchmarks: Benchmark[]
  strategies: ClickStrategy[]
  signal: AbortSignal
}

export async function runBenchmarks(opts: RunOptions): Promise<BenchRun> {
  const startedAt = new Date().toISOString()
  const results: BenchResult[] = []
  const benchmarkTotal = opts.benchmarks.length
  const strategyTotal = opts.strategies.length
  // Captured once before the loop and held for the run. Reconfiguring
  // monitors mid-bench (unplug, dock, rotate) is unsupported — restart
  // the bench. Polling per cell would only catch ~half the cases
  // (window+cursor coords would still be stale), and the verdict
  // semantics ("matches the display the user captured against") map
  // to one display, not one-per-cell.
  const display = screen.getPrimaryDisplay()
  const currentDisplay = { w: display.size.width, h: display.size.height }

  for (let b = 0; b < benchmarkTotal; b++) {
    if (opts.signal.aborted) break
    const benchmark = opts.benchmarks[b]

    // Per-benchmark display-mismatch guard. When a benchmark was
    // captured on a different resolution the absolute pixel ground
    // truth doesn't transfer; skip scoring rather than emit garbage.
    if (benchmark.groundTruth) {
      const gt = benchmark.groundTruth
      if (gt.displayWidth !== currentDisplay.w || gt.displayHeight !== currentDisplay.h) {
        for (const strategy of opts.strategies) {
          results.push({
            benchmark,
            strategy: {
              strategyId: strategy.id,
              predicted: null,
              confidence: null,
              source: 'none',
              msElapsed: 0,
              trail: `display mismatch: bench captured at ${gt.displayWidth}×${gt.displayHeight}, current ${currentDisplay.w}×${currentDisplay.h}`,
              error: 'display-mismatch'
            },
            verdict: 'display-mismatch',
            pixelError: null,
            insideBbox: false
          })
        }
        continue
      }
    }

    // Hoisted per-benchmark prep — window match once, screenshot lazily,
    // UIA elements lazily. Each thunk caches the first call's promise so
    // concurrent waiters on a slow capture or enumeration share the
    // single in-flight request (the runner is sequential per benchmark
    // so this is belt-and-braces, but it's also the right shape).
    const target = await resolveWindow(benchmark.inWindow)
    let shotPromise: Promise<CapturedScreen> | null = null
    let uiaPromise: Promise<UiaElement[]> | null = null
    const ctx: BenchmarkContext = {
      benchmark,
      target,
      getShot: () => {
        if (!shotPromise) shotPromise = captureForBench(target)
        return shotPromise
      },
      getUiaElements: () => {
        if (!uiaPromise) {
          uiaPromise = enumerateClickableElements(undefined, undefined, target?.hwnd ?? null)
        }
        return uiaPromise
      }
    }

    for (let s = 0; s < strategyTotal; s++) {
      if (opts.signal.aborted) break
      const strategy = opts.strategies[s]
      broadcast('clickbench:progress', {
        benchmarkIndex: b,
        benchmarkTotal,
        strategyIndex: s,
        strategyTotal,
        benchmarkLabel: benchmark.label,
        strategyLabel: strategy.label
      })
      log('info', 'automation', `[clickbench] ${benchmark.id} × ${strategy.id} — running`)

      // Per-cell abort — fires when EITHER the user aborts the whole
      // run OR the cell hits its time budget. `invokeAbortSignal`
      // wraps the AbortSignal.any pattern used everywhere else in
      // the codebase (vision/locate.ts, ai/stream.ts callers), so
      // there's only one place to update if the chain logic ever
      // needs more sources.
      const cellSignal = invokeAbortSignal(opts.signal, CELL_TIMEOUT_MS)
      const strategyResult = await strategy.locate(ctx, cellSignal)
      results.push(score(benchmark, strategyResult))
    }
  }

  const finishedAt = new Date().toISOString()
  return {
    startedAt,
    finishedAt,
    strategyIds: opts.strategies.map((s) => s.id),
    results,
    summary: summarise(results, opts.strategies)
  }
}

function score(benchmark: Benchmark, strategy: BenchResult['strategy']): BenchResult {
  const gt = benchmark.groundTruth
  if (!gt) {
    return {
      benchmark,
      strategy,
      verdict: 'no-ground-truth',
      pixelError: null,
      insideBbox: false
    }
  }
  if (!strategy.predicted) {
    return {
      benchmark,
      strategy,
      verdict: 'no-prediction',
      pixelError: null,
      insideBbox: false
    }
  }
  const dx = strategy.predicted.x - gt.centerX
  const dy = strategy.predicted.y - gt.centerY
  const pixelError = Math.sqrt(dx * dx + dy * dy)
  const insideBbox =
    strategy.predicted.x >= gt.bbox.x &&
    strategy.predicted.x < gt.bbox.x + gt.bbox.w &&
    strategy.predicted.y >= gt.bbox.y &&
    strategy.predicted.y < gt.bbox.y + gt.bbox.h
  let verdict: BenchResult['verdict']
  if (insideBbox) verdict = 'hit-bbox'
  else if (pixelError <= HIT_RADIUS_PX) verdict = 'hit-radius'
  else verdict = 'miss'
  return { benchmark, strategy, verdict, pixelError, insideBbox }
}

function summarise(results: BenchResult[], strategies: ClickStrategy[]): BenchRun['summary'] {
  const out: BenchRun['summary'] = []
  for (const strategy of strategies) {
    const rows = results.filter((r) => r.strategy.strategyId === strategy.id)
    // `display-mismatch` rows are excluded from accuracy aggregates
    // alongside no-ground-truth — those pixel coords don't apply on
    // the user's current monitor so the verdict has no meaning.
    const scored = rows.filter(
      (r) => r.verdict !== 'no-ground-truth' && r.verdict !== 'display-mismatch'
    )
    const hitsBbox = scored.filter((r) => r.verdict === 'hit-bbox').length
    const hitsRadius = scored.filter((r) => r.verdict === 'hit-radius').length
    const hits = hitsBbox + hitsRadius
    const misses = scored.filter((r) => r.verdict === 'miss').length
    const noPrediction = scored.filter((r) => r.verdict === 'no-prediction').length
    const errors = rows.filter((r) => r.pixelError !== null).map((r) => r.pixelError as number)
    const avgPixelError =
      errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : null
    // v2.0 polish — display-mismatch rows write msElapsed:0 because
    // the runner short-circuits before invoking the strategy. Including
    // those zeros in avgMs drags the per-strategy mean down by up to
    // 100% on a fully-mismatched run (e.g. captured on desktop, run
    // on laptop). Exclude them from the latency average.
    const timed = rows.filter((r) => r.verdict !== 'display-mismatch')
    const mss = timed.map((r) => r.strategy.msElapsed)
    const avgMs = mss.length > 0 ? mss.reduce((a, b) => a + b, 0) / mss.length : 0
    out.push({
      strategyId: strategy.id,
      total: scored.length,
      hits,
      hitsBbox,
      hitsRadius,
      misses,
      noPrediction,
      avgPixelError,
      avgMs
    })
  }
  return out
}
