/**
 * Click-benchmark public surface.
 *
 * Three entry points exported to the IPC layer:
 *   - listBenchmarks() — UI displays the suite
 *   - runBench(strategyIds?, benchmarkIds?) — kicks off a run; writes
 *     HTML + CSV reports to <userData>/clickbench/reports/ and opens
 *     the HTML in the user's default browser
 *   - saveBenchmark(benchmark) — capture mode writes new/edited entries
 *
 * Strategy + benchmark loaders + scoring are all in sibling files;
 * this module is intentionally thin.
 */
import { shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../logger'
import { ALL_STRATEGIES, strategyById } from './strategies'
import { loadAllBenchmarks, reportsDir, saveUserBenchmark } from './benchmarksIo'
import { renderCsvReport, renderHtmlReport } from './report'
import { runBenchmarks } from './runner'
import { captureScreen, getPrimaryDisplayInfo } from '../screenCapture'
import type { Benchmark, BenchRun, ClickStrategy, BenchmarkCategory } from './types'

const BENCHMARK_CATEGORIES: readonly BenchmarkCategory[] = [
  'labeled-native',
  'icon-only-native',
  'browser-web',
  'menu-item',
  'panel-selector'
]

export interface BenchSuiteSummary {
  /** Every benchmark on disk (seed + user, merged by id). */
  benchmarks: Array<{
    id: string
    label: string
    category: string
    hasGroundTruth: boolean
    inWindow: string | null
    capturedAt: string | null
  }>
  /** Every strategy the harness can run. */
  strategies: Array<{ id: string; label: string }>
}

export function listBenchmarks(): BenchSuiteSummary {
  const benchmarks = loadAllBenchmarks()
  return {
    benchmarks: benchmarks.map((b) => ({
      id: b.id,
      label: b.label,
      category: b.category,
      hasGroundTruth: !!b.groundTruth,
      inWindow: b.inWindow,
      capturedAt: b.capturedAt
    })),
    strategies: ALL_STRATEGIES.map((s) => ({ id: s.id, label: s.label }))
  }
}

/**
 * In-flight bench so concurrent IPC calls coalesce — the renderer's
 * Settings dialog can fire "Run all" multiple times by accident and
 * we don't want N parallel screenshots fighting for the GPU.
 *
 * Lifecycle invariant: when `abortBench()` is called, we null `inFlight`
 * IMMEDIATELY so the next `runBench()` can start a fresh run without
 * waiting for the aborted promise to settle. The aborted run still
 * resolves (with the `signal.aborted` short-circuit in the runner)
 * and writes a partial report, but it's no longer the in-flight
 * coalesce target — Phase 1 had it wait for `.finally()` which made
 * the dialog feel deadlocked after a cancel.
 */
let inFlight: { abort: () => void; promise: Promise<RunResult> } | null = null

export interface RunResult {
  run: BenchRun
  htmlPath: string
  csvPath: string
}

export async function runBench(opts: {
  strategyIds?: string[]
  benchmarkIds?: string[]
  openReportWhenDone?: boolean
}): Promise<RunResult> {
  if (inFlight) {
    log('info', 'automation', '[clickbench] joining in-flight run')
    return inFlight.promise
  }
  const controller = new AbortController()
  // Captured later so the trailing `.finally` only nulls `inFlight` when
  // it still points at THIS run — otherwise an aborted run wrapping up
  // would null a fresh run that started after the abort.
  // eslint-disable-next-line prefer-const
  let entry: { abort: () => void; promise: Promise<RunResult> } | null = null
  const promise = (async (): Promise<RunResult> => {
    const allBenchmarks = loadAllBenchmarks()
    const benchmarks = opts.benchmarkIds
      ? allBenchmarks.filter((b) => opts.benchmarkIds!.includes(b.id))
      : allBenchmarks
    const strategies: ClickStrategy[] = opts.strategyIds
      ? opts.strategyIds.map(strategyById).filter((s): s is ClickStrategy => s !== null)
      : Array.from(ALL_STRATEGIES)
    if (benchmarks.length === 0) throw new Error('No benchmarks to run.')
    if (strategies.length === 0) throw new Error('No strategies to run.')

    log(
      'info',
      'automation',
      `[clickbench] running ${benchmarks.length} bench × ${strategies.length} strategy = ${benchmarks.length * strategies.length} cells`
    )

    const run = await runBenchmarks({
      benchmarks,
      strategies,
      signal: controller.signal
    })

    const dir = reportsDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19)
    const htmlPath = join(dir, `bench-${stamp}.html`)
    const csvPath = join(dir, `bench-${stamp}.csv`)
    writeFileSync(htmlPath, renderHtmlReport(run), 'utf-8')
    writeFileSync(csvPath, renderCsvReport(run), 'utf-8')
    log('success', 'automation', `[clickbench] wrote report to ${htmlPath}`)
    if (opts.openReportWhenDone !== false) {
      // shell.openPath returns a promise that resolves to '' on success;
      // we don't await it because the renderer cares about the run
      // finishing, not the OS file-association window opening.
      void shell.openPath(htmlPath)
    }
    return { run, htmlPath, csvPath }
  })().finally(() => {
    // Only null the slot if we're still the active run. After
    // abortBench() nulls inFlight immediately, a fresh runBench() may
    // have populated it with a different entry before THIS promise
    // settled — and we must not stomp on that.
    if (inFlight === entry) inFlight = null
  })
  entry = { abort: () => controller.abort(), promise }
  inFlight = entry
  return promise
}

export function abortBench(): void {
  if (inFlight) {
    inFlight.abort()
    // Null immediately so the next runBench() doesn't coalesce against
    // a cancelled run still walking through its `.finally`. The
    // cancelled run still resolves and writes a partial report; we
    // just don't keep using it as the "current" run.
    inFlight = null
  }
}

/**
 * Persist a captured benchmark to the user tree. Throws on schema
 * issues so the IPC handler can surface them; the renderer's capture
 * dialog validates client-side too.
 */
export function saveBenchmark(b: Benchmark): string {
  if (!b.id?.trim()) throw new Error('Benchmark id is required.')
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(b.id)) {
    throw new Error('Benchmark id must be kebab-case (a-z, 0-9, hyphen).')
  }
  if (!b.label?.trim()) throw new Error('Benchmark label is required.')
  if (!b.prompt?.trim()) throw new Error('Benchmark prompt is required.')
  // v2.0 polish — fail loudly on a bad category rather than silently
  // accept a typo'd JSON edit. The 5-category union is small enough
  // that any "other" string is almost certainly a mistake.
  if (!BENCHMARK_CATEGORIES.includes(b.category)) {
    throw new Error(
      `Benchmark category "${b.category}" not recognised — expected one of: ${BENCHMARK_CATEGORIES.join(', ')}.`
    )
  }
  // Ground truth is optional (placeholder benchmarks ship without it),
  // but when present the shape must be coherent — a partially-filled
  // bbox would silently mis-score every strategy.
  if (b.groundTruth) {
    const gt = b.groundTruth
    const numeric = [
      gt.centerX,
      gt.centerY,
      gt.bbox?.x,
      gt.bbox?.y,
      gt.bbox?.w,
      gt.bbox?.h,
      gt.displayWidth,
      gt.displayHeight
    ]
    if (numeric.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error(
        'Benchmark groundTruth must have numeric centerX/Y, bbox{x,y,w,h}, displayWidth/Height.'
      )
    }
    if (gt.bbox.w <= 0 || gt.bbox.h <= 0) {
      throw new Error('Benchmark groundTruth bbox must have positive width and height.')
    }
  }
  return saveUserBenchmark(b)
}

/**
 * Capture a screenshot of the primary display, returning a data URL the
 * renderer's capture dialog can display + click on. Reuses the shared
 * `captureScreen` helper so the capture pixel grid matches the run-time
 * pixel grid exactly — `SCREENSHOT_TARGET_WIDTH` lives in one place
 * (`screenCapture.ts`).
 *
 * Returns `displayCount` so the renderer can warn the user when more
 * than one monitor is connected (capture lives on primary; running a
 * bench from a different monitor would mismatch).
 *
 * Window-hide / show is handled by the IPC layer so this function is
 * purely "capture pixels + return them".
 */
export async function captureScreenshot(): Promise<{
  dataUrl: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayCount: number
}> {
  const info = getPrimaryDisplayInfo()
  // persist:false — capture dialog overlays the dataUrl on the
  // renderer side; the saved benchmark stores derived bbox + center,
  // not the source PNG. Saving every capture would accrue ~1MB per
  // attempt with zero downstream consumer.
  const shot = await captureScreen({ saveSubdir: 'clickbench/shots', persist: false })
  return {
    dataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    displayWidth: shot.displayWidth,
    displayHeight: shot.displayHeight,
    displayCount: info.displayCount
  }
}
