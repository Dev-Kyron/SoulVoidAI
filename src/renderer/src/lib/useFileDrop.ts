/**
 * Drag-and-drop file attachment plumbing. Pairs with `addImageAttachment` /
 * `addTextAttachment` on `useChatStore` so any drop target — composer, chat
 * surface, collapsed orb — can accept files with the same semantics.
 *
 * Images become inline-rendered attachments (rendered in the chat bubble and
 * shipped to vision-capable models as `data:image/...` URLs). Everything
 * else readable becomes a text attachment whose body is inlined as
 * `--- name.ext ---\n<content>` into the next message.
 *
 * Returns `{ onDragOver, onDragLeave, onDrop, isDragging }`. Spread the
 * three handlers onto your drop zone; render a highlight when `isDragging`.
 */
import { useState, useCallback } from 'react'
import type { DragEvent } from 'react'
import { useChatStore } from '../store/useChatStore'
import { useUiStore } from '../store/useUiStore'
import { vs } from './bridge'

/** Same extension table the file-picker uses — kept narrow to avoid surprises. */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.log',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.kt',
  '.kts',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.sql',
  '.graphql',
  '.proto',
  '.dockerfile',
  '.env.example',
  '.gitignore',
  '.editorconfig'
])

/** Hard cap on a single dropped text file — same as the IPC pick path. */
const MAX_TEXT_BYTES = 200_000
/** PDFs over this size skip the inline preview — same threshold as the IPC pick path. */
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

export interface FileDropHandlers {
  isDragging: boolean
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}

export function useFileDrop(): FileDropHandlers {
  const [isDragging, setDragging] = useState(false)
  const addImage = useChatStore((s) => s.addImageAttachment)
  const addText = useChatStore((s) => s.addTextAttachment)
  const addPdf = useChatStore((s) => s.addPdfAttachment)
  const pushToast = useUiStore((s) => s.pushToast)

  const onDragOver = useCallback(
    (event: DragEvent): void => {
      // Only react when actual files are being dragged — skip page-internal
      // drags (text selection drag, motion-component reorders, etc.).
      const hasFiles =
        event.dataTransfer?.types?.includes('Files') ||
        Array.from(event.dataTransfer?.items ?? []).some((i) => i.kind === 'file')
      if (!hasFiles) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (!isDragging) setDragging(true)
    },
    [isDragging]
  )

  const onDragLeave = useCallback((event: DragEvent): void => {
    // Only clear when the drag actually exits the drop zone (the related
    // target is null OR outside the current bounds). Without this, hovering
    // over a child element would fire dragleave on the parent and flicker.
    if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node) {
      if ((event.currentTarget as Node).contains(event.relatedTarget as Node)) return
    }
    setDragging(false)
  }, [])

  const onDrop = useCallback(
    (event: DragEvent): void => {
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      void Promise.all(
        files.map(async (file) => {
          try {
            // MIME-based image detection covers all the common formats and
            // doesn't depend on extension casing. Anything else gets the
            // text-extension allowlist below.
            if (file.type.startsWith('image/')) {
              const dataUrl = await readAsDataUrl(file)
              addImage(file.name, dataUrl)
              return
            }
            const ext = lowerExt(file.name)
            // PDF — round-trip the bytes to main for text extraction so the
            // model sees readable content, while keeping the data URL for the
            // renderer's inline viewer. Same dual-payload shape as the
            // picker's pdf branch.
            if (ext === '.pdf' || file.type === 'application/pdf') {
              // Beyond the preview budget, skip the dataUrl read entirely —
              // saves the FileReader pass and the renderer-side base64 blob.
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
            pushToast('info', `${file.name} — unsupported file type, skipped.`)
          } catch (err) {
            pushToast(
              'error',
              `Couldn't read ${file.name}: ${err instanceof Error ? err.message : 'unknown'}`
            )
          }
        })
      )
    },
    [addImage, addText, addPdf, pushToast]
  )

  return { isDragging, onDragOver, onDragLeave, onDrop }
}
