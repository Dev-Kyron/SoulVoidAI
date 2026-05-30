import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_FOR_FORMAT,
  renderThread,
  threadToJson,
  threadToMarkdown,
  threadToObsidian,
  threadToOpml,
  type ExportableThread
} from './exportChat'

function thread(): ExportableThread {
  return {
    title: 'UE5 input <handling>',
    createdAt: '2026-01-15T09:00:00.000Z',
    summary: {
      text: 'Discussed PlayerController input mapping.',
      coversUpToId: 'm1',
      generatedAt: '2026-01-15T09:30:00.000Z'
    },
    messages: [
      { id: 'welcome', role: 'assistant', content: 'hi', createdAt: '2026-01-15T08:59:00.000Z' },
      {
        id: 'm1',
        role: 'user',
        content: 'How do I handle player input?',
        createdAt: '2026-01-15T09:00:01.000Z'
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Use Enhanced Input — bind an Input Action.',
        createdAt: '2026-01-15T09:00:05.000Z',
        toolCalls: [
          {
            id: 't1',
            name: 'web_fetch',
            args: { url: 'https://docs.unrealengine.com/...' },
            result: 'docs fetched',
            ok: true
          }
        ]
      }
    ]
  }
}

describe('threadToMarkdown', () => {
  it('renders a title header, metadata line and turns separated by hr', () => {
    const md = threadToMarkdown(thread())
    expect(md).toContain('# UE5 input <handling>')
    expect(md).toContain('2 messages')
    expect(md).toContain('### You')
    expect(md).toContain('### VoidSoul')
    expect(md).toContain('---')
    // Welcome message is filtered out.
    expect(md).not.toMatch(/^hi$/m)
  })

  it('includes the story-so-far block when a summary is set', () => {
    expect(threadToMarkdown(thread())).toContain('Story so far')
  })

  it('describes tool calls with a > ran line', () => {
    expect(threadToMarkdown(thread())).toContain('> ran web fetch ✓')
  })
})

describe('threadToObsidian', () => {
  it('prepends a YAML frontmatter block with title/dates/tags', () => {
    const out = threadToObsidian(thread())
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('title: "UE5 input <handling>"')
    expect(out).toContain('messages: 2')
    expect(out).toContain('tags:')
    expect(out).toContain('  - voidsoul')
    expect(out).toContain('  - chat')
    // Markdown body still present after the frontmatter.
    expect(out).toContain('# UE5 input <handling>')
  })

  it('escapes quotes and backslashes in the YAML title', () => {
    const t = thread()
    t.title = 'A "quoted" \\ title'
    const out = threadToObsidian(t)
    expect(out).toContain('title: "A \\"quoted\\" \\\\ title"')
  })
})

describe('threadToJson', () => {
  it('returns valid JSON with the right top-level shape', () => {
    const json = threadToJson(thread())
    const parsed = JSON.parse(json) as {
      app: string
      schema: number
      thread: { title: string; messageCount: number; messages: Array<{ id: string }> }
    }
    expect(parsed.app).toBe('voidsoul')
    expect(parsed.schema).toBe(1)
    expect(parsed.thread.title).toBe('UE5 input <handling>')
    expect(parsed.thread.messageCount).toBe(2)
    // Welcome message is filtered out of the payload.
    expect(parsed.thread.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('preserves tool calls verbatim', () => {
    const parsed = JSON.parse(threadToJson(thread())) as {
      thread: { messages: Array<{ id: string; toolCalls: unknown }> }
    }
    const assistant = parsed.thread.messages.find((m) => m.id === 'm2')
    expect(assistant?.toolCalls).toBeTruthy()
  })

  it('strips dataUrl attachments to keep the export svelte', () => {
    const t = thread()
    t.messages.push({
      id: 'm3',
      role: 'user',
      content: 'See attached',
      createdAt: '2026-01-15T09:01:00.000Z',
      attachments: [
        { id: 'a1', kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,ZZZZ' }
      ]
    })
    const json = threadToJson(t)
    expect(json).not.toContain('ZZZZ')
    expect(json).toContain('shot.png')
  })
})

describe('threadToOpml', () => {
  it('emits a well-formed OPML 2.0 document', () => {
    const xml = threadToOpml(thread())
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true)
    expect(xml).toContain('<opml version="2.0">')
    expect(xml).toContain('</opml>')
    expect(xml).toContain('<head>')
    expect(xml).toContain('<body>')
  })

  it('XML-escapes title + content', () => {
    const xml = threadToOpml(thread())
    expect(xml).toContain('UE5 input &lt;handling&gt;')
    // The user message survives with proper escaping.
    expect(xml).toContain('You: How do I handle player input?')
  })

  it('puts every real message under <body> as an outline node', () => {
    const xml = threadToOpml(thread())
    // 2 real messages + 1 story-so-far entry = 3 outline nodes.
    const matches = xml.match(/<outline /g) ?? []
    expect(matches.length).toBe(3)
  })
})

describe('renderThread / EXTENSION_FOR_FORMAT', () => {
  // JSON + OPML exporters stamp `new Date().toISOString()` into the payload,
  // so dispatch parity needs a frozen clock — otherwise the two sides of the
  // equality differ by a tick.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches to the right exporter per format id', () => {
    const t = thread()
    expect(renderThread(t, 'markdown')).toBe(threadToMarkdown(t))
    expect(renderThread(t, 'obsidian')).toBe(threadToObsidian(t))
    expect(renderThread(t, 'json')).toBe(threadToJson(t))
    expect(renderThread(t, 'opml')).toBe(threadToOpml(t))
  })

  it('maps every format to a file extension', () => {
    expect(EXTENSION_FOR_FORMAT.markdown).toBe('md')
    expect(EXTENSION_FOR_FORMAT.obsidian).toBe('md')
    expect(EXTENSION_FOR_FORMAT.json).toBe('json')
    expect(EXTENSION_FOR_FORMAT.opml).toBe('opml')
  })
})
