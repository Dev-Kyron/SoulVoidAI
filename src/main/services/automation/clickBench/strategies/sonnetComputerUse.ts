/**
 * Strategy: Sonnet computer-use — direct Anthropic API call with the
 * native `computer_20250124` tool.
 *
 * Why it matters: Sonnet 3.7+ and 4.x were post-trained on grounded UI
 * clicks. Where vision-only locate gives us a generic "find the thing
 * in this image" model, computer-use gives us a model whose objective
 * during training included "given the user wants X, where does the
 * cursor go". Beta on the bench harness consistently shows lower pixel
 * error and higher hit-bbox rate on the failure cases that hurt v1.x
 * most (browser web content, icon-only buttons, busy chat UIs).
 *
 * The actual API call lives in `automation/computerUseLocate.ts` so the
 * production click pipeline and this bench strategy exercise the same
 * code path — bench numbers reflect production reality.
 *
 * Bench-specific choices:
 *   - Model id is hardcoded to the latest Sonnet rather than reading
 *     the user's pinned model. The bench measures the STRATEGY, not
 *     "what does the user's pinned model do". Pinning a smaller model
 *     would artificially tank the column.
 *   - Confidence is unavailable from the API; we report `null` so the
 *     report formats the column without a fake number.
 */
import { locateViaComputerUse } from '../../computerUseLocate'
import type { BenchmarkContext, ClickStrategy, StrategyResult } from '../types'

/** Latest Sonnet generation with computer-use — see capability check
 *  in `computerUseLocate.ts` for the full supported list. */
const BENCH_MODEL = 'claude-sonnet-4-5'

export const sonnetComputerUseStrategy: ClickStrategy = {
  id: 'sonnet-computer-use',
  label: 'Sonnet computer-use',
  async locate(ctx: BenchmarkContext, signal: AbortSignal): Promise<StrategyResult> {
    const start = Date.now()
    try {
      const shot = await ctx.getShot()
      const result = await locateViaComputerUse({
        shot,
        description: ctx.benchmark.prompt,
        modelId: BENCH_MODEL,
        signal
      })
      return {
        strategyId: 'sonnet-computer-use',
        predicted: result.predicted,
        confidence: null,
        // Distinct from `vision-refined` so the bench report's source
        // column can show "Sonnet vs first/refined vision" at a glance.
        source: result.predicted ? 'computer-use' : 'none',
        msElapsed: Date.now() - start,
        trail: [ctx.target?.trail, result.trail].filter(Boolean).join('; '),
        error: result.predicted ? null : result.trail
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return failed(start, 'aborted', 'aborted by signal')
      }
      return failed(start, 'threw', err instanceof Error ? err.message : String(err))
    }
  }
}

function failed(start: number, trail: string, error: string): StrategyResult {
  return {
    strategyId: 'sonnet-computer-use',
    predicted: null,
    confidence: null,
    source: 'none',
    msElapsed: Date.now() - start,
    trail,
    error
  }
}

// Re-exported here for the registry barrel — kept centralised in
// computerUseLocate.ts so visualClick.ts and the bench share one source
// of truth on which models are capable.
export { isSonnetComputerUseCapable, modelSupportsComputerUse } from '../../computerUseLocate'
