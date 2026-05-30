/**
 * Strategy: UIA-then-vision (current production pipeline).
 *
 * Replays exactly what `performVisualClick` does today: UIA-match
 * (scoped to the target window when in_window is set) → on miss,
 * UIA-pick (textual Set-of-Marks, v2.0 Phase 3) → on miss/refusal,
 * vision two-pass refinement. This is the baseline EVERY other
 * strategy is benchmarked against — improvements need to beat THIS
 * column.
 *
 * v2.0 Phase 3 polish — the production pipeline added a uia-pick
 * intermediate step (visualClick.ts step 0.6) between UIA-match-miss
 * and the vision fallback. The bench's "current" baseline MUST mirror
 * production exactly, otherwise the bench overstates the improvement
 * of any strategy that compares against it. Caught by the Phase 3
 * reuse-review pass.
 */
import { locateViaUiaPick } from '../../uiaPickLocate'
import { locateUia, locateVisionRefined } from '../locate'
import type { BenchmarkContext, ClickStrategy, StrategyResult } from '../types'

export const uiaThenVisionStrategy: ClickStrategy = {
  id: 'uia-then-vision',
  label: 'UIA → Pick → Vision (current)',
  async locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult> {
    const start = Date.now()
    try {
      // Step 1 — UIA exact match. Pull the cached enumeration so the
      // bench doesn't re-PowerShell for each UIA-touching strategy.
      const elements = await ctx.getUiaElements()
      const uia = await locateUia({
        description: ctx.benchmark.prompt,
        targetWindowHwnd: ctx.target?.hwnd ?? null,
        elements
      })
      if (uia.predicted) {
        return {
          strategyId: 'uia-then-vision',
          predicted: uia.predicted,
          confidence: uia.confidence,
          source: 'uia',
          msElapsed: Date.now() - start,
          trail: [ctx.target?.trail, uia.trail].filter(Boolean).join('; '),
          error: null
        }
      }

      // Step 2 — UIA-pick. Reuses the cached enumeration from step 1
      // (no second PowerShell round-trip). Asks the model to pick from
      // candidates with the screenshot as visual context. Coords come
      // from UIA's bbox → zero pixel error when the model picks
      // correctly. Mirrors visualClick.ts step 0.6.
      if (elements.length > 0) {
        const shot = await ctx.getShot()
        const pick = await locateViaUiaPick({
          shot,
          description: ctx.benchmark.prompt,
          elements,
          signal
        })
        if (pick.predicted) {
          return {
            strategyId: 'uia-then-vision',
            predicted: pick.predicted,
            confidence: null,
            // 'uia-pick' source — coords came from UIA's bbox but the
            // vision model decided WHICH one. Distinct from pure
            // matchUiaElement ('uia') so the report can break out
            // hit-rate per engine.
            source: 'uia-pick',
            msElapsed: Date.now() - start,
            trail: [ctx.target?.trail, uia.trail, pick.trail].filter(Boolean).join('; '),
            error: null
          }
        }
      }

      // Step 3 — vision two-pass refinement (unchanged).
      const shot = await ctx.getShot()
      const vision = await locateVisionRefined({
        shot,
        description: ctx.benchmark.prompt,
        signal
      })
      return {
        strategyId: 'uia-then-vision',
        predicted: vision.predicted,
        confidence: vision.confidence,
        source: vision.source,
        msElapsed: Date.now() - start,
        trail: [ctx.target?.trail, uia.trail, vision.trail].filter(Boolean).join('; '),
        error: null
      }
    } catch (err) {
      return {
        strategyId: 'uia-then-vision',
        predicted: null,
        confidence: null,
        source: 'none',
        msElapsed: Date.now() - start,
        trail: 'threw',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
