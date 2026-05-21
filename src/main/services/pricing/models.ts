/**
 * Model pricing table — used by the usage tracker to convert tokens into
 * dollars. All values are USD per **1 million** tokens for input/output;
 * `image` is a flat USD per call (DALL·E 3 etc.).
 *
 * Pricing changes — keep this table current, or override per model from the
 * Settings UI (future). When a model isn't listed, cost is reported as null
 * rather than estimated, so users aren't misled.
 *
 * Last refreshed: late 2025 published rates.
 */
import { isLocalProvider } from '../ai/types'
import type { ProviderId } from '@shared/types'

export interface ModelPricing {
  input: number
  output: number
  image?: number
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o3-mini': { input: 1.1, output: 4.4 },

  // Anthropic
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-7-1m': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4 },

  // Gemini
  'gemini-2.0-pro-exp': { input: 1.25, output: 5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },

  // Image gen — billed per call, no token component
  'dall-e-3-1024': { input: 0, output: 0, image: 0.04 },
  'dall-e-3-1792': { input: 0, output: 0, image: 0.08 }
}

/**
 * Look up pricing for a model. Returns null when we have no published
 * pricing for the model — the caller should report cost as unknown rather
 * than guess.
 */
export function pricingFor(provider: ProviderId, model: string): ModelPricing | null {
  // Local providers (Ollama, LM Studio, llama.cpp) and (often) Custom
  // endpoints are free / self-hosted — never bill them, even if the model id
  // collides with a remote-priced one in DEFAULT_PRICING.
  if (isLocalProvider(provider) || provider === 'custom') {
    return { input: 0, output: 0 }
  }
  return DEFAULT_PRICING[model] ?? null
}

/** Estimate tokens for a string — chars/3.5 is the same heuristic used elsewhere. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** Per-image token surcharge (rough — vision tokens per 1024px input). */
export const TOKENS_PER_IMAGE = 1500
