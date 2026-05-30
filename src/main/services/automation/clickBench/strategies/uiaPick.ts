/**
 * Strategy: UIA-pick (textual Set-of-Marks).
 *
 * v2.0 Phase 3 of the click_on_screen plan. Lets the bench measure
 * the candidate-pick approach against the existing UIA-then-vision
 * baseline and Sonnet computer-use. See `automation/uiaPickLocate.ts`
 * for the full design rationale.
 *
 * What this strategy measures:
 *   - When UIA enumerates SOME candidates but matchUiaElement returns
 *     no usable match, does asking the vision model to PICK from the
 *     list outperform free-form vision-locate?
 *   - Coord error is zero when the model picks correctly (we use the
 *     UIA bbox center). So the column's avg-pixel-error tells us how
 *     OFTEN the model picks wrong, not by how much.
 *
 * Failure modes folded into StrategyResult, not thrown — same as the
 * other strategies.
 */
import { locateViaUiaPick } from '../../uiaPickLocate'
import type { BenchmarkContext, ClickStrategy, StrategyResult } from '../types'

export const uiaPickStrategy: ClickStrategy = {
  id: 'uia-pick',
  label: 'UIA pick (textual SoM)',
  async locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult> {
    const start = Date.now()
    try {
      // Pulls UIA elements from the shared cache (v2.0 Phase 3 polish).
      // First strategy to call pays the PowerShell round-trip; later
      // strategies on the same benchmark reuse the cached array — for
      // a 5-strategy bench run with 3 UIA-touching strategies the
      // saving is ~600-1800ms per benchmark.
      const enumStart = Date.now()
      const elements = await ctx.getUiaElements()
      const enumMs = Date.now() - enumStart
      if (elements.length === 0) {
        return {
          strategyId: 'uia-pick',
          predicted: null,
          confidence: null,
          source: 'none',
          msElapsed: Date.now() - start,
          trail: [ctx.target?.trail, `UIA returned 0 elements in ${enumMs}ms`]
            .filter(Boolean)
            .join('; '),
          error: 'no candidates'
        }
      }
      const shot = await ctx.getShot()
      const pick = await locateViaUiaPick({
        shot,
        description: ctx.benchmark.prompt,
        elements,
        signal
      })
      return {
        strategyId: 'uia-pick',
        predicted: pick.predicted,
        // The model's "I picked id N" doesn't expose a numeric
        // confidence, so we report null and let the report's pixel-
        // error + hit-rate columns carry the signal.
        confidence: null,
        // Distinct `uia-pick` source so the report can tell
        // matchUiaElement-only successes apart from "vision picked
        // from UIA candidates" successes — different cost/latency
        // profiles even though both yield UIA-precise coords.
        source: pick.predicted ? 'uia-pick' : 'none',
        msElapsed: Date.now() - start,
        trail: [ctx.target?.trail, `UIA enumerated ${elements.length} in ${enumMs}ms`, pick.trail]
          .filter(Boolean)
          .join('; '),
        error: pick.predicted ? null : pick.trail
      }
    } catch (err) {
      return {
        strategyId: 'uia-pick',
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
