/**
 * Strategy: vision-only.
 *
 * Skips UIA entirely — pulls the lazy screenshot from the bench context
 * and runs the two-pass refinement contract. Useful as the column that
 * exposes how the vision pipeline degrades on Windows-app cases where
 * UIA would have rescued us.
 */
import { locateVisionRefined } from '../locate'
import type { BenchmarkContext, ClickStrategy, StrategyResult } from '../types'

export const visionOnlyStrategy: ClickStrategy = {
  id: 'vision-only',
  label: 'Vision only',
  async locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult> {
    const start = Date.now()
    try {
      const shot = await ctx.getShot()
      const vision = await locateVisionRefined({
        shot,
        description: ctx.benchmark.prompt,
        signal
      })
      return {
        strategyId: 'vision-only',
        predicted: vision.predicted,
        confidence: vision.confidence,
        source: vision.source,
        msElapsed: Date.now() - start,
        trail: [ctx.target?.trail, vision.trail].filter(Boolean).join('; '),
        error: null
      }
    } catch (err) {
      return {
        strategyId: 'vision-only',
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
