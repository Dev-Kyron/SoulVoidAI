/**
 * Router tests — lock down the routing decisions before Phase 2 starts
 * piling on top of them. The router is pure (given inputs → returns a
 * pick) so testing is straightforward.
 *
 * What's covered:
 *   - Hard-requirement filtering (vision needed → only vision-capable
 *     candidates considered)
 *   - Soft-preference scoring (reasoning, fast, tool-heavy biases)
 *   - Cost-aware bias when nearCap is set
 *   - Tie-breaker preference for the user's active provider
 *   - Graceful fallback when no candidate satisfies hard requirements
 *   - deriveBudgetState threshold (80%)
 *
 * What's NOT covered (deferred to integration tests later):
 *   - The mid-send wiring inside useChatStore (zustand + IPC mocks
 *     would balloon this suite; the integration is small and reviewed
 *     by hand).
 */

import { describe, it, expect } from 'vitest'
import {
  classifyTask,
  pickProvider,
  deriveBudgetState,
  type AvailableProvider
} from './router'

/* ------------------------- task classifier --------------------------- */

describe('classifyTask', () => {
  it('flags vision when images attached, regardless of prompt', () => {
    const t = classifyTask({ prompt: 'what is this?', hasImages: true, agentMode: false })
    expect(t.kind).toBe('vision')
    expect(t.requiresVision).toBe(true)
  })

  it('flags tool-heavy when agent mode is on (without image)', () => {
    const t = classifyTask({ prompt: 'refactor the auth module', hasImages: false, agentMode: true })
    expect(t.kind).toBe('tool-heavy')
    expect(t.requiresToolUse).toBe(true)
  })

  it('vision wins over agent mode when both are present', () => {
    const t = classifyTask({ prompt: 'fix the layout', hasImages: true, agentMode: true })
    expect(t.kind).toBe('vision')
    expect(t.requiresVision).toBe(true)
    // But tool use still required so the loop can act on the analysis
    expect(t.requiresToolUse).toBe(true)
  })

  it('classifies reasoning from keyword density + length', () => {
    const t = classifyTask({
      prompt:
        'analyse this carefully and reason step by step about whether the proof is valid. '.repeat(8),
      hasImages: false,
      agentMode: false
    })
    expect(t.kind).toBe('reasoning')
  })

  it('classifies coding when code-related keywords appear', () => {
    const t = classifyTask({
      prompt: 'write a TypeScript function to debug this regex',
      hasImages: false,
      agentMode: false
    })
    expect(t.kind).toBe('coding')
  })

  it('flags fast when the user asks for a short answer', () => {
    const t = classifyTask({ prompt: 'tldr: what is electron-builder?', hasImages: false, agentMode: false })
    expect(t.kind).toBe('fast')
  })

  it('falls back to general when no clear signal', () => {
    const t = classifyTask({ prompt: 'hello there', hasImages: false, agentMode: false })
    expect(t.kind).toBe('general')
  })
})

/* ----------------------------- helpers ------------------------------- */

function provider(id: string, model: string, isLocal = false): AvailableProvider {
  return { id: id as AvailableProvider['id'], model, usable: true, isLocal }
}

/* --------------------------- pickProvider ---------------------------- */

describe('pickProvider', () => {
  it('returns null when nothing is usable', () => {
    const result = pickProvider({
      prompt: 'hi',
      hasImages: false,
      agentMode: false,
      available: [],
      activeProviderId: 'anthropic'
    })
    expect(result).toBeNull()
  })

  it('vision task routes to a vision-capable provider over the active one', () => {
    // Active is Ollama (no vision), Gemini is configured (vision capable).
    const result = pickProvider({
      prompt: 'what is in this picture?',
      hasImages: true,
      agentMode: false,
      available: [
        provider('ollama', 'qwen2.5:14b', true), // no vision
        provider('google', 'gemini-2.0-pro') // vision
      ],
      activeProviderId: 'ollama'
    })
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('google')
    expect(result!.overrideOfActive).toBe(true)
  })

  it('vision task falls back to active when no vision-capable provider is configured', () => {
    // Both providers lack vision — should NOT throw, should return the
    // active with a graceful reason. The existing image-warning toast
    // still surfaces in useChatStore.send() for the user.
    const result = pickProvider({
      prompt: 'what is in this picture?',
      hasImages: true,
      agentMode: false,
      available: [
        provider('ollama', 'qwen2.5:14b', true), // no vision
        provider('deepseek', 'deepseek-chat') // no vision
      ],
      activeProviderId: 'ollama'
    })
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('ollama')
    expect(result!.reason).toContain('no')
  })

  it('tool-heavy task prefers fast tool-use models over slow premium', () => {
    // Two candidates that BOTH support tool use:
    //   - claude-opus-4-7 (slow, premium, extended thinking)
    //   - claude-sonnet-4-5 (balanced/fast for sonnet, strong reasoning)
    // For 29-step agent loops Sonnet wins because speed dominates.
    const result = pickProvider({
      prompt: 'do the thing',
      hasImages: false,
      agentMode: true,
      available: [
        provider('anthropic', 'claude-opus-4-7'),
        provider('anthropic', 'claude-sonnet-4-5')
      ],
      activeProviderId: 'anthropic'
    })
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('claude-sonnet-4-5')
  })

  it('reasoning task prefers extended-thinking models', () => {
    const result = pickProvider({
      prompt:
        'Reason step by step through this and prove whether the algorithm terminates. ' +
        'Analyse the loop invariant and derive a bound. '.repeat(6),
      hasImages: false,
      agentMode: false,
      available: [
        provider('anthropic', 'claude-sonnet-4-5'), // strong reasoning
        provider('openai', 'o1-preview') // extended reasoning
      ],
      activeProviderId: 'anthropic'
    })
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('o1-preview')
  })

  it('budget near-cap biases toward local providers', () => {
    const result = pickProvider({
      prompt: 'something general',
      hasImages: false,
      agentMode: false,
      available: [
        provider('anthropic', 'claude-sonnet-4-5'), // standard cost
        provider('ollama', 'qwen2.5:14b', true) // free local
      ],
      activeProviderId: 'anthropic',
      budget: { nearCap: true }
    })
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('ollama')
    expect(result!.reason).toContain('budget: local')
  })

  it('without budget pressure, active provider wins on tie', () => {
    // Two functionally-equivalent providers — active should win.
    const result = pickProvider({
      prompt: 'hi there',
      hasImages: false,
      agentMode: false,
      available: [
        provider('anthropic', 'claude-sonnet-4-5'),
        provider('openai', 'gpt-4o')
      ],
      activeProviderId: 'anthropic'
    })
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('anthropic')
  })
})

/* ------------------------ deriveBudgetState -------------------------- */

describe('deriveBudgetState', () => {
  it('returns undefined when no cap is set', () => {
    expect(deriveBudgetState(15, null)).toBeUndefined()
  })

  it('returns undefined for zero or negative caps', () => {
    expect(deriveBudgetState(15, 0)).toBeUndefined()
  })

  it('flags nearCap at exactly 80%', () => {
    expect(deriveBudgetState(16, 20)).toEqual({ nearCap: true })
  })

  it('does NOT flag below 80%', () => {
    expect(deriveBudgetState(15.99, 20)).toEqual({ nearCap: false })
  })

  it('flags nearCap above 100% (over-budget stays in cheap mode)', () => {
    expect(deriveBudgetState(25, 20)).toEqual({ nearCap: true })
  })
})
