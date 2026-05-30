/**
 * Locate-only entry points extracted from visualClick.ts.
 *
 * The production click pipeline goes locate → preview → click. The
 * benchmark harness needs only the locate half — it scores predicted
 * coordinates against ground truth, never actually clicks. Strategy
 * adapters call these helpers so the harness measures the SAME code
 * paths the production pipeline uses, just without the cursor side-
 * effects.
 *
 * Design notes:
 *   - The screenshot capture lives in `automation/screenCapture.ts`
 *     (shared with the production pipeline) — bench numbers reflect
 *     production-realistic resolution + projection.
 *   - Refinement remains authoritative — if refine says "target not in
 *     this crop", locateVisionRefined returns null, same as production.
 *     Trusting refinement was the v1.9.6 design decision; we preserve
 *     it so bench numbers reflect the actual user-facing behaviour.
 *   - Each entry point returns its trail string for the report — a
 *     small lift over the production code path, which logged to the
 *     structured logger instead of returning the trail to the caller.
 */
import { captureScreen, REFINE_CROP } from '../screenCapture'
import type { CapturedScreen } from '../screenCapture'
import { locateElement } from '../../vision/locate'
import { enumerateClickableElements } from '../uia'
import { matchUiaElement } from '../uiaMatch'
import { enumerateWindows, focusWindow } from '../windowManager'
import { matchWindow } from '../windowMatch'

export type { CapturedScreen } from '../screenCapture'

export interface ResolvedWindow {
  hwnd: number
  x: number
  y: number
  w: number
  h: number
  title: string
  trail: string
}

/**
 * Resolves `in_window` to a target window handle. Returns null when no
 * match or when no hint was supplied. Mirrors visualClick's logic —
 * fuzzy match, soft-fall to global on a miss, focus the matched window
 * with the same 250ms wait so UIA reads a stable tree.
 */
export async function resolveWindow(inWindow: string | null): Promise<ResolvedWindow | null> {
  if (!inWindow) return null
  const windows = await enumerateWindows()
  const winMatch = matchWindow(windows, inWindow)
  if (!winMatch) return null
  if (!winMatch.window.focused) {
    await focusWindow(winMatch.window.hwnd)
    await new Promise((r) => setTimeout(r, 250))
  }
  return {
    hwnd: winMatch.window.hwnd,
    x: winMatch.window.x,
    y: winMatch.window.y,
    w: winMatch.window.w,
    h: winMatch.window.h,
    title: winMatch.window.title,
    trail: `window matched: "${winMatch.window.title}"`
  }
}

/**
 * UIA-only locate. Returns the matched element's centre in LOGICAL
 * display pixels, or null when no usable match (after the v1.9.3
 * container rejection).
 *
 * `elements` is optional — when omitted, this fetches them itself.
 * The bench harness passes pre-enumerated elements from the
 * BenchmarkContext cache so cross-strategy runs don't re-PowerShell;
 * the production click pipeline doesn't have a context object, so
 * the default-fetch path stays.
 */
export async function locateUia(args: {
  description: string
  targetWindowHwnd: number | null
  elements?: import('../uia').UiaElement[]
}): Promise<{
  predicted: { x: number; y: number } | null
  confidence: number | null
  trail: string
}> {
  const start = Date.now()
  const elements =
    args.elements ??
    (await enumerateClickableElements(undefined, undefined, args.targetWindowHwnd ?? null))
  const enumMs = Date.now() - start
  if (elements.length === 0) {
    return {
      predicted: null,
      confidence: null,
      trail: `UIA returned 0 elements in ${enumMs}ms`
    }
  }
  const match = matchUiaElement(elements, args.description)
  if (!match) {
    return {
      predicted: null,
      confidence: null,
      trail: `UIA enumerated ${elements.length} elements in ${enumMs}ms — no match for "${args.description}"`
    }
  }
  return {
    predicted: {
      x: match.element.x + Math.round(match.element.w / 2),
      y: match.element.y + Math.round(match.element.h / 2)
    },
    confidence: match.confidence,
    trail: `UIA matched "${match.element.name || match.element.automationId}" (${match.element.controlType}) conf ${(match.confidence * 100).toFixed(0)}%`
  }
}

/**
 * Captures a screenshot scoped to the target window when one is
 * resolved, else the primary display. Thin wrapper around the shared
 * `captureScreen` helper — kept here as a named export so the bench
 * runner can hoist captures to per-benchmark scope without strategies
 * having to know about the shared module.
 */
export async function captureForBench(target: ResolvedWindow | null): Promise<CapturedScreen> {
  // persist:false — the bench scores predicted coords against ground
  // truth, never displays the captured pixels back to the user. One
  // audit shot per (benchmark × strategy) cell would accrue ~1MB per
  // cell per run with no analytical value (the report carries trail
  // strings + verdicts, which are the actually-useful records).
  return captureScreen({
    window: target ? { x: target.x, y: target.y, w: target.w, h: target.h } : null,
    saveSubdir: 'clickbench/shots',
    persist: false
  })
}

/**
 * Vision-only locate with the two-pass refinement contract preserved.
 * Returns the refined point in LOGICAL DISPLAY pixels (window origin
 * already added back in for windowed captures), or null when:
 *   - first pass said "couldn't find",
 *   - refinement said "target not in this crop" (authoritative reject).
 *
 * Trail strings carry the same diagnostic content visualClick logs:
 * first-pass coords, refine outcome, latencies.
 */
export async function locateVisionRefined(args: {
  shot: CapturedScreen
  description: string
  signal: AbortSignal
}): Promise<{
  predicted: { x: number; y: number } | null
  confidence: number | null
  source: 'vision-first' | 'vision-refined' | 'none'
  trail: string
}> {
  const { shot, description } = args
  const firstStart = Date.now()
  const firstPass = await locateElement({
    screenshotDataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    description,
    signal: args.signal
  })
  const firstMs = Date.now() - firstStart
  if (!firstPass.ok) {
    return {
      predicted: null,
      confidence: null,
      source: 'none',
      trail: `vision first-pass FAILED in ${firstMs}ms: ${firstPass.reason}`
    }
  }
  // Refinement crop, same as visualClick.refineLocate.
  const cropSize = Math.min(REFINE_CROP, shot.width, shot.height)
  const cropX = Math.max(0, Math.min(Math.round(firstPass.x - cropSize / 2), shot.width - cropSize))
  const cropY = Math.max(
    0,
    Math.min(Math.round(firstPass.y - cropSize / 2), shot.height - cropSize)
  )
  const cropped = shot.image.crop({ x: cropX, y: cropY, width: cropSize, height: cropSize })
  const cropDims = cropped.getSize()
  const refineStart = Date.now()
  const refined = await locateElement({
    screenshotDataUrl: `data:image/png;base64,${cropped.toPNG().toString('base64')}`,
    width: cropDims.width,
    height: cropDims.height,
    description,
    refinement: true,
    signal: args.signal
  })
  const refineMs = Date.now() - refineStart
  if (!refined.ok) {
    // v1.9.6 — refinement is authoritative. Production refuses the
    // click here; the bench reports first-pass in the trail but
    // returns null predicted so the score correctly counts this as
    // "no prediction" (matching production user-facing outcome).
    return {
      predicted: null,
      confidence: null,
      source: 'none',
      trail: `vision first-pass (${firstPass.x}, ${firstPass.y}) conf ${(firstPass.confidence * 100).toFixed(0)}% in ${firstMs}ms — refinement REJECTED in ${refineMs}ms: ${refined.reason}`
    }
  }
  // Project crop-local refined coords back to screenshot space, then
  // back to display space using the screenshot ratio.
  const scrX = cropX + refined.x
  const scrY = cropY + refined.y
  const ratio = shot.width / Math.max(1, shot.displayWidth)
  const displayX = Math.round(scrX / ratio) + shot.windowOriginX
  const displayY = Math.round(scrY / ratio) + shot.windowOriginY
  return {
    predicted: { x: displayX, y: displayY },
    confidence: refined.confidence,
    source: 'vision-refined',
    trail: `vision first-pass (${firstPass.x}, ${firstPass.y}) conf ${(firstPass.confidence * 100).toFixed(0)}% in ${firstMs}ms; refined to (${scrX}, ${scrY}) conf ${(refined.confidence * 100).toFixed(0)}% in ${refineMs}ms`
  }
}
