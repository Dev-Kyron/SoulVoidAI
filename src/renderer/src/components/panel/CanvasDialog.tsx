/**
 * Code-canvas dialog. Opens any long code block in a roomier modal with
 * syntax-coloured monospace, copy + save buttons, and — for HTML / SVG —
 * a live preview tab rendered in a sandboxed iframe.
 *
 * Triggered from the "Expand" affordance on a Markdown code block, or
 * programmatically via useUiStore.setCanvas({ code, language }).
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Copy, Check, Save, Eye, Code } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useChatStore } from '../../store/useChatStore'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { useDialog } from '../../lib/useDialog'

const PREVIEWABLE = new Set(['html', 'svg', 'xml'])

const EXTENSION_FOR_LANGUAGE: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  rust: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  cs: 'cs',
  ruby: 'rb',
  shell: 'sh',
  bash: 'sh',
  yaml: 'yml',
  json: 'json',
  toml: 'toml',
  html: 'html',
  svg: 'svg',
  xml: 'xml',
  css: 'css',
  markdown: 'md',
  md: 'md',
  sql: 'sql'
}

function fileExtension(language: string): string {
  return EXTENSION_FOR_LANGUAGE[language.toLowerCase()] ?? 'txt'
}

export function CanvasDialog(): JSX.Element {
  const content = useUiStore((s) => s.canvasContent)
  const setCanvas = useUiStore((s) => s.setCanvas)
  const pushToast = useUiStore((s) => s.pushToast)
  // Streaming awareness — when the canvas closes during a live stream we
  // need to suppress further artifact pushes for THIS turn. Without this,
  // dismissing mid-stream would have the dialog flicker back open on the
  // next delta.
  const streaming = useChatStore((s) => s.streaming)
  const dismissStreamArtifact = useChatStore((s) => s.dismissStreamArtifact)
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<'code' | 'preview'>('code')
  const dialogRef = useRef<HTMLDivElement>(null)

  const close = (): void => {
    if (streaming) {
      dismissStreamArtifact()
    } else {
      setCanvas(null)
    }
  }
  useDialog(dialogRef, close)

  // Re-seed copied/tab only when the LANGUAGE changes — streaming updates
  // bump `content.code` on every delta, but we don't want to reset the
  // copied flag or jump back to the preview tab mid-stream.
  useEffect(() => {
    if (content) {
      setCopied(false)
      setTab(PREVIEWABLE.has(content.language.toLowerCase()) ? 'preview' : 'code')
    }
  }, [content?.language])

  if (!content) return <AnimatePresence />

  const language = content.language || 'code'
  const previewable = PREVIEWABLE.has(language.toLowerCase())
  const lineCount = content.code.split('\n').length
  const charCount = content.code.length

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      pushToast('error', 'Clipboard access denied.')
    }
  }

  const save = async (): Promise<void> => {
    const ext = fileExtension(language)
    const title = `canvas.${ext}`
    const result = await vs.share.saveFile(title, content.code)
    if (result.cancelled) return
    if (!result.ok) {
      pushToast('error', `Save failed: ${result.error ?? 'unknown error'}`)
      return
    }
    pushToast('success', `Saved to ${result.path}`)
  }

  return (
    <AnimatePresence>
      {content && (
        <motion.div
          className="absolute inset-0 z-[59] flex items-center justify-center bg-black/75 p-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Code canvas"
            className="glass flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
              <Code size={13} className="text-[var(--accent)]" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                {language}
              </span>
              <span className="text-[10px] text-slate-500">
                {lineCount} line{lineCount === 1 ? '' : 's'} · {charCount.toLocaleString()} chars
              </span>
              <div className="ml-auto flex items-center gap-1">
                {previewable && (
                  <div className="flex rounded-md border border-white/10 p-0.5">
                    <button
                      type="button"
                      onClick={() => setTab('code')}
                      className={cn(
                        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition',
                        tab === 'code'
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-slate-400 hover:text-white'
                      )}
                    >
                      <Code size={10} />
                      Code
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab('preview')}
                      className={cn(
                        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition',
                        tab === 'preview'
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-slate-400 hover:text-white'
                      )}
                    >
                      <Eye size={10} />
                      Preview
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void copy()}
                  title="Copy"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
                >
                  {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  title="Save to file…"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
                >
                  <Save size={12} />
                </button>
                <button
                  type="button"
                  onClick={close}
                  title="Close"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 bg-black/40">
              {tab === 'preview' && previewable ? (
                <iframe
                  title="Canvas preview"
                  sandbox="allow-scripts"
                  srcDoc={content.code}
                  className="h-full w-full border-0 bg-white"
                />
              ) : (
                <pre className="scrollbar-void m-0 h-full overflow-auto p-4">
                  <code className="block whitespace-pre font-mono text-[12.5px] leading-relaxed text-slate-200">
                    {content.code}
                  </code>
                </pre>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
