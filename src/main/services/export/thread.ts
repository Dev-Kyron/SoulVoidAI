/**
 * Per-thread export to the formats beta testers actually paste their AI
 * conversations into — Word, Excel, PDF, plus the lightweight ones
 * (Markdown, plain text). The whole-app bundle export lives in
 * storage/sync.ts; this is the user-facing "I want this one conversation
 * as a document" path, surfaced from the threads drawer 3-dot menu.
 *
 * Format choices:
 *   · MARKDOWN — `# Title` + one `**role**:` block per message. Plays
 *     nicely with Obsidian, Notion, GitHub READMEs.
 *   · TXT — raw transcript. Anywhere a `.md` won't render.
 *   · DOCX — proper Word document with headings, role-prefixed paragraphs
 *     and code-block runs. The `docx` package emits real OOXML, not a
 *     Word-readable HTML/RTF.
 *   · XLSX — one row per message: timestamp, role, content, model. The
 *     natural shape for spreadsheet analysis — beta testers asked to
 *     "see how the model's tone drifts across a session" which is exactly
 *     what a sortable column gives them.
 *   · PDF — Electron's webContents.printToPDF on a hidden BrowserWindow
 *     loading our HTML transcript. No new native deps; rendered output
 *     looks like a printed chat log.
 *
 * Save dialog lives at the IPC layer (ipc/index.ts) so this module stays
 * pure — give it a thread id and a format, get back the bytes + a
 * suggested filename, the caller writes to disk.
 */
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import * as XLSX from 'xlsx'
import { BrowserWindow } from 'electron'
import { getThreadMessages, summaryFor } from '../storage/history'
import type { ChatMessage } from '@shared/types'

export type ThreadExportFormat = 'markdown' | 'txt' | 'docx' | 'xlsx' | 'pdf' | 'html'

export interface ThreadExportResult {
  bytes: Buffer
  suggestedFilename: string
  mimeType: string
}

/* ------------------------- shared helpers --------------------------- */

interface ThreadBundle {
  title: string
  threadId: string
  exportedAt: string
  messages: ChatMessage[]
}

/**
 * Pulls the messages + summary for one thread and bundles them for the
 * format-specific renderers below. Throws if the thread doesn't exist
 * so the caller can surface a clean error.
 */
function loadThreadBundle(threadId: string): ThreadBundle {
  const summary = summaryFor(threadId)
  if (!summary) throw new Error(`Thread ${threadId} not found.`)
  const messages = getThreadMessages(threadId)
  return {
    title: summary.title,
    threadId,
    exportedAt: new Date().toISOString(),
    messages
  }
}

/**
 * Filesystem-safe slug derived from the thread title. Falls back to the
 * thread id if the title is empty or strips to nothing after sanitising.
 * Windows is the strictest target — no `<>:"/\|?*`, no trailing dots/spaces,
 * length capped at 80 so the OS still has headroom for the extension and
 * path prefix.
 */
function safeBaseName(title: string, threadId: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return cleaned || `thread-${threadId.slice(0, 8)}`
}

/**
 * Human-friendly timestamp for transcript headers. Locale-neutral so the
 * exported file looks the same regardless of the host's regional settings.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Assistant'
  if (role === 'system') return 'System'
  return role
}

/* ----------------------------- markdown ---------------------------- */

function renderMarkdown(bundle: ThreadBundle): string {
  const header = [
    `# ${bundle.title}`,
    '',
    `_Exported ${formatTimestamp(bundle.exportedAt)} · ${bundle.messages.length} message${bundle.messages.length === 1 ? '' : 's'}_`,
    '',
    '---',
    ''
  ].join('\n')

  const body = bundle.messages
    .map((m) => {
      const head = `**${roleLabel(m.role)}** · ${formatTimestamp(m.createdAt)}${m.model ? ` · ${m.model}` : ''}`
      return `${head}\n\n${m.content || '_(empty)_'}\n`
    })
    .join('\n---\n\n')

  return `${header}\n${body}`
}

/* ----------------------------- plain text -------------------------- */

function renderTxt(bundle: ThreadBundle): string {
  const header = `${bundle.title}\n${'='.repeat(bundle.title.length)}\nExported ${formatTimestamp(bundle.exportedAt)}\n\n`
  const body = bundle.messages
    .map((m) => {
      const head = `[${formatTimestamp(m.createdAt)}] ${roleLabel(m.role).toUpperCase()}${m.model ? ` (${m.model})` : ''}`
      return `${head}\n${m.content || '(empty)'}\n`
    })
    .join('\n')
  return header + body
}

/* ----------------------------- HTML / PDF -------------------------- */

/**
 * HTML transcript used both as a direct export format AND as the source
 * loaded by the hidden BrowserWindow for the PDF route. Inline styles so
 * the file is self-contained — no external CSS, no remote fonts. The
 * font stack mirrors the in-app chat (Inter for prose, JetBrains-style
 * mono for code), with safe fallbacks.
 */
function renderHtml(bundle: ThreadBundle): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  // Preserve newlines / indentation in the message body via <pre>-style
  // white-space rules; markdown is just shown as text — we don't want the
  // exported PDF to ship its own markdown renderer when the user is
  // likely to print it anyway.
  const messages = bundle.messages
    .map((m) => {
      const head = `${roleLabel(m.role)} · ${formatTimestamp(m.createdAt)}${m.model ? ` · ${m.model}` : ''}`
      return `
        <article class="msg msg-${m.role}">
          <header>${escape(head)}</header>
          <div class="body">${escape(m.content || '(empty)')}</div>
        </article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(bundle.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff; margin: 0; padding: 32px 40px; max-width: 780px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #888; font-size: 11px; margin-bottom: 24px; }
  .msg { margin: 0 0 18px; padding: 12px 14px; border-radius: 8px; border: 1px solid #e6e6e6; page-break-inside: avoid; }
  .msg-user { background: #f4f6fb; }
  .msg-assistant { background: #fafafa; }
  .msg-system { background: #fff8e1; }
  .msg > header { font-size: 11px; font-weight: 600; color: #555; margin-bottom: 6px; }
  .msg .body { white-space: pre-wrap; font-size: 13px; line-height: 1.55; font-family: inherit; }
  code, pre { font-family: 'JetBrains Mono', Consolas, monospace; }
</style>
</head>
<body>
  <h1>${escape(bundle.title)}</h1>
  <p class="meta">Exported ${escape(formatTimestamp(bundle.exportedAt))} · ${bundle.messages.length} message${bundle.messages.length === 1 ? '' : 's'}</p>
  ${messages}
</body>
</html>`
}

/**
 * Renders the HTML transcript to a PDF via a hidden BrowserWindow +
 * webContents.printToPDF. No new native dep, ships native Chromium's
 * print pipeline (the same one File → Print uses). Slightly heavier
 * than a pure-Node PDF generator but the output looks identical to
 * what the user sees in print preview.
 */
async function renderPdf(bundle: ThreadBundle): Promise<Buffer> {
  const html = renderHtml(bundle)
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // No node integration / preload — this is a sandboxed print page
      // that only ever loads a single self-contained HTML data URL.
      sandbox: true,
      contextIsolation: true,
      offscreen: true
    }
  })
  try {
    // Data URL loads synchronously without touching the network. encodeURI
    // (not encodeURIComponent) preserves the HTML structure; the meta
    // charset tag inside the HTML handles UTF-8 decoding on the receiving
    // end.
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    await win.loadURL(dataUrl)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })
    return pdf
  } finally {
    win.destroy()
  }
}

/* ----------------------------- docx -------------------------------- */

async function renderDocx(bundle: ThreadBundle): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: bundle.title,
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Exported ${formatTimestamp(bundle.exportedAt)} · ${bundle.messages.length} messages`,
          italics: true,
          color: '888888',
          size: 18 // half-points → 9pt
        })
      ]
    }),
    new Paragraph({ text: '' })
  ]

  for (const m of bundle.messages) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${roleLabel(m.role)} · ${formatTimestamp(m.createdAt)}${m.model ? ` · ${m.model}` : ''}`,
            bold: true,
            size: 20 // 10pt
          })
        ],
        spacing: { before: 240, after: 80 }
      })
    )
    // Split message body by newline so each line becomes a paragraph —
    // a single Paragraph with embedded `\n` collapses to one line in
    // Word, which loses code blocks and lists entirely.
    const lines = (m.content || '(empty)').split('\n')
    for (const line of lines) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 22 })] // 11pt
        })
      )
    }
  }

  const doc = new Document({
    creator: 'VoidSoul Assistant',
    title: bundle.title,
    sections: [{ children }]
  })
  return Packer.toBuffer(doc)
}

/* ----------------------------- xlsx -------------------------------- */

function renderXlsx(bundle: ThreadBundle): Buffer {
  // Header row + one row per message. Sheet name uses the thread title
  // truncated to Excel's 31-char limit and sanitised of the chars Excel
  // rejects in sheet names (\\, /, ?, *, [, ]).
  const rows: Array<Array<string | number>> = [
    ['Timestamp (UTC)', 'Role', 'Model', 'Content', 'Tool Calls']
  ]
  for (const m of bundle.messages) {
    rows.push([
      formatTimestamp(m.createdAt),
      roleLabel(m.role),
      m.model || '',
      m.content || '',
      m.toolCalls?.length ? String(m.toolCalls.length) : ''
    ])
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  // Sensible column widths so the user doesn't have to manually expand
  // every column on first open. Content gets the lion's share.
  sheet['!cols'] = [
    { wch: 22 },
    { wch: 12 },
    { wch: 22 },
    { wch: 80 },
    { wch: 10 }
  ]
  const sheetName = bundle.title
    .replace(/[\\/?*[\]]/g, ' ')
    .trim()
    .slice(0, 31) || 'Conversation'

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  // `array` returns ArrayBuffer-like; wrap to Node Buffer for the IPC
  // return path which expects a Uint8Array-compatible value.
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return out
}

/* ----------------------------- entry point ------------------------- */

/**
 * Render a thread to the requested format. Returns the bytes + a
 * suggested filename + the MIME type so the caller can wire up a save
 * dialog or HTTP response without per-format branching.
 */
export async function exportThread(
  threadId: string,
  format: ThreadExportFormat
): Promise<ThreadExportResult> {
  const bundle = loadThreadBundle(threadId)
  const base = safeBaseName(bundle.title, threadId)

  switch (format) {
    case 'markdown':
      return {
        bytes: Buffer.from(renderMarkdown(bundle), 'utf-8'),
        suggestedFilename: `${base}.md`,
        mimeType: 'text/markdown'
      }
    case 'txt':
      return {
        bytes: Buffer.from(renderTxt(bundle), 'utf-8'),
        suggestedFilename: `${base}.txt`,
        mimeType: 'text/plain'
      }
    case 'html':
      return {
        bytes: Buffer.from(renderHtml(bundle), 'utf-8'),
        suggestedFilename: `${base}.html`,
        mimeType: 'text/html'
      }
    case 'docx':
      return {
        bytes: await renderDocx(bundle),
        suggestedFilename: `${base}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    case 'xlsx':
      return {
        bytes: renderXlsx(bundle),
        suggestedFilename: `${base}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    case 'pdf':
      return {
        bytes: await renderPdf(bundle),
        suggestedFilename: `${base}.pdf`,
        mimeType: 'application/pdf'
      }
    default: {
      // Exhaustiveness check — adding a new format to the union without
      // a branch here flags as a type error at compile time.
      const exhaustive: never = format
      throw new Error(`Unknown export format: ${String(exhaustive)}`)
    }
  }
}
