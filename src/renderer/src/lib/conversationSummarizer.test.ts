import { describe, expect, it } from 'vitest'
import { estimateTokens } from './conversationSummarizer'
import type { ChatMessage } from '@shared/types'

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
        attachments: [
          { id: 'a', kind: 'text', name: 'notes.txt', text: 'b'.repeat(339) }
        ]
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
