/**
 * Per-model capability hints. The router uses this to auto-select a
 * provider/model for a given task ("this prompt has an image attached
 * → prefer a vision-capable model"; "this is a long reasoning task →
 * prefer extended-thinking"; "user is near their monthly cap → prefer
 * cheap").
 *
 * Pattern-based rather than exhaustive. Model names within a family
 * usually share capabilities (every `gpt-4o-*` is vision-capable, every
 * `*-haiku-*` is fast/cheap), so a regex list catches new variants
 * without manual updates. Conservative defaults — when nothing matches,
 * we report the least-capable option so the worst case is a missing
 * indicator, not a silent "image was discarded by the provider".
 *
 * Adding a new model family: drop a regex into the relevant dimension
 * list. No registry to update, no central switch statement to extend.
 */

/**
 * Reasoning tier — informs whether to send a complex multi-step task
 * to this model. `extended` = explicit chain-of-thought models (o1, o3,
 * claude-*-thinking, deepseek-r1). `strong` = top-tier frontier models
 * that reason well without explicit thinking (opus, gpt-4o, gemini-pro).
 * `basic` = small/fast models suitable for routine completions.
 */
export type ReasoningTier = 'basic' | 'strong' | 'extended'

/**
 * Speed tier — approximate latency class. `fast` = under 1s typical
 * first-token (haiku, mini, flash, groq-anything). `balanced` = 1-3s
 * (sonnet, gpt-4o, gemini-pro). `slow` = 3s+ or sustained throughput
 * required (opus, o1, extended-thinking variants).
 */
export type SpeedTier = 'fast' | 'balanced' | 'slow'

/**
 * Cost tier — approximate per-million-token range. `free` = local. `cheap`
 * = under ~$1/M input. `standard` = ~$1-10/M. `premium` = $10+/M.
 * Used so a budget-near-cap router can fall back to cheaper providers
 * without consulting the exact pricing table for every routing decision.
 */
export type CostTier = 'free' | 'cheap' | 'standard' | 'premium'

export interface ModelCapabilities {
  /** Accepts image attachments in the message. */
  vision: boolean
  /** Supports function/tool-calling in the provider's structured format. */
  toolUse: boolean
  /** How strong this model is at multi-step reasoning. */
  reasoning: ReasoningTier
  /** Approximate context window in tokens. Conservative on unknown families. */
  contextWindow: number
  /** Latency tier. */
  speed: SpeedTier
  /** Cost tier. */
  cost: CostTier
}

/* ------------------------------- vision -------------------------------- */

const VISION_PATTERNS: RegExp[] = [
  // OpenAI multimodal family
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-4-vision/,
  /^gpt-4-turbo/,
  /^o1/,
  /^o3/,
  // Anthropic — every Claude 3+ family is vision-capable.
  /^claude-3/,
  /^claude-sonnet/,
  /^claude-opus/,
  /^claude-haiku-4/,
  // Google Gemini
  /^gemini-1\.5/,
  /^gemini-2/,
  /^gemini-exp/,
  // Local Ollama vision models
  /llava/,
  /^bakllava/,
  /^moondream/,
  /llama-?3\.2.*vision/,
  /minicpm-?v/,
  // xAI Grok vision variants
  /grok.*vision/,
  /grok-2/,
  // OpenRouter namespacing — `openai/gpt-4o`, `anthropic/claude-3.5-...`
  /\/gpt-4o/,
  /\/claude-3/,
  /\/gemini/,
  /\/llava/
]

/* ------------------------------ tool use ------------------------------- */

/**
 * Models known to handle the provider's structured tool-call format
 * reliably enough for agent loops. Conservative — listing only families
 * we've verified. Defaults to false for unknown models so the router
 * never sends tool definitions to a model that will ignore them.
 */
const TOOL_USE_PATTERNS: RegExp[] = [
  // Anthropic Claude 3+ all support tool use.
  /^claude-3/,
  /^claude-sonnet/,
  /^claude-opus/,
  /^claude-haiku-4/,
  // OpenAI GPT-4o family + function-calling era.
  /^gpt-4/,
  /^gpt-3\.5-turbo/,
  // Gemini 1.5+ supports function calling natively.
  /^gemini-1\.5/,
  /^gemini-2/,
  // Ollama / local models known to support tool calling.
  /^llama-?3\.[12]/,
  /^llama-?3\.3/,
  /^qwen2\.5/,
  /^mistral-large/,
  /^mistral-nemo/,
  /^command-r/,
  /^hermes-?3/,
  /^firefunction/,
  // xAI Grok 2+ supports tool calls.
  /grok-2/,
  /grok-3/,
  /grok-4/,
  // DeepSeek
  /^deepseek-(chat|v[23])/,
  // OpenRouter namespacing
  /\/(gpt-4|claude-3|gemini|llama-?3)/
]

/* ----------------------------- reasoning ------------------------------- */

/**
 * Explicit extended-thinking / chain-of-thought models. These are usually
 * slower and more expensive but solve harder problems. The router prefers
 * these when the task classifier flags "reasoning".
 */
const EXTENDED_REASONING_PATTERNS: RegExp[] = [
  /^o1/,
  /^o3/,
  /^o4/,
  /thinking/i,
  /^deepseek-r/,
  /^qwq/,
  /^claude-opus-4-7/, // Opus 4.7 ships as a thinking-by-default variant
  /\/(o1|o3|o4|deepseek-r)/
]

/**
 * Strong-but-not-extended frontier models. Solid for most reasoning work
 * without the latency/cost tax of an explicit thinking model.
 */
const STRONG_REASONING_PATTERNS: RegExp[] = [
  /^claude-opus/,
  /^claude-sonnet-4/,
  /^claude-sonnet-3\.5/,
  /^claude-3\.5-sonnet/,
  /^claude-3-opus/,
  /^gpt-4o(?!-mini)/, // exclude mini
  /^gpt-4\.1/,
  /^gpt-4-turbo/,
  /^gemini-1\.5-pro/,
  /^gemini-2\.0-pro/,
  /^gemini-2\.5-pro/,
  /^mistral-large/,
  /^qwen2\.5-72b/,
  /^llama-?3\.[13]-70b/,
  /grok-3/,
  /grok-4/,
  /\/(claude-opus|claude-3\.5-sonnet|gpt-4o|gemini-.*-pro)/
]

/* ---------------------------- context window --------------------------- */

/**
 * Per-family context window in tokens. Order matters — earliest match
 * wins, so list more specific patterns first.
 */
const CONTEXT_WINDOW: Array<{ pattern: RegExp; tokens: number }> = [
  // Anthropic 1M-context variants
  { pattern: /^claude-opus-4-7/, tokens: 200_000 },
  { pattern: /^claude-(sonnet|opus|haiku)-4/, tokens: 200_000 },
  { pattern: /^claude-3\.7/, tokens: 200_000 },
  { pattern: /^claude-3\.5/, tokens: 200_000 },
  { pattern: /^claude-3-opus/, tokens: 200_000 },
  { pattern: /^claude-3-haiku/, tokens: 200_000 },
  { pattern: /^claude-3/, tokens: 200_000 },
  // OpenAI
  { pattern: /^gpt-4\.1/, tokens: 1_000_000 },
  { pattern: /^gpt-4o-mini/, tokens: 128_000 },
  { pattern: /^gpt-4o/, tokens: 128_000 },
  { pattern: /^gpt-4-turbo/, tokens: 128_000 },
  { pattern: /^gpt-3\.5-turbo/, tokens: 16_000 },
  { pattern: /^o[134]/, tokens: 128_000 },
  // Gemini
  { pattern: /^gemini-1\.5-flash-8b/, tokens: 1_000_000 },
  { pattern: /^gemini-1\.5/, tokens: 1_000_000 },
  { pattern: /^gemini-2/, tokens: 1_000_000 },
  { pattern: /^gemini-exp/, tokens: 1_000_000 },
  // xAI Grok
  { pattern: /grok-4/, tokens: 256_000 },
  { pattern: /grok-3/, tokens: 131_000 },
  { pattern: /grok-2/, tokens: 131_000 },
  // DeepSeek
  { pattern: /^deepseek-v3/, tokens: 64_000 },
  { pattern: /^deepseek/, tokens: 64_000 },
  // Local Ollama / LM Studio — vary widely; conservative.
  { pattern: /^llama-?3\.[123]/, tokens: 128_000 },
  { pattern: /^qwen2\.5/, tokens: 32_000 },
  { pattern: /^mistral-large/, tokens: 128_000 },
  { pattern: /^mistral/, tokens: 32_000 },
  { pattern: /^command-r/, tokens: 128_000 },
  { pattern: /^phi-?3/, tokens: 128_000 },
  // OpenRouter
  { pattern: /\/claude-3/, tokens: 200_000 },
  { pattern: /\/gpt-4/, tokens: 128_000 },
  { pattern: /\/gemini/, tokens: 1_000_000 }
]

const DEFAULT_CONTEXT_WINDOW = 8_000

/* ------------------------------- speed --------------------------------- */

const FAST_PATTERNS: RegExp[] = [
  /haiku/i,
  /mini/i,
  /flash/i,
  /^gemini-1\.5-flash/,
  /^gemini-2.*flash/,
  /^groq\//, // OpenRouter Groq routes are fast
  /^llama-?3\.[12]-1b/,
  /^llama-?3\.[12]-3b/,
  /^qwen2\.5-(0\.5b|1\.5b|3b|7b)/,
  /^phi-?3/,
  /^gemma/,
  /\/(haiku|mini|flash)/
]

const SLOW_PATTERNS: RegExp[] = [
  /^o1/,
  /^o3/,
  /^o4/,
  /thinking/i,
  /^claude-opus-4-7/,
  /^claude-opus/,
  /^deepseek-r/,
  /^qwq/,
  /\/(o1|o3|opus)/
]

/* ------------------------------- cost ---------------------------------- */

const PREMIUM_PATTERNS: RegExp[] = [
  /^claude-opus/,
  /^o1(?!-mini)/,
  /^o3(?!-mini)/,
  /^gpt-4\.1/,
  /thinking/i,
  /\/(opus|o1|o3)/
]

const STANDARD_PATTERNS: RegExp[] = [
  /^claude-sonnet/,
  /^claude-3\.5/,
  /^claude-3\.7/,
  /^gpt-4o(?!-mini)/,
  /^gpt-4-turbo/,
  /^gemini-.*-pro/,
  /^mistral-large/,
  /grok-[234]/,
  /\/(sonnet|gpt-4o|gemini-.*-pro)/
]

const CHEAP_PATTERNS: RegExp[] = [
  /haiku/i,
  /mini/i,
  /flash/i,
  /^deepseek-chat/,
  /^mistral-small/,
  /^mistral-nemo/,
  /\/(haiku|mini|flash|deepseek-chat)/
]

/* ----------------------------- machinery ------------------------------- */

function matches(patterns: RegExp[], id: string): boolean {
  return patterns.some((rx) => rx.test(id))
}

function reasoningTier(id: string): ReasoningTier {
  if (matches(EXTENDED_REASONING_PATTERNS, id)) return 'extended'
  if (matches(STRONG_REASONING_PATTERNS, id)) return 'strong'
  return 'basic'
}

function speedTier(id: string): SpeedTier {
  if (matches(SLOW_PATTERNS, id)) return 'slow'
  if (matches(FAST_PATTERNS, id)) return 'fast'
  return 'balanced'
}

function costTier(id: string, isLocal: boolean): CostTier {
  if (isLocal) return 'free'
  if (matches(PREMIUM_PATTERNS, id)) return 'premium'
  if (matches(STANDARD_PATTERNS, id)) return 'standard'
  if (matches(CHEAP_PATTERNS, id)) return 'cheap'
  return 'standard' // unknown paid models default to standard, not premium
}

function contextWindowFor(id: string): number {
  for (const entry of CONTEXT_WINDOW) {
    if (entry.pattern.test(id)) return entry.tokens
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Memoize per id+isLocal — the picker calls capabilitiesOf() on every
 * popover render and the router calls it on every send(). 50+ regex
 * tests per call adds up; cache keyed on the inputs that change.
 */
const capsCache = new Map<string, ModelCapabilities>()

export function modelHasVision(modelId: string): boolean {
  return capabilitiesOf(modelId).vision
}

export function capabilitiesOf(modelId: string, isLocal = false): ModelCapabilities {
  if (!modelId) {
    return {
      vision: false,
      toolUse: false,
      reasoning: 'basic',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      speed: 'balanced',
      cost: isLocal ? 'free' : 'standard'
    }
  }
  const lower = modelId.toLowerCase()
  const cacheKey = `${lower}|${isLocal ? 'L' : 'R'}`
  const cached = capsCache.get(cacheKey)
  if (cached) return cached
  const caps: ModelCapabilities = {
    vision: matches(VISION_PATTERNS, lower),
    toolUse: matches(TOOL_USE_PATTERNS, lower),
    reasoning: reasoningTier(lower),
    contextWindow: contextWindowFor(lower),
    speed: speedTier(lower),
    cost: costTier(lower, isLocal)
  }
  capsCache.set(cacheKey, caps)
  return caps
}
