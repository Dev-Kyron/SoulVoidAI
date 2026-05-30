/**
 * Strategy: UIA-only.
 *
 * Calls UIA + matchUiaElement and stops. No vision fallback. Surfaces
 * the failure mode that v1.9.0 fixed (vision-only) — useful as the
 * pure-baseline column in the report so we can see how often UIA on its
 * own is enough.
 *
 * Honours the abort signal between the (cheap) target lookup and the
 * (potentially-slow) UIA enumeration — the harness's per-cell timeout
 * + the user's Cancel both arrive as signal trips, so we surface them
 * as a structured StrategyResult instead of throwing.
 */
import { locateUia } from '../locate'
import type { BenchmarkContext, ClickStrategy, StrategyResult } from '../types'

export const uiaOnlyStrategy: ClickStrategy = {
  id: 'uia-only',
  label: 'UIA only',
  async locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult> {
    const start = Date.now()
    try {
      if (signal.aborted) {
        return abortedResult(start)
      }
      // Pulls UIA elements from the shared cache (v2.0 Phase 3 polish).
      // First strategy to call pays for the PowerShell round-trip;
      // subsequent strategies on the same benchmark get them free.
      const elements = await ctx.getUiaElements()
      const uia = await locateUia({
        description: ctx.benchmark.prompt,
        targetWindowHwnd: ctx.target?.hwnd ?? null,
        elements
      })
      return {
        strategyId: 'uia-only',
        predicted: uia.predicted,
        confidence: uia.confidence,
        source: uia.predicted ? 'uia' : 'none',
        msElapsed: Date.now() - start,
        trail: [ctx.target?.trail, uia.trail].filter(Boolean).join('; '),
        error: null
      }
    } catch (err) {
      return {
        strategyId: 'uia-only',
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

function abortedResult(start: number): StrategyResult {
  return {
    strategyId: 'uia-only',
    predicted: null,
    confidence: null,
    source: 'none',
    msElapsed: Date.now() - start,
    trail: 'aborted before UIA enumeration',
    error: 'aborted'
  }
}
