/**
 * Share-conversation dialog. Three outbound paths from one button, in any of
 * four formats:
 *
 *  - Copy to the clipboard (zero setup)
 *  - Save to file (OS save dialog)
 *  - Upload as GitHub Gist — public or secret, returns a shareable URL
 *
 * Formats: Markdown (default), Obsidian (Markdown + YAML frontmatter),
 * JSON (lossless archive shape), OPML (mind-mapper outline).
 *
 * The Gist option requires a GitHub PAT (with `gist` scope) stored once via
 * Settings → Integrations. Without one, the Gist button explains why and
 * links to where to add one.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Share2,
  X,
  Copy,
  Save,
  Github,
  Globe,
  Lock,
  ExternalLink,
  Check
} from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { copyToClipboard } from '../../lib/clipboard'
import {
  EXTENSION_FOR_FORMAT,
  renderThread,
  type ExportFormat
} from '../../lib/exportChat'
import { cn } from '../../lib/utils'
import { useDialog } from '../../lib/useDialog'
import type { ChatMessage } from '@shared/types'

const FORMAT_OPTIONS: Array<{ id: ExportFormat; label: string; blurb: string }> = [
  { id: 'markdown', label: 'Markdown', blurb: 'Plain .md — GitHub, README, anywhere.' },
  {
    id: 'obsidian',
    label: 'Obsidian',
    blurb: 'Markdown with YAML frontmatter — drops into an Obsidian vault.'
  },
  { id: 'json', label: 'JSON', blurb: 'Lossless archive — every field, every tool call.' },
  { id: 'opml', label: 'OPML', blurb: 'Outline XML — mind-mappers, Workflowy, The Brain.' }
]

interface ShareDialogProps {
  /** Composite of the active thread's title + live in-memory messages. Kept
   * shallow so the dialog doesn't pin a full ChatThread reference. */
  thread: { title: string; messages: ChatMessage[] } | null
  open: boolean
  onClose: () => void
}

export function ShareDialog({ thread, open, onClose }: ShareDialogProps): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)
  const [hasGithub, setHasGithub] = useState(false)
  const [busy, setBusy] = useState<null | 'copy' | 'file' | 'gist'>(null)
  const [isPublic, setIsPublic] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [gistUrl, setGistUrl] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setGistUrl(null)
      void vs.secrets.has('github').then(setHasGithub)
    }
  }, [open])

  const formatLabel =
    FORMAT_OPTIONS.find((opt) => opt.id === format)?.label ?? 'Markdown'
  const extension = EXTENSION_FOR_FORMAT[format]
  // Re-render the content only when the thread or chosen format changes; the
  // four exporters are pure functions over `thread`.
  const content = useMemo(
    () => (thread ? renderThread(thread, format) : ''),
    [thread, format]
  )
  const title = thread?.title || 'Conversation'
  const empty = !thread || thread.messages.length === 0

  const copyAndClose = async (): Promise<void> => {
    if (empty || busy) return
    setBusy('copy')
    const ok = await copyToClipboard(content)
    setBusy(null)
    if (!ok) {
      pushToast('error', 'Clipboard access denied.')
      return
    }
    pushToast('success', `${formatLabel} copied to clipboard.`)
    onClose()
  }

  const saveToFile = async (): Promise<void> => {
    if (empty || busy) return
    setBusy('file')
    const result = await vs.share.saveFile(title, content, extension)
    setBusy(null)
    if (result.cancelled) return
    if (!result.ok) {
      pushToast('error', `Save failed: ${result.error ?? 'unknown error'}`)
      return
    }
    pushToast('success', `Saved to ${result.path}`)
    onClose()
  }

  const shareAsGist = async (): Promise<void> => {
    if (empty || busy) return
    if (!hasGithub) {
      pushToast(
        'info',
        'Add a GitHub PAT in Settings → Integrations (with `gist` scope) first.'
      )
      return
    }
    setBusy('gist')
    const result = await vs.share.gist(title, content, isPublic, extension)
    setBusy(null)
    if (!result.ok || !result.url) {
      pushToast('error', result.error ?? 'Gist upload failed.')
      return
    }
    setGistUrl(result.url)
    // Best-effort — toast still surfaces the URL even if the clipboard
    // write was rejected (very unlikely via the IPC path, but defensive).
    await copyToClipboard(result.url)
    pushToast(
      'success',
      `${isPublic ? 'Public' : 'Secret'} gist created · URL on your clipboard.`
    )
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[57] flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Share conversation"
            className="glass w-full max-w-[360px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Share2 size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                Share conversation
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-2 p-4">
              {empty ? (
                <p className="text-[11px] text-slate-500">
                  Nothing to share yet — send a message first.
                </p>
              ) : (
                <>
                  <FormatPicker selected={format} onSelect={setFormat} />
                  <ShareAction
                    icon={<Copy size={13} />}
                    label={`Copy as ${formatLabel}`}
                    hint="Straight to the clipboard."
                    onClick={() => void copyAndClose()}
                    busy={busy === 'copy'}
                  />
                  <ShareAction
                    icon={<Save size={13} />}
                    label="Save to file…"
                    hint={`.${extension} document via the OS save dialog.`}
                    onClick={() => void saveToFile()}
                    busy={busy === 'file'}
                  />

                  <div className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Github
                        size={13}
                        className={hasGithub ? 'text-[var(--accent)]' : 'text-slate-500'}
                      />
                      <span className="flex-1 text-[11px] font-semibold text-white">
                        Share as Gist
                      </span>
                      {!hasGithub && (
                        <span className="text-[9px] text-amber-400">needs GitHub PAT</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      Uploads the {formatLabel.toLowerCase()} to gist.github.com and returns
                      a real URL you can paste anywhere.
                    </p>

                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIsPublic(false)}
                        className={cn(
                          'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition',
                          !isPublic
                            ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-white/10 text-slate-400 hover:bg-white/5'
                        )}
                      >
                        <Lock size={11} />
                        Secret
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsPublic(true)}
                        className={cn(
                          'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition',
                          isPublic
                            ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-white/10 text-slate-400 hover:bg-white/5'
                        )}
                      >
                        <Globe size={11} />
                        Public
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void shareAsGist()}
                      disabled={busy === 'gist'}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] py-1.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                    >
                      {busy === 'gist' ? (
                        'Uploading…'
                      ) : (
                        <>
                          <Github size={11} />
                          Upload as {isPublic ? 'public' : 'secret'} gist
                        </>
                      )}
                    </button>

                    {gistUrl && (
                      <div className="mt-2 flex items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-1.5">
                        <Check size={11} className="shrink-0 text-emerald-400" />
                        <a
                          href={gistUrl}
                          onClick={(e) => {
                            e.preventDefault()
                            void vs.automation.execute({
                              type: 'open-url',
                              params: { url: gistUrl }
                            })
                          }}
                          className="min-w-0 flex-1 truncate text-[10px] text-emerald-200 transition hover:underline"
                          title={gistUrl}
                        >
                          {gistUrl}
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            void copyToClipboard(gistUrl).then((ok) => {
                              pushToast(
                                ok ? 'success' : 'error',
                                ok ? 'Link copied to clipboard.' : 'Could not copy link.'
                              )
                            })
                          }}
                          title="Copy link"
                          aria-label="Copy share link"
                          className="shrink-0 rounded p-0.5 text-emerald-300 transition hover:bg-emerald-500/20 hover:text-emerald-100"
                        >
                          <Copy size={10} />
                        </button>
                        <ExternalLink size={10} className="shrink-0 text-emerald-300" />
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function FormatPicker({
  selected,
  onSelect
}: {
  selected: ExportFormat
  onSelect: (format: ExportFormat) => void
}): JSX.Element {
  const blurb = FORMAT_OPTIONS.find((opt) => opt.id === selected)?.blurb ?? ''
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
      <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        Format
      </p>
      <div className="flex flex-wrap gap-1">
        {FORMAT_OPTIONS.map((option) => {
          const active = option.id === selected
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[10px] font-medium transition',
                active
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{blurb}</p>
    </div>
  )
}

function ShareAction({
  icon,
  label,
  hint,
  onClick,
  busy
}: {
  icon: JSX.Element
  label: string
  hint: string
  onClick: () => void
  busy: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-start gap-2.5 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-left transition hover:border-white/25 hover:bg-black/30 disabled:opacity-50"
    >
      <span className="mt-0.5 shrink-0 text-[var(--accent)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-white">{label}</span>
        <span className="block text-[10px] text-slate-500">{hint}</span>
      </span>
      {busy && <span className="text-[10px] text-slate-400">…</span>}
    </button>
  )
}
