import { describe, expect, it } from 'vitest'
import { detectArtifact } from './artifactDetector'

// The detector decides whether the streaming reply is an artifact-worthy code
// block. Locking the thresholds prevents accidental drift where every short
// inline ` `print('hi')` ` snippet starts popping the canvas mid-conversation.

describe('detectArtifact', () => {
  it('returns null for plain prose', () => {
    expect(detectArtifact('just a normal answer about something')).toBeNull()
  })

  it('returns null for short snippets (under 200 chars AND under 8 lines)', () => {
    const text = '```python\nprint("hi")\n```'
    expect(detectArtifact(text)).toBeNull()
  })

  it('returns null when the fence has no language tag', () => {
    // Prose-style triple backticks (no language) shouldn't trigger.
    const big = 'a'.repeat(500)
    expect(detectArtifact('```\n' + big + '\n```')).toBeNull()
  })

  it('detects a substantial block by char count', () => {
    const body = 'a'.repeat(220)
    const text = `Here is the code:\n\n\`\`\`python\n${body}\n\`\`\``
    const out = detectArtifact(text)
    expect(out).not.toBeNull()
    expect(out?.language).toBe('python')
    expect(out?.code).toBe(body)
    expect(out?.closed).toBe(true)
  })

  it('detects a long-lines block by line count', () => {
    const body = Array(10).fill('line').join('\n')
    const text = `\`\`\`html\n${body}\n\`\`\``
    const out = detectArtifact(text)
    expect(out).not.toBeNull()
    expect(out?.code).toBe(body)
  })

  it('returns the LATEST block when there are multiple', () => {
    // The previous artifact has closed; the new in-progress one wins.
    const text =
      '```js\n' +
      'first old block\n'.repeat(10) +
      '```\n\n' +
      'And here is the new:\n\n' +
      '```tsx\n' +
      'second new block\n'.repeat(10) +
      '```'
    const out = detectArtifact(text)
    expect(out?.language).toBe('tsx')
    expect(out?.code).toContain('second new block')
  })

  it('marks unclosed blocks (stream in progress) as not closed', () => {
    // Long enough to qualify but missing the trailing fence — the model is
    // still writing.
    const body = 'line\n'.repeat(10)
    const text = `\`\`\`python\n${body}`
    const out = detectArtifact(text)
    expect(out).not.toBeNull()
    expect(out?.closed).toBe(false)
  })

  it('preserves case-folded language tags', () => {
    // Different models capitalise differently ("```Python" vs "```python").
    // The detector normalises to lowercase so the Canvas's syntax highlighter
    // doesn't have to fork on case.
    const body = 'x = 1\n'.repeat(10)
    const out = detectArtifact(`\`\`\`Python\n${body}\`\`\``)
    expect(out?.language).toBe('python')
  })

  it('ignores ``` that appears mid-line (e.g. in prose like "use ``` for fences")', () => {
    // The detector requires the fence at line start. Inline-text occurrences
    // shouldn't trigger.
    const body = 'a'.repeat(500)
    const text = `Use \`\`\`python at the start of a line. ${body}`
    expect(detectArtifact(text)).toBeNull()
  })
})
