/**
 * Click-benchmark schemas.
 *
 * The harness measures every strategy's locate accuracy against a fixed
 * suite of benchmarks. Each benchmark is one click intent + the ground
 * truth answer (where it actually is on screen). Strategies run blind
 * — they don't see the ground truth — and the runner scores each one's
 * prediction against the truth.
 *
 * Authoring lifecycle:
 *   1. User runs `Settings → Experimental → Click Benchmark → Capture`
 *      against a target they care about (e.g. the Slack send button).
 *   2. Capture mode takes a screenshot and surfaces an in-app overlay
 *      where the user clicks the target and drags a bounding box.
 *   3. Result lands as `benchmarks/user/<id>.json` (gitignored — every
 *      user's screen layout is unique, so the truth is per-machine).
 *   4. Re-runs of the harness reuse the saved screenshot path so
 *      "vision" benchmarks become reproducible — every strategy
 *      always sees the same pixels, the same time.
 *
 * Seed benchmarks ship with placeholder coords + an instruction note;
 * the user re-captures them once for their own monitor before the
 * numbers mean anything for their setup.
 */

/**
 * Capability categories let the report break out "where does each
 * strategy actually help vs hurt". These match the user-facing failure
 * modes we've already identified.
 */
/**
 * Canonical list of benchmark categories. Declared `as const` so the
 * `BenchmarkCategory` union derives from the runtime array — adding a
 * new category requires only ONE edit instead of two (the array + the
 * union string). Runtime validation (`saveBenchmark`) consumes the
 * same array, so an unknown category can never reach storage.
 *
 * Semantics:
 *  - labeled-native:    UI-toolkit native button with a screen-reader
 *                       label (Slack Send, Discord Send, File Explorer
 *                       toolbar). Tests UIA's strongest case.
 *  - icon-only-native:  Native icon-only button — Office toolbar
 *                       buttons, VS Code activity-bar icons. Tests
 *                       UIA accessibility-label coverage.
 *  - browser-web:       Browser-embedded chat / web-app button. UIA
 *                       only sees the outer pane → tests the "must
 *                       fall through to vision" path.
 *  - menu-item:         Right-click menu item, popup menu, expanding
 *                       submenu. Tests the v1.9.4 positional-hint
 *                       prompt + UIA window-scope.
 *  - panel-selector:    Sidebar / panel selector — tree items, nav
 *                       rail tabs. Tests the v1.9.3 container-
 *                       rejection logic (sidebar containers shouldn't
 *                       count as the click target).
 */
export const BENCHMARK_CATEGORIES = [
  'labeled-native',
  'icon-only-native',
  'browser-web',
  'menu-item',
  'panel-selector'
] as const

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number]

/**
 * Ground truth — the right answer. Captured ONCE per benchmark by the
 * user against their monitor; reused across every strategy + every run
 * so accuracy comparisons are like-for-like.
 *
 * Coordinates are LOGICAL display pixels — same space the click
 * pipeline operates in (visualClick.ts comment header explains why
 * Windows hands these back even on 200%-scaled monitors).
 */
export interface BenchmarkGroundTruth {
  /** Target's centre point — strategies are scored against this. */
  centerX: number
  centerY: number
  /** Bounding box of the target. A predicted point inside the bbox
   *  counts as a "soft hit" (good enough for the click to land);
   *  outside but within HIT_RADIUS_PX of centre counts as a "near
   *  miss"; outside both is a fail. */
  bbox: { x: number; y: number; w: number; h: number }
  /** Display size at capture time so the runner can reject benchmarks
   *  captured on a different monitor (their pixels won't align). */
  displayWidth: number
  displayHeight: number
}

/**
 * One benchmark = one click intent against one application surface.
 */
export interface Benchmark {
  /** kebab-case id — also the JSON filename. */
  id: string
  /** Human label rendered in the report ("Slack — Send message"). */
  label: string
  /** The exact intent string passed to the `click_on_screen` tool, as if
   *  the user said it. Strategies see this verbatim — no fixup. */
  prompt: string
  category: BenchmarkCategory
  /** Optional `in_window` value to scope UIA + vision. Mirrors the
   *  click_on_screen tool's argument. */
  inWindow: string | null
  /** Captured-at-author-time screenshot reference. The runner does NOT
   *  use this for execution (it always captures a fresh screenshot at
   *  run-time so the bench reflects current screen state); it's
   *  rendered in the report so the user can sanity-check what they
   *  thought the target looked like vs what the strategy actually saw. */
  referenceScreenshotPath: string | null
  groundTruth: BenchmarkGroundTruth | null
  /** Free-text note shown in the report — typically setup instructions
   *  ("Open Slack, navigate to the #general channel, ensure the
   *  compose box is empty"). */
  notes: string | null
  /** Author's ISO timestamp — surfaces drift detection in the report
   *  ("ground truth captured 6 months ago — re-capture?"). */
  capturedAt: string | null
}

/**
 * What a strategy returns for one benchmark run.
 */
export interface StrategyResult {
  /** Strategy id (`uia-only`, `vision-only`, etc). */
  strategyId: string
  /** Predicted click point in LOGICAL display pixels, or null on
   *  failure (no UIA match + no vision result). */
  predicted: { x: number; y: number } | null
  /** Locate confidence in [0, 1], as reported by the underlying
   *  strategy. Null if the strategy doesn't expose one. */
  confidence: number | null
  /** Which sub-path produced the result — useful to break out per-
   *  source accuracy in the report. `computer-use` and `uia-pick` were
   *  added in v2.0 Phase 2/3 so the bench can distinguish:
   *    - `uia`         — pure matchUiaElement, no model call
   *    - `uia-pick`    — vision model picked from UIA candidate list
   *                       (Phase 3); coords still from UIA bbox, but a
   *                       model decided WHICH bbox
   *    - `vision-*`    — free-form pixel locate via vision model
   *    - `computer-use`— Sonnet computer-use grounded click
   *    - `none`        — no commit
   */
  source: 'uia' | 'uia-pick' | 'vision-first' | 'vision-refined' | 'computer-use' | 'none'
  /** Wall-clock cost of the full strategy run, from "start locating"
   *  to "predicted point ready". */
  msElapsed: number
  /** One-line trail for the report ("UIA matched 'Send button' (Button)
   *  conf 100%" / "UIA had 47 candidates, none matched — vision
   *  refined to (892, 1402) conf 80%"). */
  trail: string
  /** Set when the strategy hit an unexpected error (PowerShell missing,
   *  provider returned non-JSON, etc). predicted is null in that case. */
  error: string | null
}

/**
 * Hit-radius threshold for "near miss". A predicted point further than
 * this from the ground-truth centre AND outside the bbox counts as a
 * miss. 30px ≈ a small icon-button's radius — close enough that the
 * click would still land if the user nudged.
 */
export const HIT_RADIUS_PX = 30

/**
 * One row in the report = a single (benchmark × strategy) cell.
 *
 * `verdict` is the computed outcome from the strategy's prediction vs
 * the ground truth. The runner doesn't make policy decisions ("which
 * strategy is best for icons") — it just scores hits and dumps; the
 * report aggregates.
 */
export interface BenchResult {
  benchmark: Benchmark
  strategy: StrategyResult
  verdict:
    | 'hit-bbox'
    | 'hit-radius'
    | 'miss'
    | 'no-prediction'
    | 'no-ground-truth'
    /** v2.0 — ground truth was captured at a different resolution than
     *  the current monitor. Pixel coords don't transfer; we skip the
     *  cell from scoring rather than report a misleading miss. */
    | 'display-mismatch'
  /** Euclidean distance from predicted centre to ground-truth centre,
   *  or null when one of them is missing. */
  pixelError: number | null
  /** True when the prediction sits inside the bbox. */
  insideBbox: boolean
}

/**
 * One full run of the harness over the benchmark suite.
 */
export interface BenchRun {
  startedAt: string
  finishedAt: string
  /** Strategies the user selected for this run. */
  strategyIds: string[]
  /** Per-cell results. */
  results: BenchResult[]
  /** Per-strategy aggregate counts the report renders as a heatmap. */
  summary: Array<{
    strategyId: string
    total: number
    hits: number
    hitsBbox: number
    hitsRadius: number
    misses: number
    noPrediction: number
    avgPixelError: number | null
    avgMs: number
  }>
}

/**
 * Per-benchmark prep that strategies share. The runner resolves the
 * target window once and captures the screenshot lazily; strategies
 * pull whichever pieces they need. Lets the harness avoid:
 *   - resolving the same window 3× (once per strategy)
 *   - taking 3 separate desktopCapturer screenshots when 1 would do
 * UIA-only strategies don't call `getShot()` so we don't pay for a
 * capture on benchmarks where no strategy needs vision.
 */
export interface BenchmarkContext {
  benchmark: Benchmark
  /** Resolved target window, if any. Null when no `inWindow` hint, or
   *  hint matched no open window (the harness mirrors production's
   *  soft-fall: log the miss but proceed with global UIA). */
  target: ResolvedTargetWindow | null
  /** Lazy screenshot — first call captures, subsequent calls return
   *  the cached shot. Strategies that only use UIA never invoke it,
   *  so an all-UIA-success run skips the GPU compositor entirely. */
  getShot(): Promise<import('../screenCapture').CapturedScreen>
  /** v2.0 Phase 3 polish — lazy UIA enumeration. Mirror of `getShot`:
   *  the first strategy to need clickable elements pays for the
   *  PowerShell round-trip (~200-800ms); subsequent strategies on the
   *  same benchmark reuse the cached array. A 5-strategy bench run
   *  with 3 UIA-touching strategies previously paid for 3 redundant
   *  enumerations per benchmark (~600-2400ms wasted on a 20-benchmark
   *  suite, total). */
  getUiaElements(): Promise<import('../uia').UiaElement[]>
}

export interface ResolvedTargetWindow {
  hwnd: number
  x: number
  y: number
  w: number
  h: number
  title: string
  trail: string
}

/**
 * Strategy interface — every adapter implements this so the runner
 * iterates them generically.
 */
export interface ClickStrategy {
  id: string
  label: string
  /** Run the strategy against the benchmark. MUST NOT actually click
   *  (no moveMouse / mouseClick). MUST tolerate a torn-down screen
   *  (the user might minimise the target app between runs); return
   *  StrategyResult with `error` set rather than throwing.
   *
   *  Receives a shared `BenchmarkContext` so the runner can hoist
   *  window resolution + screenshot capture above the strategy loop. */
  locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult>
}

// v2.0 Phase 2 — `ClickStrategyMode` lives in @shared/types so the
// renderer's Settings picker and main-process router import the same
// union. Re-exported here for callers that want the strategy types
// alongside the bench types.
export type { ClickStrategyMode } from '@shared/types'
