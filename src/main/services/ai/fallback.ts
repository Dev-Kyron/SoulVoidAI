/**
 * Provider auto-fallback — when the active provider returns a retryable
 * error (quota exceeded, server overloaded, transient network glitch), the
 * dispatcher silently retries with the next best configured provider so the
 * user gets a reply instead of a red toast.
 *
 * Trigger conditions (HTTP status or error pattern):
 *   · 429 — rate limit / quota exceeded (the most common case)
 *   · 502/503/504 — upstream server problems
 *   · fetch failed / ECONNREFUSED / ENOTFOUND — network was unreachable
 *
 * Explicitly NOT retried: 4xx other than 429 (config errors — auth, bad
 * model name, malformed request all need user action), aborts (user-
 * initiated), and any error after `onDelta` has fired (would garble the
 * partially-rendered reply).
 *
 * Fallback priority: paid providers the user has keyed first, then local
 * daemons. The order within each tier is a curated "most-similar-to-the-
 * failed-one" approximation — anthropic and openai are interchangeable for
 * most tasks, gemini sits between them on capability, and the local tier
 * is a quality drop most users only want as a last resort.
 *
 * Chains as long as every retry is also retryable AND there's still an
 * untried fallback left. The `tried` set the dispatcher threads forward
 * prevents re-picking a provider we already failed against, and
 * FALLBACK_ORDER is small enough that the worst case is a few hundred
 * milliseconds of extra latency before we surface "everything's down."
 */
import { PROVIDER_META, ProviderError, isLocalProvider } from './types'
import { hasApiKey } from '../storage/keys'
import { resolveBaseUrl } from '../storage/config'
import { wasLocalProviderDetected } from './detect'
import type { ProviderId } from '@shared/types'

/**
 * Returns true when the error is the kind a different provider might be
 * able to recover from. Aborts and config errors return false because
 * neither retrying nor swapping providers would help.
 */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    // Quota / rate limit / upstream-server problems are exactly the cases
    // a different provider can answer. Auth (401), forbidden (403), and
    // bad-request (400) errors mean the request shape or credentials are
    // wrong — swapping providers won't help.
    if (err.status === 429) return true
    if (err.status === 502 || err.status === 503 || err.status === 504) return true
    return false
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false
    // The same network-error pattern the humanError() helper recognises.
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(err.message)) return true
  }
  return false
}

/**
 * Priority order for picking a fallback. Paid frontier models first (most
 * comparable to whatever failed), then the OpenAI-compatible aggregators
 * that tend to have spare capacity when the big three hit limits, then
 * local daemons as a quality-floor backstop. The failed provider plus
 * anything already tried in this request is filtered out before the
 * order is applied.
 */
const FALLBACK_ORDER: ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'groq',
  'deepseek',
  'mistral',
  'xai',
  'ollama',
  'lmstudio',
  'llamacpp'
]

/**
 * Pick the next provider to try after `failed`, skipping anything already
 * attempted this request. Returns null when nothing usable remains.
 *
 * "Usable" = the provider has a key (paid) or was detected at boot
 * (local). We don't probe live — if the local daemon went offline between
 * boot and now, we'll just hit a network error on the fallback call and
 * surface it. Probing here would add 50-100ms of latency to the recovery
 * path for the rare case it'd actually help.
 */
export function pickFallbackProvider(
  failed: ProviderId,
  tried: ReadonlySet<ProviderId>
): ProviderId | null {
  for (const candidate of FALLBACK_ORDER) {
    if (candidate === failed) continue
    if (tried.has(candidate)) continue
    const meta = PROVIDER_META[candidate]
    if (!meta) continue
    if (meta.needsKey && !hasApiKey(candidate)) continue
    if (isLocalProvider(candidate) && !wasLocalProviderDetected(candidate)) continue
    if (!resolveBaseUrl(candidate)) continue
    return candidate
  }
  return null
}
