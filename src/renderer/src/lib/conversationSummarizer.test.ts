import { describe, expect, it } from 'vitest'
import { estimateTokens, estimateTurnTokens } from './conversationSummarizer'
import type { ChatMessage, ChatTurn } from '@shared/types'

const baseMsg: Omit<ChatMessage, 'id' | 'content'> = {
  role: 'user',
  createdAt: '2026-01-01T00:00:00.000Z'
}

describe('estimateTokens', () => {
  it('returns zero for an empty conversation', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('estimates conservatively from character count', () => {
    // 350 chars of content → 350/3.5 = 100 tokens.
    const text = 'a'.repeat(350)
    const tokens = estimateTokens([{ id: 'm', ...baseMsg, content: text }])
    expect(tokens).toBe(100)
  })

  it('excludes the synthetic welcome message', () => {
    const tokens = estimateTokens([
      { id: 'welcome', ...baseMsg, content: 'x'.repeat(700) },
      { id: 'real', ...baseMsg, content: 'a'.repeat(350) }
    ])
    // Only the real one should count (100 tokens).
    expect(tokens).toBe(100)
  })

  it('counts text attachments alongside the main body', () => {
    const tokens = estimateTokens([
      {
        id: 'm',
        ...baseMsg,
        content: 'hello world', // 11 chars
        attachments: [{ id: 'a', kind: 'text', name: 'notes.txt', text: 'b'.repeat(339) }]
      }
    ])
    // 11 + 339 = 350 chars → 100 tokens.
    expect(tokens).toBe(100)
  })

  it('rounds to the nearest whole token', () => {
    // 4 chars → 4/3.5 = 1.14 → rounds to 1.
    const tokens = estimateTokens([{ id: 'm', ...baseMsg, content: 'abcd' }])
    expect(tokens).toBe(1)
  })
})

describe('estimateTurnTokens', () => {
  it('counts the user turn content', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: 'a'.repeat(350) }]
    expect(estimateTurnTokens(turns)).toBe(100)
  })

  it('counts tool-call args and tool-result content', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'web_fetch', args: { url: 'a'.repeat(100) } }]
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ id: 't1', name: 'web_fetch', content: 'a'.repeat(200) }]
      }
    ]
    const tokens = estimateTurnTokens(turns)
    // Tool-call: name(9) + JSON.stringify({url: 'a'.repeat(100)}) ~ 113
    // Tool-result: 200
    // Total roughly (9 + 113 + 200) / 3.5 ~ 92
    expect(tokens).toBeGreaterThan(80)
    expect(tokens).toBeLessThan(120)
  })

  it('charges images at ~4000 chars each (conservative)', () => {
    const turns: ChatTurn[] = [
      {
        role: 'user',
        content: '',
        images: ['data:image/png;base64,...', 'data:image/png;base64,...']
      }
    ]
    // 2 images × 4000 chars = 8000 chars → 8000/3.5 ≈ 2286 tokens
    const tokens = estimateTurnTokens(turns)
    expect(tokens).toBeGreaterThan(2000)
  })
})
