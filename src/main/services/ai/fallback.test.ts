import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from '@shared/types'

/**
 * Provider auto-fallback decision tests.
 *
 * Two layers:
 *   1. `isRetryableProviderError` — pure classifier; no mocks.
 *   2. `pickFallbackProvider` — depends on key store / detect cache /
 *      config-resolved base URLs. Those modules pull SQLite + filesystem
 *      side effects on import, so we mock them at the module boundary.
 *
 * Mocks live at the TOP-LEVEL so vitest hoists them before any import
 * statement in this file or the SUT — `vi.mock()` inside a `describe()`
 * would not hoist and the SUT would resolve the real implementations.
 */
vi.mock('../storage/keys', () => ({
  hasApiKey: vi.fn(() => false),
  getApiKey: vi.fn(() => null)
}))
vi.mock('../storage/config', () => ({
  resolveBaseUrl: vi.fn(() => 'https://example.com'),
  getConfig: vi.fn(() => ({ providers: {} }))
}))
vi.mock('./detect', () => ({
  wasLocalProviderDetected: vi.fn(() => false),
  refreshLocalProviderDetection: vi.fn(async () => undefined),
  markLocalProviderReachable: vi.fn()
}))

import { isRetryableProviderError, pickFallbackProvider } from './fallback'
import { ProviderError } from './types'
import { hasApiKey } from '../storage/keys'
import { resolveBaseUrl } from '../storage/config'
import { wasLocalProviderDetected } from './detect'

const mockedHasApiKey = vi.mocked(hasApiKey)
const mockedResolveBaseUrl = vi.mocked(resolveBaseUrl)
const mockedWasLocalProviderDetected = vi.mocked(wasLocalProviderDetected)

describe('isRetryableProviderError', () => {
  it('returns true for 429 quota / rate-limit', () => {
    expect(isRetryableProviderError(new ProviderError('Too many requests', 429))).toBe(true)
  })

  it('returns true for 5xx upstream-server failures (502/503/504)', () => {
    expect(isRetryableProviderError(new ProviderError('Bad gateway', 502))).toBe(true)
    expect(isRetryableProviderError(new ProviderError('Service unavailable', 503))).toBe(true)
    expect(isRetryableProviderError(new ProviderError('Gateway timeout', 504))).toBe(true)
  })

  it('returns false for config errors a swap cannot fix (400/401/403/404)', () => {
    // Auth / forbidden / bad-model-id stay on the failing provider — swapping
    // providers would just relay the same misconfiguration.
    expect(isRetryableProviderError(new ProviderError('Bad request', 400))).toBe(false)
    expect(isRetryableProviderError(new ProviderError('Unauthorized', 401))).toBe(false)
    expect(isRetryableProviderError(new ProviderError('Forbidden', 403))).toBe(false)
    expect(isRetryableProviderError(new ProviderError('Not found', 404))).toBe(false)
  })

  it('returns false for user-initiated AbortError', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isRetryableProviderError(err)).toBe(false)
  })

  it('returns true for network-failure error messages from undici / node:net', () => {
    // The dispatcher hits these strings when fetch never reached the upstream
    // — a different provider on different infra might still answer.
    expect(isRetryableProviderError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableProviderError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true)
    expect(isRetryableProviderError(new Error('getaddrinfo ENOTFOUND api.openai.com'))).toBe(true)
    expect(isRetryableProviderError(new Error('Network request failed'))).toBe(true)
  })

  it('returns false for plain JS errors with no network hint', () => {
    expect(isRetryableProviderError(new Error('cannot read property foo of undefined'))).toBe(false)
    expect(isRetryableProviderError(new Error('schema validation failed'))).toBe(false)
  })

  it('returns false for non-Error values (strings, numbers, null)', () => {
    expect(isRetryableProviderError('whoops')).toBe(false)
    expect(isRetryableProviderError(42)).toBe(false)
    expect(isRetryableProviderError(null)).toBe(false)
    expect(isRetryableProviderError(undefined)).toBe(false)
  })
})

describe('pickFallbackProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default after reset: every paid provider is keyed, every local is
    // detected, every base URL resolves. Individual tests narrow this.
    mockedHasApiKey.mockReturnValue(true)
    mockedWasLocalProviderDetected.mockReturnValue(true)
    mockedResolveBaseUrl.mockReturnValue('https://example.com')
  })

  it('returns the next provider in FALLBACK_ORDER when nothing has been tried', () => {
    // OpenAI failed first → anthropic is the head of the order, so it wins
    // (it sits ahead of openai in FALLBACK_ORDER as the most-similar peer).
    expect(pickFallbackProvider('openai', new Set())).toBe('anthropic')
  })

  it('skips the failed provider', () => {
    // Anthropic failed → must not pick anthropic. Next in order is openai.
    expect(pickFallbackProvider('anthropic', new Set())).toBe('openai')
  })

  it('skips providers already in the tried set', () => {
    // openai already tried + just failed → must skip openai AND anthropic.
    // gemini is next eligible.
    const tried = new Set<ProviderId>(['anthropic'])
    expect(pickFallbackProvider('openai', tried)).toBe('gemini')
  })

  it('skips paid providers with no API key configured', () => {
    // Only Gemini is keyed → it should win even though anthropic / openai
    // are higher in the order.
    mockedHasApiKey.mockImplementation((id) => id === 'gemini')
    expect(pickFallbackProvider('openai', new Set())).toBe('gemini')
  })

  it('skips local providers that the boot probe did not detect', () => {
    // No paid keys at all. Without local detection, nothing's eligible.
    mockedHasApiKey.mockReturnValue(false)
    mockedWasLocalProviderDetected.mockReturnValue(false)
    expect(pickFallbackProvider('openai', new Set())).toBeNull()
  })

  it('picks a detected local provider when no paid providers are available', () => {
    mockedHasApiKey.mockReturnValue(false)
    // Only ollama detected → ollama is the answer.
    mockedWasLocalProviderDetected.mockImplementation((id) => id === 'ollama')
    expect(pickFallbackProvider('openai', new Set())).toBe('ollama')
  })

  it('skips providers without a resolvable base URL', () => {
    // gemini's URL is blank (user cleared it) — should skip past it even
    // though it's keyed and ranked above openrouter.
    mockedResolveBaseUrl.mockImplementation((id) => (id === 'gemini' ? '' : 'https://x'))
    // openai failed, anthropic is tried → next valid is gemini, but it's
    // skipped for the missing URL, so openrouter wins.
    const tried = new Set<ProviderId>(['anthropic'])
    expect(pickFallbackProvider('openai', tried)).toBe('openrouter')
  })

  it('returns null when everything in FALLBACK_ORDER is exhausted', () => {
    // No paid keys, no detected locals → nothing's eligible regardless of
    // which provider just failed.
    mockedHasApiKey.mockReturnValue(false)
    mockedWasLocalProviderDetected.mockReturnValue(false)
    expect(pickFallbackProvider('openai', new Set())).toBeNull()
  })

  it('returns null when the entire ordered list has already been tried', () => {
    const everyProvider = new Set<ProviderId>([
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
    ])
    expect(pickFallbackProvider('custom', everyProvider)).toBeNull()
  })
})
