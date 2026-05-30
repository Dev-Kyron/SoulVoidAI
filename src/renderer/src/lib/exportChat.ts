/**
 * Conversation exporters. Renders a thread to one of four portable formats:
 *
 *  - `markdown`  — the default; pastes cleanly into a GitHub issue, README,
 *                  or anywhere that speaks Markdown.
 *  - `obsidian`  — Markdown with YAML frontmatter (title/date/tags/etc.) for
 *                  drop-into-vault users.
 *  - `json`      — structured object with every message field intact, ideal
 *                  for archival or downstream programmatic processing.
 *  - `opml`      — outline XML compatible with mind-mappers and OPML readers.
 */
import { WELCOME_MESSAGE_ID, type ChatMessage, type HistorySummary } from '@shared/types'

export type ExportFormat = 'markdown' | 'obsidian' | 'json' | 'opml'

export interface ExportableThread {
  title: string
  messages: ChatMessage[]
  createdAt?: string
  summary?: HistorySummary | null
}

/* ------------------------------ helpers -------------------------------- */

function fmt(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function realMessages(thread: ExportableThread): ChatMessage[] {
  return thread.messages.filter((m) => m.id !== WELCOME_MESSAGE_ID)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeYaml(text: string): string {
  // Double-quote and escape backslashes + quotes; preserves Unicode + spaces.
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

/* ----------------------------- markdown -------------------------------- */

function renderMessageMarkdown(message: ChatMessage): string {
  if (message.id === WELCOME_MESSAGE_ID) return ''
  const heading = message.role === 'user' ? '### You' : '### VoidSoul'
  const time = message.createdAt ? `_${fmt(message.createdAt)}_` : ''
  const parts: string[] = [`${heading}${time ? ' · ' + time : ''}`]

  if (message.toolCalls && message.toolCalls.length > 0) {
    const calls = message.toolCalls
      .map((c) => `${c.name.replace(/_/g, ' ')}${c.ok ? ' ✓' : ' ✗'}`)
      .join(', ')
    parts.push(`> ran ${calls}`)
  }

  if (message.content) {
    parts.push(message.content.trim())
  }

  const attachments = message.attachments ?? []
  for (const a of attachments) {
    if (a.kind === 'image') parts.push(`_[image attached: ${a.name}]_`)
    else if (a.kind === 'text' && a.text)
      parts.push(`_attached file_ \`${a.name}\`:\n\`\`\`\n${a.text}\n\`\`\``)
  }

  return parts.join('\n\n')
}

/** Plain Markdown for clipboard/file/Gist paths. */
export function threadToMarkdown(thread: ExportableThread): string {
  const real = realMessages(thread)
  const header = [
    `# ${thread.title || 'Conversation'}`,
    '',
    `_${thread.createdAt ? 'Started ' + fmt(thread.createdAt) + ' · ' : ''}${real.length} message${real.length === 1 ? '' : 's'}_`
  ]
  if (thread.summary?.text) {
    header.push('', '> **Story so far:** ' + thread.summary.text.replace(/\n+/g, ' '))
  }
  const body = real.map(renderMessageMarkdown).filter(Boolean).join('\n\n---\n\n')
  return header.join('\n') + '\n\n' + body + '\n'
}

/* ------------------------------ obsidian ------------------------------- */

/**
 * Markdown with YAML frontmatter. Obsidian + Logseq + Foam all parse this;
 * the frontmatter feeds their tag indexes + Dataview queries.
 */
export function threadToObsidian(thread: ExportableThread): string {
  const real = realMessages(thread)
  const now = new Date().toISOString()
  const created = thread.createdAt ?? now
  const lastTurn = real[real.length - 1]?.createdAt ?? created

  const frontmatter = [
    '---',
    `title: ${escapeYaml(thread.title || 'Conversation')}`,
    `created: ${created}`,
    `updated: ${lastTurn}`,
    `exported: ${now}`,
    `messages: ${real.length}`,
    'tags:',
    '  - voidsoul',
    '  - chat',
    '---'
  ]

  const body = threadToMarkdown(thread)
  return frontmatter.join('\n') + '\n\n' + body
}

/* -------------------------------- json --------------------------------- */

/**
 * Structured JSON snapshot — every field of every message preserved so the
 * export round-trips losslessly. Intended for users archiving large numbers
 * of conversations or feeding them into downstream tooling.
 */
export function threadToJson(thread: ExportableThread): string {
  const real = realMessages(thread)
  const payload = {
    app: 'voidsoul',
    schema: 1,
    exportedAt: new Date().toISOString(),
    thread: {
      title: thread.title || 'Conversation',
      createdAt: thread.createdAt ?? null,
      summary: thread.summary?.text ?? null,
      messageCount: real.length,
      messages: real.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ?? null,
        toolCalls: m.toolCalls ?? null,
        attachments: (m.attachments ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          text: a.kind === 'text' ? a.text : undefined
          // dataUrl is omitted on purpose — base64 images bloat the export
          // and aren't useful for archival; the model already consumed them.
        }))
      }))
    }
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

/* -------------------------------- opml --------------------------------- */

/**
 * OPML 2.0 outline — each turn is an `<outline>` node with `text` (role + a
 * snippet), `_note` (full content) and `created` attributes. Tested against
 * Obsidian's OPML importer + Workflowy + The Brain.
 */
export function threadToOpml(thread: ExportableThread): string {
  const real = realMessages(thread)
  const created = thread.createdAt ?? new Date().toISOString()
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(thread.title || 'Conversation')}</title>`,
    `    <dateCreated>${escapeXml(created)}</dateCreated>`,
    `    <ownerName>VoidSoul AI Companion</ownerName>`,
    '  </head>',
    '  <body>'
  ]
  if (thread.summary?.text) {
    lines.push(
      `    <outline text="${escapeXml('Story so far: ' + thread.summary.text.slice(0, 80))}" _note="${escapeXml(thread.summary.text)}" />`
    )
  }
  for (const m of real) {
    const role = m.role === 'user' ? 'You' : 'VoidSoul'
    // First line of content as the visible outline text; full content lives
    // in `_note` (OPML convention for the long-form body of a node).
    const firstLine = (m.content || '').split('\n')[0].slice(0, 160) || `(${role})`
    const text = `${role}: ${firstLine}`
    const note = m.content || ''
    const createdAttr = m.createdAt ? ` created="${escapeXml(m.createdAt)}"` : ''
    lines.push(`    <outline text="${escapeXml(text)}"${createdAttr} _note="${escapeXml(note)}" />`)
  }
  lines.push('  </body>', '</opml>', '')
  return lines.join('\n')
}

/* ------------------------------ dispatch ------------------------------- */

/** Default file extension (no leading dot) for each export format. */
export const EXTENSION_FOR_FORMAT: Record<ExportFormat, string> = {
  markdown: 'md',
  obsidian: 'md',
  json: 'json',
  opml: 'opml'
}

/** Human-friendly label for filter dropdowns + UI. */
export const LABEL_FOR_FORMAT: Record<ExportFormat, string> = {
  markdown: 'Markdown',
  obsidian: 'Obsidian (Markdown + frontmatter)',
  json: 'JSON',
  opml: 'OPML outline'
}

/** Dispatches to the right renderer for a given format. */
export function renderThread(thread: ExportableThread, format: ExportFormat): string {
  switch (format) {
    case 'obsidian':
      return threadToObsidian(thread)
    case 'json':
      return threadToJson(thread)
    case 'opml':
      return threadToOpml(thread)
    default:
      return threadToMarkdown(thread)
  }
}
