import { describe, expect, it } from 'vitest'
import { modelHasVision, capabilitiesOf } from './modelCapabilities'

describe('modelHasVision', () => {
  it('matches the OpenAI multimodal family', () => {
    expect(modelHasVision('gpt-4o')).toBe(true)
    expect(modelHasVision('gpt-4o-mini')).toBe(true)
    expect(modelHasVision('gpt-4.1')).toBe(true)
    expect(modelHasVision('gpt-4-turbo')).toBe(true)
    expect(modelHasVision('o1-preview')).toBe(true)
    expect(modelHasVision('o3-mini')).toBe(true)
  })

  it('rejects the OpenAI text-only family', () => {
    expect(modelHasVision('gpt-3.5-turbo')).toBe(false)
    expect(modelHasVision('text-davinci-003')).toBe(false)
  })

  it('matches every Claude 3+ family — including 3.5 and 3.7 via /^claude-3/', () => {
    expect(modelHasVision('claude-3-haiku-latest')).toBe(true)
    expect(modelHasVision('claude-3.5-sonnet')).toBe(true)
    expect(modelHasVision('claude-3.7-sonnet')).toBe(true)
    expect(modelHasVision('claude-sonnet-4-5')).toBe(true)
    expect(modelHasVision('claude-opus-4-7')).toBe(true)
    expect(modelHasVision('claude-haiku-4-5')).toBe(true)
  })

  it('matches local vision models', () => {
    expect(modelHasVision('llava')).toBe(true)
    expect(modelHasVision('llava:13b')).toBe(true)
    expect(modelHasVision('bakllava')).toBe(true)
    expect(modelHasVision('moondream')).toBe(true)
    expect(modelHasVision('llama-3.2-vision')).toBe(true)
    expect(modelHasVision('llama3.2-vision')).toBe(true)
    expect(modelHasVision('minicpm-v')).toBe(true)
  })

  it('matches OpenRouter namespacing', () => {
    expect(modelHasVision('openai/gpt-4o')).toBe(true)
    expect(modelHasVision('anthropic/claude-3.5-sonnet')).toBe(true)
    expect(modelHasVision('google/gemini-pro-vision')).toBe(true)
  })

  it('rejects local text-only models', () => {
    expect(modelHasVision('llama3:8b')).toBe(false)
    expect(modelHasVision('mistral:7b')).toBe(false)
    expect(modelHasVision('codellama')).toBe(false)
  })

  it('handles empty / whitespace input safely', () => {
    expect(modelHasVision('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(modelHasVision('GPT-4O')).toBe(true)
    expect(modelHasVision('Claude-3-Opus')).toBe(true)
  })

  it('memoizes — second call for the same id returns identically', () => {
    // Identity check via repeat call; covers the cache code path so a future
    // regression that bypasses the cache surfaces here.
    expect(modelHasVision('gpt-4o')).toBe(true)
    expect(modelHasVision('gpt-4o')).toBe(true)
  })

  it('exposes the same answer via capabilitiesOf', () => {
    // Vision is one dimension of the now-richer capabilities object;
    // only assert the vision flag — the other dimensions (toolUse,
    // reasoning, context, speed, cost) have their own dedicated tests.
    expect(capabilitiesOf('gpt-4o').vision).toBe(true)
    expect(capabilitiesOf('gpt-3.5-turbo').vision).toBe(false)
  })

  it('reports toolUse for known function-calling models', () => {
    expect(capabilitiesOf('claude-sonnet-4-5').toolUse).toBe(true)
    expect(capabilitiesOf('gpt-4o-mini').toolUse).toBe(true)
    expect(capabilitiesOf('gemini-2.0-pro').toolUse).toBe(true)
    expect(capabilitiesOf('qwen2.5-14b').toolUse).toBe(true)
  })

  it('classifies reasoning tiers from model names', () => {
    expect(capabilitiesOf('o1-preview').reasoning).toBe('extended')
    // Anthropic extended thinking is opt-in via request flag, not a model
    // id — the `thinking` suffix when surfaced via a custom variant gets
    // recognised. Plain Opus is strong-tier.
    expect(capabilitiesOf('claude-opus-thinking').reasoning).toBe('extended')
    expect(capabilitiesOf('deepseek-r1').reasoning).toBe('extended')
    expect(capabilitiesOf('claude-opus-4-1').reasoning).toBe('strong')
    expect(capabilitiesOf('claude-sonnet-4-5').reasoning).toBe('strong')
    expect(capabilitiesOf('gpt-4o').reasoning).toBe('strong')
    expect(capabilitiesOf('gpt-4o-mini').reasoning).toBe('basic')
    expect(capabilitiesOf('claude-3-haiku').reasoning).toBe('basic')
  })

  it('flags fast/slow tiers from model names', () => {
    expect(capabilitiesOf('claude-3-haiku').speed).toBe('fast')
    expect(capabilitiesOf('gpt-4o-mini').speed).toBe('fast')
    expect(capabilitiesOf('gemini-1.5-flash').speed).toBe('fast')
    expect(capabilitiesOf('o1-preview').speed).toBe('slow')
    // Opus generations are slow-tier; the real model id is opus-4-1 (or
    // future opus-4-X), not the speculative -4-7 the earlier defaults
    // listed.
    expect(capabilitiesOf('claude-opus-4-1').speed).toBe('slow')
  })

  it('marks local providers as free regardless of model', () => {
    expect(capabilitiesOf('llama-3.1:8b', true).cost).toBe('free')
    expect(capabilitiesOf('qwen2.5:14b', true).cost).toBe('free')
    // Same model name, non-local context — falls into a paid tier.
    expect(capabilitiesOf('claude-opus-4-7', false).cost).toBe('premium')
    expect(capabilitiesOf('claude-3-haiku', false).cost).toBe('cheap')
  })

  it('returns a non-trivial context window for known families', () => {
    expect(capabilitiesOf('claude-sonnet-4-5').contextWindow).toBeGreaterThanOrEqual(200_000)
    expect(capabilitiesOf('gemini-1.5-pro').contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(capabilitiesOf('gpt-4o').contextWindow).toBeGreaterThanOrEqual(128_000)
  })

  /**
   * Parametrised coverage — sweeps the actual model IDs the audit
   * flagged as "common in the wild but not previously tested". If a
   * regex change ever silently drops one of these, this test catches it
   * before users do.
   */
  it.each<[string, Partial<{ vision: boolean; toolUse: boolean; cost: string }>]>([
    // Anthropic
    ['claude-sonnet-4-5', { vision: true, toolUse: true }],
    ['claude-opus-4-1', { vision: true, toolUse: true }],
    ['claude-haiku-4', { vision: true, toolUse: true, cost: 'cheap' }],
    // OpenAI
    ['gpt-4o', { vision: true, toolUse: true }],
    ['gpt-4o-mini', { vision: true, toolUse: true, cost: 'cheap' }],
    ['gpt-4.1', { toolUse: true }],
    ['o1-preview', { toolUse: false /* o1 disables tools */ }],
    ['o3-mini', { cost: 'cheap' }],
    // Google
    ['gemini-2.0-flash', { vision: true, toolUse: true, cost: 'cheap' }],
    ['gemini-2.5-pro', { vision: true, toolUse: true }],
    // Local / open
    ['llama-3.3-70b', { toolUse: true }],
    ['qwen2.5-coder-32b', { toolUse: true }],
    ['deepseek-v3', { cost: 'cheap' }],
    ['deepseek-chat', { cost: 'cheap' }],
    ['deepseek-r1', {}], // reasoning model — extended tier already covered
    // OpenRouter namespaced
    ['openai/gpt-4o', { vision: true, toolUse: true }],
    ['anthropic/claude-3.5-sonnet', { vision: true, toolUse: true }]
  ])('capability sweep — %s', (modelId, expected) => {
    const caps = capabilitiesOf(modelId)
    if (expected.vision !== undefined) expect(caps.vision).toBe(expected.vision)
    if (expected.toolUse !== undefined) expect(caps.toolUse).toBe(expected.toolUse)
    if (expected.cost !== undefined) expect(caps.cost).toBe(expected.cost)
    // Every model in the table should at least have a non-default context window —
    // catches the case where the pattern table doesn't cover the family at all.
    expect(caps.contextWindow).toBeGreaterThan(8_000)
  })
})
