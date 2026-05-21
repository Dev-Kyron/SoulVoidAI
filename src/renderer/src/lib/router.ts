/**
 * Provider router — picks the best (provider, model) for a given task
 * from the providers the user has actually configured.
 *
 * Inputs:
 *   - the user's prompt + whether they attached images + whether agent
 *     mode is on  → classifies the task
 *   - the providers the user has access to (configured key + reachable)
 *     → narrows candidates
 *   - the per-model capability table from shared/modelCapabilities
 *     → scores candidates
 *   - optional budget state (near-cap → bias toward cheaper)
 *
 * Output:
 *   - the chosen { providerId, modelId, reason } — the reason is a
 *     short human-readable string surfaced in the chat as "via Sonnet
 *     4-5 — best for tool-heavy".
 *
 * Design rules:
 *   - HARD requirements (vision, tool-use) eliminate candidates rather
 *     than just penalising them. Sending an image to a text-only model
 *     silently drops information; sending tool calls to a model that
 *     can't structure them wastes a round-trip.
 *   - SOFT preferences are scored. The user's active provider gets a
 *     small tie-breaker boost so the router stays predictable —
 *     "anything reasonable" still routes to whatever the user already
 *     trusts.
 *   - Unknown providers / models default to the conservative tier
 *     rather than the optimistic one. Better a missed boost than a
 *     bad pick.
 */

import {
  capabilitiesOf,
  type ModelCapabilities,
  type ReasoningTier,
  type SpeedTier
} from '@shared/modelCapabilities'
import type { ProviderId, ProviderRuntime } from '@shared/types'

export type TaskKind =
  | 'vision' // image attached, must see it
  | 'reasoning' // multi-step thinking, math, analysis
  | 'tool-heavy' // agent loop expected to span many steps
  | 'coding' // generate / debug code
  | 'fast' // short, simple, latency matters more than quality
  | 'general' // ordinary chat — no strong signal

export interface TaskHint {
  kind: TaskKind
  /** Hard requirements that filter candidates out entirely. */
  requiresVision: boolean
  requiresToolUse: boolean
  /** Human-readable description, used in the routing-reason text. */
  label: string
}

export interface AvailableProvider {
  id: ProviderId
  model: string
  /** Provider is configured + reachable. Local: daemon running. Keyed: key stored. */
  usable: boolean
  /** Local provider (Ollama / LM Studio / llama.cpp / Custom). Drives cost tiering. */
  isLocal: boolean
}

export interface RouterInput {
  prompt: string
  hasImages: boolean
  agentMode: boolean
  available: AvailableProvider[]
  /** Provider currently picked in settings — used as a tie-breaker. */
  activeProviderId: ProviderId
  /**
   * Monthly budget state. Optional — if omitted, cost scoring is neutral.
   * `nearCap` means within 20% of the cap; the router will then bias
   * toward cheaper / local options.
   */
  budget?: { nearCap: boolean }
}

export interface RouterPick {
  providerId: ProviderId
  modelId: string
  /** Short caption like "Sonnet 4-5 — best for tool-heavy task". */
  reason: string
  /** Was this an explicit override of the user's active pick? */
  overrideOfActive: boolean
}

/* ------------------------- task classifier --------------------------- */

const REASONING_KEYWORDS = [
  'analyse', 'analyze', 'reason', 'reasoning', 'prove', 'derive',
  'step by step', 'step-by-step', 'think through', 'think step',
  'explain why', 'work out', 'solve', 'calculate', 'math', 'theorem'
]

const CODING_KEYWORDS = [
  'code', 'function', 'class', 'method', 'variable', 'compile',
  'debug', 'refactor', 'implement', 'unit test', 'typescript', 'python',
  'rust', 'java', 'electron', 'react', 'sql', 'regex', 'algorithm'
]

const FAST_KEYWORDS = [
  'quick', 'tldr', 'tl;dr', 'short answer', 'one-liner', 'in a sentence',
  'briefly', 'just tell me', 'yes or no'
]

function lowercased(s: string): string {
  return s.toLowerCase()
}

/**
 * Heuristic prompt-classifier. Fuzzy by design — better to abstain
 * (`general`) and let the user's active pick win than to wrongly route.
 */
export function classifyTask(input: { prompt: string; hasImages: boolean; agentMode: boolean }): TaskHint {
  const { prompt, hasImages, agentMode } = input
  const lower = lowercased(prompt)

  // Hard signals first — these never lie.
  if (hasImages) {
    return {
      kind: 'vision',
      requiresVision: true,
      requiresToolUse: agentMode,
      label: 'vision (image attached)'
    }
  }
  if (agentMode) {
    return {
      kind: 'tool-heavy',
      requiresVision: false,
      requiresToolUse: true,
      label: 'tool-heavy (agent mode)'
    }
  }

  // Soft keyword signals.
  const reasoningHits = REASONING_KEYWORDS.filter((k) => lower.includes(k)).length
  const codingHits = CODING_KEYWORDS.filter((k) => lower.includes(k)).length
  const fastHits = FAST_KEYWORDS.filter((k) => lower.includes(k)).length

  // Fast wins outright — user explicitly asked for short answer.
  if (fastHits >= 1 && prompt.length < 280) {
    return { kind: 'fast', requiresVision: false, requiresToolUse: false, label: 'fast (short answer)' }
  }
  if (reasoningHits >= 2 || (reasoningHits >= 1 && prompt.length > 400)) {
    return { kind: 'reasoning', requiresVision: false, requiresToolUse: false, label: 'reasoning' }
  }
  if (codingHits >= 1) {
    return { kind: 'coding', requiresVision: false, requiresToolUse: false, label: 'coding' }
  }

  return { kind: 'general', requiresVision: false, requiresToolUse: false, label: 'general' }
}

/* --------------------------- scoring --------------------------------- */

const REASONING_RANK: Record<ReasoningTier, number> = { basic: 0, strong: 2, extended: 3 }
const SPEED_RANK: Record<SpeedTier, number> = { slow: 0, balanced: 1, fast: 2 }

interface Candidate {
  providerId: ProviderId
  modelId: string
  caps: ModelCapabilities
  isLocal: boolean
  score: number
  reasonBits: string[]
}

function scoreCandidate(task: TaskHint, provider: AvailableProvider, activeId: ProviderId, budget?: { nearCap: boolean }): Candidate | null {
  const caps = capabilitiesOf(provider.model, provider.isLocal)

  // Hard requirements — eliminate if missing.
  if (task.requiresVision && !caps.vision) return null
  if (task.requiresToolUse && !caps.toolUse) return null

  let score = 0
  const reasonBits: string[] = []

  // Task-kind preferences.
  switch (task.kind) {
    case 'vision':
      // Already filtered to vision-capable; prefer fast vision models so
      // a vision check doesn't push the user onto an expensive premium.
      if (caps.speed === 'fast') {
        score += 4
        reasonBits.push('fast vision')
      } else if (caps.speed === 'balanced') {
        score += 2
      }
      break
    case 'reasoning':
      score += REASONING_RANK[caps.reasoning] * 4
      if (caps.reasoning === 'extended') reasonBits.push('extended thinking')
      else if (caps.reasoning === 'strong') reasonBits.push('strong reasoning')
      break
    case 'tool-heavy':
      // Agent loops want fast, tool-capable models. Speed dominates here —
      // a 30-step run on slow Opus burns minutes; same run on Sonnet/Haiku
      // finishes in seconds.
      score += SPEED_RANK[caps.speed] * 3
      if (caps.toolUse) {
        score += 5
        reasonBits.push('tool-use')
      }
      // Light bonus for strong reasoning — helps when individual tool
      // arguments need careful construction.
      if (caps.reasoning === 'strong') score += 2
      break
    case 'coding':
      // Coding benefits from strong reasoning + tool-use (running tests).
      score += REASONING_RANK[caps.reasoning] * 3
      if (caps.toolUse) score += 2
      if (caps.reasoning !== 'basic') reasonBits.push('coding-grade')
      break
    case 'fast':
      score += SPEED_RANK[caps.speed] * 5
      if (caps.speed === 'fast') reasonBits.push('fast')
      // Penalise premium models for fast tasks — wasteful.
      if (caps.cost === 'premium') score -= 4
      break
    case 'general':
      // Mild balanced bias — favour the middle tier.
      score += SPEED_RANK[caps.speed]
      score += REASONING_RANK[caps.reasoning]
      break
  }

  // Cost-aware bias. Budget-near-cap pushes the router toward free/cheap.
  if (budget?.nearCap) {
    if (caps.cost === 'free') {
      score += 4
      reasonBits.push('budget: local')
    } else if (caps.cost === 'cheap') {
      score += 2
      reasonBits.push('budget: cheap')
    } else if (caps.cost === 'premium') {
      score -= 6
    }
  }

  // Tie-breaker: prefer the user's active provider. Keeps routing
  // predictable — the assistant doesn't surprise-switch unless there's
  // a clear reason.
  if (provider.id === activeId) score += 1

  return { providerId: provider.id, modelId: provider.model, caps, isLocal: provider.isLocal, score, reasonBits }
}

/* ---------------------------- main entry ------------------------------ */

/**
 * Pick the best provider+model for the task, or fall back to the user's
 * active pick if no candidate scores better.
 *
 * Returns `null` ONLY when there are zero usable providers. In every
 * normal case it returns a pick — call sites can treat null as
 * "configuration is broken, show the first-run banner."
 */
export function pickProvider(input: RouterInput): RouterPick | null {
  const task = classifyTask({
    prompt: input.prompt,
    hasImages: input.hasImages,
    agentMode: input.agentMode
  })

  const usable = input.available.filter((p) => p.usable && p.model)
  if (usable.length === 0) return null

  const candidates = usable
    .map((p) => scoreCandidate(task, p, input.activeProviderId, input.budget))
    .filter((c): c is Candidate => c !== null)

  // No candidate passed the hard filter (e.g. vision required but no
  // vision-capable provider configured). Fall back to active so the user
  // at least gets a graceful response with the existing image-discard
  // warning rather than a hard "no provider" wall.
  if (candidates.length === 0) {
    const active = usable.find((p) => p.id === input.activeProviderId) ?? usable[0]
    return {
      providerId: active.id,
      modelId: active.model,
      reason: `${active.model} — no ${task.kind}-capable provider configured`,
      overrideOfActive: false
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const winner = candidates[0]
  const overrideOfActive = winner.providerId !== input.activeProviderId

  const reasonSuffix = winner.reasonBits.length > 0 ? ` — ${winner.reasonBits.join(', ')}` : ''
  return {
    providerId: winner.providerId,
    modelId: winner.modelId,
    reason: `${winner.modelId} (${task.label})${reasonSuffix}`,
    overrideOfActive
  }
}

/**
 * Helper for the renderer to build the AvailableProvider[] list from
 * the ClientConfig. Keeps the routing layer ignorant of the config
 * shape — call sites map their config into AvailableProvider[].
 */
export function toAvailable(runtime: Record<ProviderId, ProviderRuntime>, providerIds: ProviderId[], detected: Set<ProviderId>): AvailableProvider[] {
  return providerIds.map((id) => {
    const r = runtime[id]
    if (!r) {
      return { id, model: '', usable: false, isLocal: false }
    }
    const isLocal = !r.needsKey
    const usable = isLocal ? detected.has(id) : Boolean(r.hasKey)
    return { id, model: r.model, usable, isLocal }
  })
}

/**
 * Budget signal computation — `nearCap` fires when the user has a
 * monthly cap set AND has spent >= 80% of it. Below that threshold
 * the router stays cost-neutral; above it, cheap/local providers
 * get a scoring boost so a runaway agent loop doesn't blow the cap.
 *
 * Pure function for testability — the caller fetches the numbers
 * via the usage IPC and hands them in.
 */
export function deriveBudgetState(totalSpentUsd: number, monthlyCapUsd: number | null): { nearCap: boolean } | undefined {
  if (monthlyCapUsd === null || monthlyCapUsd <= 0) return undefined
  return { nearCap: totalSpentUsd / monthlyCapUsd >= 0.8 }
}
