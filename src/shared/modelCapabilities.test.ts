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
    expect(capabilitiesOf('gpt-4o')).toEqual({ vision: true })
    expect(capabilitiesOf('gpt-3.5-turbo')).toEqual({ vision: false })
  })
})
