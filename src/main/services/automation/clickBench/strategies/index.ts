/**
 * Strategy registry.
 *
 * Phase 1 shipped uia-only, vision-only, uia-then-vision (current
 * production). Phase 2 adds sonnet-computer-use — direct Anthropic API
 * with the native `computer_20250124` tool. Phase 3's Set-of-Marks
 * fallback will likely modify uia-then-vision's vision sub-step rather
 * than appear as a separate strategy (it's a fallback within vision,
 * not a peer of UIA).
 *
 * Column order in the report follows the array order below, so we put
 * the baseline first (everything else compares to it) and group by
 * "kind" so visual scanning the report is easier.
 */
import type { ClickStrategy } from '../types'
import { uiaOnlyStrategy } from './uiaOnly'
import { visionOnlyStrategy } from './visionOnly'
import { uiaThenVisionStrategy } from './uiaThenVision'
import { sonnetComputerUseStrategy } from './sonnetComputerUse'
import { uiaPickStrategy } from './uiaPick'

export const ALL_STRATEGIES: readonly ClickStrategy[] = Object.freeze([
  uiaThenVisionStrategy, // baseline first so the report column order matches
  uiaOnlyStrategy,
  visionOnlyStrategy,
  uiaPickStrategy, // v2.0 Phase 3 — textual Set-of-Marks
  sonnetComputerUseStrategy
])

export function strategyById(id: string): ClickStrategy | null {
  return ALL_STRATEGIES.find((s) => s.id === id) ?? null
}

export { isSonnetComputerUseCapable, modelSupportsComputerUse } from '../../computerUseLocate'
