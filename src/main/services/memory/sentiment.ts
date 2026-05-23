/**
 * Sentiment classifier for the v1.4.0 emotional-context subsystem.
 *
 * Reads the last N exchanges from a thread, calls a cheap fast model
 * with a tight structured prompt, parses the JSON output, returns a
 * { label, intensity, summary } triple the sentiment scheduler
 * persists. Skipped silently when no usable provider is reachable —
 * the rest of the app keeps working, just no `<sentiment>` block in
 * the system prompt.
 *
 * Cost shape: one invokeCompletion call per classification. Default
 * cadence is every 5 user-messages (configurable in the scheduler);
 * cheap models cost ~$0.0001 per call. Cache hits avoid duplicate
 * calls when the same thread is re-classified within 10 minutes.
 */
import { randomUUID } from 'node:crypto'
import { invokeCompletion } from '../ai'
import { hasApiKey } from '../storage/keys'
import { getConfig } from '../storage/config'
import { wasLocalProviderDetected } from '../ai/detect'
import { log } from '../logger'
import type { ChatTurn, ProviderId, SessionSentimentLabel } from '@shared/types'

/* ----------------------------- cheap models ----------------------------- */

/**
 * Cheapest reasonable model per provider for one-shot classification.
 * Picked for: fast response (<1s typical), low cost (<$0.001 per call),
 * good enough at structured JSON output.
 *
 * The user can override via `config.memory.sentimentModel`; this map is
 * just the auto-pick fallback when they leave it null.
 */
const CHEAP_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.1-8b-instant',
  deepseek: 'deepseek-chat',
  mistral: 'ministral-3b-latest',
  xai: 'grok-3-mini',
  openrouter: 'openai/gpt-4o-mini'
}

/**
 * Pick the provider + model the classifier will use. Returns null when
 * no provider is reachable — the sentiment subsystem then no-ops cleanly.
 *
 * Strategy:
 *   1. If user pinned a `sentimentModel` in Settings, honour it (using
 *      the active provider).
 *   2. Otherwise use the active provider with its cheap-tier model from
 *      CHEAP_MODELS, falling back to its defaultModel.
 *   3. Skip providers that need a key but don't have one + skip local
 *      providers that weren't detected at boot.
 */
export function pickSentimentProvider(): { provider: ProviderId; model: string } | null {
  const config = getConfig()
  const provider = config.activeProvider
  const isLocal = provider === 'ollama' || provider === 'lmstudio' || provider === 'llamacpp'
  if (isLocal && !wasLocalProviderDetected(provider)) return null
  if (!isLocal && !hasApiKey(provider)) return null

  const pinned = config.memory.sentimentModel?.trim()
  if (pinned) return { provider, model: pinned }

  const cheap = CHEAP_MODELS[provider]
  if (cheap) return { provider, model: cheap }

  // Fall back to the provider's stored model — better than nothing for
  // local + custom providers where we don't know the model catalogue.
  return { provider, model: config.providers[provider].model }
}

/* ----------------------------- prompt + parse --------------------------- */

const CLASSIFIER_SYSTEM_PROMPT = `You are a sentiment classifier reading recent assistant↔user exchanges.

Output JSON in this exact shape, nothing else (no markdown, no commentary):
{"sentiment": "<bucket>", "intensity": <1-5>, "summary": "<one short sentence about what the user is working on or feeling>"}

Buckets (pick exactly one):
- stressed   — user seems frustrated, blocked, worried, or under pressure
- productive — user is shipping, building, making clear progress
- stuck      — user can't get past a problem, repeated debugging, same error
- excited    — user has shipped something, hit a milestone, is energised
- neutral    — nothing emotionally salient stands out

Intensity 1-5: 1 = barely detectable, 3 = clear, 5 = the dominant signal.
Summary: max 80 chars, plain English, no quotes or formatting.

If the exchanges are too short or empty, output:
{"sentiment": "neutral", "intensity": 1, "summary": ""}`

interface ClassifierResult {
  sentiment: SessionSentimentLabel
  intensity: number
  summary: string
}

const VALID_LABELS: ReadonlySet<SessionSentimentLabel> = new Set([
  'stressed',
  'productive',
  'stuck',
  'excited',
  'neutral'
])

function parseClassifierOutput(raw: string): ClassifierResult | null {
  // Strip markdown fences if the model wrapped its JSON anyway (Gemini
  // does this maybe 5% of the time even when told not to).
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  let obj: unknown
  try {
    obj = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const sentiment = typeof o.sentiment === 'string' ? o.sentiment.toLowerCase() : ''
  if (!VALID_LABELS.has(sentiment as SessionSentimentLabel)) return null
  const intensity = Math.max(1, Math.min(5, Math.round(Number(o.intensity) || 0)))
  if (intensity < 1) return null
  const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, 200) : ''
  return {
    sentiment: sentiment as SessionSentimentLabel,
    intensity,
    summary
  }
}

/* ----------------------------- public entry ----------------------------- */

export interface ClassifyOptions {
  /**
   * Recent thread messages, oldest first. Caller decides how many — too
   * few = noisy classification, too many = wasted tokens. 6-10 user
   * messages of context is the sweet spot.
   */
  messages: ChatTurn[]
  /** Optional abort signal so a long-running classifier doesn't block
   *  app shutdown. */
  signal?: AbortSignal
}

/**
 * Classify the sentiment of a recent message window. Returns null when
 * (a) no provider is reachable, (b) the model output couldn't be parsed,
 * or (c) the request was aborted. All three are non-fatal — the caller
 * simply doesn't write a new row this round.
 */
export async function classifySentiment(
  opts: ClassifyOptions
): Promise<ClassifierResult | null> {
  const picked = pickSentimentProvider()
  if (!picked) {
    log('info', 'system', '[sentiment] no usable provider — skipping classification')
    return null
  }
  if (opts.messages.length === 0) return null

  // Trim messages to the last 12 turns and cap individual lengths so the
  // classifier prompt stays small. Sentiment doesn't need full context;
  // the gist is enough.
  const window = opts.messages
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content: (m.content ?? '').slice(0, 600)
    })) as ChatTurn[]

  const signal = opts.signal ?? new AbortController().signal
  try {
    const result = await invokeCompletion(
      {
        requestId: randomUUID(),
        provider: picked.provider,
        model: picked.model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: window
      },
      signal
    )
    if (result.error) {
      log(
        'warn',
        'system',
        `[sentiment] classifier call failed (${picked.provider}/${picked.model}): ${result.error}`
      )
      return null
    }
    const parsed = parseClassifierOutput(result.text)
    if (!parsed) {
      log(
        'warn',
        'system',
        `[sentiment] classifier returned unparseable output: ${result.text.slice(0, 200)}`
      )
      return null
    }
    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('warn', 'system', `[sentiment] classifier threw: ${msg}`)
    return null
  }
}

/* ----------------------------- 10-min cache ----------------------------- */

/**
 * Caches the last classification keyed on the timestamp of the most-
 * recent user message in the window. Re-classifying the same window
 * within the TTL just returns the cached result — no model call.
 */
const TTL_MS = 10 * 60 * 1000
interface CacheEntry {
  key: string
  result: ClassifierResult
  computedAt: number
}
let cache: CacheEntry | null = null

export async function classifySentimentCached(
  opts: ClassifyOptions
): Promise<ClassifierResult | null> {
  // Cache key = last message's content hash + role. Cheap, good enough
  // to detect "same thread state".
  const last = opts.messages[opts.messages.length - 1]
  const key = last ? `${last.role}::${(last.content ?? '').slice(0, 200)}` : 'empty'
  const now = Date.now()
  if (cache && cache.key === key && now - cache.computedAt < TTL_MS) {
    return cache.result
  }
  const fresh = await classifySentiment(opts)
  if (fresh) {
    cache = { key, result: fresh, computedAt: now }
  }
  return fresh
}

/** Drop the cache — used by tests and the "Forget recent" Settings flow. */
export function resetSentimentCache(): void {
  cache = null
}

/* ----------------------------- test exports ----------------------------- */
// Exposed for vitest — keeps the parser unit-testable without spinning
// up a model.
export const __test__ = { parseClassifierOutput }
