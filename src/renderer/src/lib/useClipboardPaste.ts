/**
 * Clipboard paste handler for the chat composers. Mirrors `useFileDrop`
 * semantics but reads from `event.clipboardData` instead of the drag
 * payload — so a Snipping Tool screenshot or a "copy image" from a browser
 * lands as an attachment exactly like a dragged file would.
 *
 * Behaviour:
 *  · Image clipboard items → added via `addImageAttachment`, event is
 *    `preventDefault`ed so the binary doesn't fall through and paste as
 *    a garbage data: URL into the textarea.
 *  · File clipboard items (uncommon but valid — e.g. PDFs from some
 *    apps) → routed through the same MIME / extension allowlist as drop,
 *    with a 200 KB cap for text and 8 MB cap for inline PDF previews.
 *  · Anything else (the common case: plain text) → falls through to the
 *    browser default, so Ctrl+V still pastes text the way it always did.
 *
 * Returns an `onPaste` handler ready to spread onto an <input> or
 * <textarea>. Both ChatComposer and NexusComposer use it so the paste
 * UX is identical whether you're in the full chat tab or the Nexus
 * quick-message slot.
 */
import { useCallback } from 'react'
import type { ClipboardEvent } from 'react'
import { useChatStore } from '../store/useChatStore'
import { useUiStore } from '../store/useUiStore'
import { vs } from './bridge'

/** Same extension table as useFileDrop — kept narrow to avoid surprises. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.csv', '.log', '.xml',
  '.html', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.bash',
  '.zsh', '.ps1', '.bat', '.sql', '.graphql', '.proto', '.dockerfile', '.env.example',
  '.gitignore', '.editorconfig'
])

const MAX_TEXT_BYTES = 200_000
const PDF_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

function lowerExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (): void => resolve(reader.result as string)
    reader.onerror = (): void => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (): void => resolve(reader.result as string)
    reader.onerror = (): void => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsText(file)
  })
}

/** Make up a sensible filename for a clipboard image (no original name). */
function clipboardImageName(mime: string): string {
  const ext = mime.split('/')[1]?.split(';')[0] || 'png'
  // ISO timestamp without the millisecond + zone tail keeps it filesystem-safe.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `pasted-${stamp}.${ext}`
}

export function useClipboardPaste(): (event: ClipboardEvent) => void {
  const addImage = useChatStore((s) => s.addImageAttachment)
  const addText = useChatStore((s) => s.addTextAttachment)
  const addPdf = useChatStore((s) => s.addPdfAttachment)
  const pushToast = useUiStore((s) => s.pushToast)

  return useCallback(
    (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items
      if (!items || items.length === 0) return

      const fileItems: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) fileItems.push(file)
      }
      if (fileItems.length === 0) return

      // Now we know there's at least one file — block default paste so the
      // browser doesn't dump a `[object File]` placeholder or a base64 URL
      // into the textarea.
      event.preventDefault()

      void Promise.all(
        fileItems.map(async (file) => {
          try {
            if (file.type.startsWith('image/')) {
              const dataUrl = await readAsDataUrl(file)
              // Browsers often hand back a blank `name` for clipboard images
              // ("image.png" at best). Generate a timestamp-prefixed name so
              // multiple pastes in one session stay distinguishable.
              const name = file.name && file.name !== 'image.png'
                ? file.name
                : clipboardImageName(file.type)
              addImage(name, dataUrl)
              pushToast('success', `Attached ${name}`)
              return
            }
            const ext = lowerExt(file.name || '')
            if (ext === '.pdf' || file.type === 'application/pdf') {
              const previewable = file.size <= PDF_PREVIEW_MAX_BYTES
              const [dataUrl, bytes] = await Promise.all([
                previewable ? readAsDataUrl(file) : Promise.resolve(''),
                file.arrayBuffer()
              ])
              const text = await vs.system.parsePdf({ bytes, name: file.name })
              addPdf(file.name, text, dataUrl)
              return
            }
            if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')) {
              if (file.size > MAX_TEXT_BYTES) {
                pushToast(
                  'info',
                  `${file.name} is too large to attach as text (${Math.round(
                    file.size / 1024
                  )} KB > 200 KB).`
                )
                return
              }
              const text = await readAsText(file)
              addText(file.name, text)
              return
            }
            pushToast('info', `${file.name || 'clipboard item'} — unsupported file type, skipped.`)
          } catch (err) {
            pushToast(
              'error',
              `Couldn't read ${file.name || 'clipboard item'}: ${
                err instanceof Error ? err.message : 'unknown'
              }`
            )
          }
        })
      )
    },
    [addImage, addText, addPdf, pushToast]
  )
}
