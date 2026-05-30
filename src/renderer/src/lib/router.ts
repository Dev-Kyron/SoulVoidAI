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
  /**
   * v1.13.5 — set when the prompt contains an absolute or clearly-rooted
   * file path (e.g. `C:\Users\foo\bar.ts`, `/home/me/proj`, `~/Downloads`).
   * Filepath prompts route the agent into tool calls, and weaker models
   * (notably gpt-4o-mini) refuse those calls. Lifting strong-reasoning
   * models on filepath prompts swings the tie-breaker back toward Claude /
   * GPT-4o / Gemini Pro so the tools actually get called.
   */
  hasFilepath: boolean
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
  'analyse',
  'analyze',
  'reason',
  'reasoning',
  'prove',
  'derive',
  'step by step',
  'step-by-step',
  'think through',
  'think step',
  'explain why',
  'work out',
  'solve',
  'calculate',
  'math',
  'theorem'
]

const CODING_KEYWORDS = [
  'code',
  'function',
  'class',
  'method',
  'variable',
  'compile',
  'debug',
  'refactor',
  'implement',
  'unit test',
  'typescript',
  'python',
  'rust',
  'java',
  'electron',
  'react',
  'sql',
  'regex',
  'algorithm'
]

const FAST_KEYWORDS = [
  'quick',
  'tldr',
  'tl;dr',
  'short answer',
  'one-liner',
  'in a sentence',
  'briefly',
  'just tell me',
  'yes or no'
]

function lowercased(s: string): string {
  return s.toLowerCase()
}

/**
 * Pattern: fenced code block in the prompt. The user pasted code (asking
 * to debug / refactor / review) or attached a snippet — flips us toward
 * a coding-grade model even when the prose itself has no keyword hits.
 */
const FENCED_CODE_REGEX = /```[\s\S]+```|^ {4}\S/m

/**
 * Pattern: short conversational openers ("hey", "thanks", "what's up").
 * Cheap fast model is plenty — don't burn premium tokens on small talk.
 */
const CONVERSATIONAL_REGEX =
  /^(hi|hey|hello|hiya|yo|sup|thanks|thank you|ty|cheers|nice|cool|ok|okay|got it|sweet|awesome|nvm|never mind|np|no problem)\b/i

/** Long-prompt threshold — above this we suspect dense context / reasoning. */
const LONG_PROMPT_CHARS = 2000

/**
 * Patterns for absolute / clearly-rooted file paths. The presence of any
 * one of these strongly implies a filesystem tool call will follow, so we
 * bias toward strong-reasoning models that actually pick the right tool
 * instead of refusing.
 *
 *   - Windows drive paths: `C:\Users\…`, `D:/path/to/file.ts`
 *   - POSIX absolute paths: `/home/me`, `/Users/foo/bar`
 *   - Home-token paths: `~/Downloads`, `~\Documents`
 *   - UNC paths: `\\server\share\file`
 *
 * Each pattern is anchored on a word boundary to avoid false positives
 * in URLs (`http://example.com/foo`) or fenced code blocks containing
 * unrelated slashes.
 */
const FILEPATH_PATTERNS: RegExp[] = [
  /\b[a-zA-Z]:[\\/][^\s'"`<>|*?]+/, // Windows drive
  /(^|\s)\/(?:home|Users|var|etc|opt|tmp|root|usr|mnt|srv)\/[^\s'"`<>|*?]+/, // POSIX root
  /(^|\s)~[\\/][^\s'"`<>|*?]+/, // home shorthand
  /\\\\[^\s\\]+\\[^\s'"`<>|*?]+/ // UNC
]

/**
 * True when the prompt mentions an absolute / clearly-rooted filesystem
 * path. Exported so the chat store can reuse the same signal for its
 * tool-less refusal-retry heuristic (we only retry filepath prompts —
 * refusals on prompts with no path are usually genuine policy limits,
 * not the gpt-4o-mini "I can't reach that folder" pattern).
 */
export function looksLikeFilepath(prompt: string): boolean {
  return FILEPATH_PATTERNS.some((re) => re.test(prompt))
}

/** Short-prompt threshold — below this conversational openers count strongly. */
const SHORT_PROMPT_CHARS = 80

/**
 * Heuristic prompt-classifier. Fuzzy by design — better to abstain
 * (`general`) and let the user's active pick win than to wrongly route.
 *
 * Signal ladder (most decisive first):
 *  1. Hard signals: vision attachment, agent mode.
 *  2. Format signals: fenced code block (→ coding), very long prompt (→
 *     reasoning).
 *  3. Keyword density: reasoning / coding / fast keyword hits.
 *  4. Conversational opener on a short prompt (→ fast/cheap).
 *  5. Default: general.
 */
export function classifyTask(input: {
  prompt: string
  hasImages: boolean
  agentMode: boolean
}): TaskHint {
  const { prompt, hasImages, agentMode } = input
  const lower = lowercased(prompt)
  const hasFilepath = looksLikeFilepath(prompt)

  // Shared defaults so each return path describes only the dimensions it
  // actually changes. Per-branch overrides spread on top — keeps the
  // intent of each classification readable and dodges the bug class where
  // a newly-added TaskHint field gets forgotten on one of the (otherwise
  // many) return statements.
  const base = {
    requiresVision: false,
    requiresToolUse: false,
    hasFilepath
  } as const

  // Hard signals first — these never lie.
  if (hasImages) {
    return {
      ...base,
      kind: 'vision',
      requiresVision: true,
      requiresToolUse: agentMode,
      label: 'vision (image attached)'
    }
  }
  if (agentMode) {
    return {
      ...base,
      kind: 'tool-heavy',
      requiresToolUse: true,
      // Filepath surfacing in the label makes the routing-reason caption
      // ("via Sonnet 4 — tool-heavy + filepath") read obvious in chat.
      label: hasFilepath ? 'tool-heavy (agent + filepath)' : 'tool-heavy (agent mode)'
    }
  }

  // Format signal: fenced code block. Pasted code is a strong coding tell
  // even when the surrounding prose has no keyword hits ("fix this" + 50
  // lines of TypeScript).
  if (FENCED_CODE_REGEX.test(prompt)) {
    return { ...base, kind: 'coding', label: 'coding (code block detected)' }
  }

  // Soft keyword signals.
  const reasoningHits = REASONING_KEYWORDS.filter((k) => lower.includes(k)).length
  const codingHits = CODING_KEYWORDS.filter((k) => lower.includes(k)).length
  const fastHits = FAST_KEYWORDS.filter((k) => lower.includes(k)).length

  // Conversational opener on a short prompt — cheap fast model. Checked
  // before the explicit "fast keyword" path because greetings like "hey,
  // brief me on X" can still benefit from a fast cheap model even though
  // the user didn't write "TLDR".
  if (prompt.length < SHORT_PROMPT_CHARS && CONVERSATIONAL_REGEX.test(prompt.trim())) {
    return { ...base, kind: 'fast', label: 'fast (short greeting)' }
  }

  // Fast wins outright — user explicitly asked for short answer.
  if (fastHits >= 1 && prompt.length < 280) {
    return { ...base, kind: 'fast', label: 'fast (short answer)' }
  }

  // Very long prompt → assume dense context / multi-part question →
  // reasoning model. Threshold deliberately high (~500 words) so a long
  // narrative description doesn't trip into the slow tier needlessly.
  if (prompt.length > LONG_PROMPT_CHARS) {
    return { ...base, kind: 'reasoning', label: 'reasoning (long prompt)' }
  }

  if (reasoningHits >= 2 || (reasoningHits >= 1 && prompt.length > 400)) {
    return { ...base, kind: 'reasoning', label: 'reasoning' }
  }
  if (codingHits >= 1) {
    return { ...base, kind: 'coding', label: 'coding' }
  }

  // No keyword hits but the prompt names a filesystem path → still a
  // coding-shaped task. Without this, "open D:\Project\src\foo.ts" would
  // fall through to 'general' and the speed bias would happily route to
  // gpt-4o-mini, which then refuses the resulting tool call.
  if (hasFilepath) {
    return { ...base, kind: 'coding', label: 'coding (filepath)' }
  }

  return { ...base, kind: 'general', label: 'general' }
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

function scoreCandidate(
  task: TaskHint,
  provider: AvailableProvider,
  activeId: ProviderId,
  budget?: { nearCap: boolean }
): Candidate | null {
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
      // v1.13.5 — filepath bias. When the prompt names a real path the
      // agent will almost certainly need to call a file tool. Weaker
      // models (gpt-4o-mini in particular) refuse those calls with "I
      // can't access that folder", wasting the round-trip. Pile a heavy
      // reasoning bonus on top so the tie-breaker swings back to
      // Sonnet/Opus/GPT-4o, which actually pick up the tool.
      if (task.hasFilepath) {
        if (caps.reasoning === 'extended') {
          score += 8
          reasonBits.push('filepath → extended reasoning')
        } else if (caps.reasoning === 'strong') {
          score += 6
          reasonBits.push('filepath → strong reasoning')
        } else {
          // Penalty mirrors the bonus so the tier gap is visible to the
          // ranker — a fast cheap model with basic reasoning loses ground
          // to a balanced model with strong reasoning on filepath prompts.
          score -= 4
        }
      }
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

  return {
    providerId: provider.id,
    modelId: provider.model,
    caps,
    isLocal: provider.isLocal,
    score,
    reasonBits
  }
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
    // Use a human-readable phrase per task kind rather than just the
    // raw enum value ("vision" reads fine; "tool-heavy" reads as jargon).
    const fallbackPhrase =
      task.kind === 'vision'
        ? 'no vision-capable provider configured'
        : task.kind === 'tool-heavy'
          ? 'no tool-use-capable provider configured (agent mode may misbehave)'
          : `no ${task.kind}-capable provider configured`
    return {
      providerId: active.id,
      modelId: active.model,
      reason: `${active.model} — ${fallbackPhrase}`,
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
export function toAvailable(
  runtime: Record<ProviderId, ProviderRuntime>,
  providerIds: ProviderId[],
  detected: Set<ProviderId>
): AvailableProvider[] {
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
 * Threshold at which the budget signal flips to `nearCap`. 0.8 = within
 * 20% of the monthly cap (or over it). Exported so the unit test and
 * any future UI ("budget bias active") read from the same source.
 */
export const BUDGET_THRESHOLD = 0.8

/**
 * Budget signal computation — `nearCap` fires when the user has a
 * monthly cap set AND has spent >= BUDGET_THRESHOLD of it. Below the
 * threshold the router stays cost-neutral; above it, cheap/local
 * providers get a scoring boost so a runaway agent loop doesn't blow
 * past the cap.
 *
 * Pure function for testability — the caller fetches the numbers via
 * the usage IPC and hands them in.
 */
export function deriveBudgetState(
  totalSpentUsd: number,
  monthlyCapUsd: number | null
): { nearCap: boolean } | undefined {
  if (monthlyCapUsd === null || monthlyCapUsd <= 0) return undefined
  return { nearCap: totalSpentUsd / monthlyCapUsd >= BUDGET_THRESHOLD }
}
