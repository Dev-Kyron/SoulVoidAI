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
import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
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

/* ----------------------- single-content export ---------------------- */

/**
 * Render a single chunk of arbitrary content (a script, a summary, a
 * generated essay) to the requested format. Used by the AI-callable
 * `save_as_document` tool — the model passes whatever it just wrote +
 * a format + a filename, and the action layer pipes the bytes through
 * a save dialog. Reuses the per-format renderers above by wrapping the
 * content in a single-message ThreadBundle so we don't duplicate the
 * docx / xlsx / pdf rendering logic.
 *
 * For XLSX, the content is interpreted as CSV-shaped text (one row
 * per line, columns separated by tab or comma) so the model can
 * produce a real table instead of a single text cell. Falls back to
 * a one-cell sheet if the content has no separators.
 */
export async function renderContent(
  content: string,
  format: ThreadExportFormat,
  filename: string,
  title?: string
): Promise<ThreadExportResult> {
  const base = safeBaseName(filename, randomBaseFallback())
  const displayTitle = title?.trim() || filename

  // XLSX gets its own renderer because CSV-shaped input becomes a real
  // grid, not a single text cell wrapped in a transcript shell.
  if (format === 'xlsx') {
    const rows = parseTabularContent(content)
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!cols'] = inferColumnWidths(rows)
    const sheetName = displayTitle.replace(/[\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet1'
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, sheetName)
    return {
      bytes: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      suggestedFilename: `${base}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
  }

  // For the document formats, wrap the content in a one-message bundle
  // labelled with the title so the existing renderers produce a clean
  // single-section document instead of a transcript layout.
  const bundle: ThreadBundle = {
    title: displayTitle,
    threadId: '',
    exportedAt: new Date().toISOString(),
    messages: [
      {
        id: 'doc',
        role: 'assistant',
        content,
        createdAt: new Date().toISOString()
      }
    ]
  }
  return exportBundleAs(bundle, format, base)
}

/** Generates a short random suffix for filename fallback when the user-
 *  supplied name strips to nothing after sanitising. */
function randomBaseFallback(): string {
  return `document-${Math.random().toString(36).slice(2, 8)}`
}

/** Tab- or comma-separated lines → 2D array. One-column fallback when
 *  no separators are found anywhere. Lines with mixed separators stay
 *  consistent within their own line — we don't try to be too clever. */
function parseTabularContent(content: string): string[][] {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return [[content]]
  const hasTabs = lines.some((l) => l.includes('\t'))
  const sep = hasTabs ? '\t' : ','
  // If neither separator appears, fall back to a single-column dump so
  // the user still gets the text somewhere instead of a blank sheet.
  const anySep = lines.some((l) => l.includes(sep))
  if (!anySep) return lines.map((l) => [l])
  return lines.map((l) => l.split(sep).map((c) => c.trim()))
}

/** Pick column widths from actual content — capped so a single long
 *  cell doesn't make Excel scroll horizontally forever. */
function inferColumnWidths(rows: string[][]): Array<{ wch: number }> {
  if (rows.length === 0) return []
  const cols = Math.max(...rows.map((r) => r.length))
  return Array.from({ length: cols }, (_, i) => {
    const max = Math.max(...rows.map((r) => (r[i]?.length ?? 0)))
    return { wch: Math.min(Math.max(max + 2, 10), 60) }
  })
}

/** Shared exit path for the document formats (everything except xlsx). */
async function exportBundleAs(
  bundle: ThreadBundle,
  format: Exclude<ThreadExportFormat, 'xlsx'>,
  base: string
): Promise<ThreadExportResult> {
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
    case 'pdf':
      return {
        bytes: await renderPdf(bundle),
        suggestedFilename: `${base}.pdf`,
        mimeType: 'application/pdf'
      }
  }
}

/**
 * Render a thread to the requested format. Returns the bytes + a
 * suggested filename + the MIME type so the caller can wire up a save
 * dialog or HTTP response without per-format branching.
 *
 * XLSX takes its own path because the transcript-shaped renderer is
 * different from the document-shaped one (rows-per-message, not a
 * single styled body). Every other format delegates to exportBundleAs
 * which is shared with renderContent — adding a new format is a one-
 * place change there.
 */
export async function exportThread(
  threadId: string,
  format: ThreadExportFormat
): Promise<ThreadExportResult> {
  const bundle = loadThreadBundle(threadId)
  const base = safeBaseName(bundle.title, threadId)
  if (format === 'xlsx') {
    return {
      bytes: renderXlsx(bundle),
      suggestedFilename: `${base}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
  }
  return exportBundleAs(bundle, format, base)
}

/* ---------------------- shared save-dialog + write ------------------- */

const FORMAT_FILTER_NAME: Record<ThreadExportFormat, string> = {
  markdown: 'Markdown',
  txt: 'Plain text',
  html: 'HTML',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pdf: 'PDF document'
}

export interface SaveResult {
  ok: boolean
  message: string
  path?: string
}

/**
 * Show the OS save dialog anchored to the given window (or the focused
 * one when omitted), then write the rendered bytes to the chosen path.
 * Returns a user-facing message — callers toast it unchanged. Used by
 * both the per-thread export IPC and the AI-callable save-document
 * action, which would otherwise duplicate the same 30-line dialog
 * + writeFile + error-handling block twice.
 */
export async function promptSaveAndWrite(
  rendered: ThreadExportResult,
  format: ThreadExportFormat,
  parent?: BrowserWindow | null
): Promise<SaveResult> {
  const ext = rendered.suggestedFilename.split('.').pop() ?? format
  const opts = {
    defaultPath: rendered.suggestedFilename,
    filters: [{ name: FORMAT_FILTER_NAME[format] ?? 'Document', extensions: [ext] }]
  }
  // Anchor to the supplied parent window so the dialog opens on the
  // right monitor. Fall back to the focused window, then any visible
  // one — the agent may have been triggered from a tray action with
  // nothing focused.
  const anchor =
    parent ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => w.isVisible() && !w.isDestroyed())
  const result = anchor
    ? await dialog.showSaveDialog(anchor, opts)
    : await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) {
    return { ok: false, message: 'Export cancelled.' }
  }
  try {
    await writeFile(result.filePath, rendered.bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Couldn't write file: ${msg}` }
  }
  return { ok: true, message: `Saved to ${result.filePath}`, path: result.filePath }
}
