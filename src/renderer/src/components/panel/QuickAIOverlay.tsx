/**
 * Quick AI — spotlight-style overlay summoned via the global hotkey
 * (Ctrl/Cmd+Shift+J). One-shot Q&A with no thread save, no agent loop, no
 * tools. Built to feel exactly like Raycast's Quick AI: type → answer → Esc.
 *
 * Two flows in one surface:
 *  1. **Free typing** — user asks a question, gets a streamed answer.
 *  2. **AI Commands** — when the clipboard has selected text, a row of
 *     preset prompts ("Explain", "Improve", "Summarise", "Translate") sits
 *     under the input. Clicking one wraps the clipboard text with the
 *     preset template and runs it. No need to leave the keyboard.
 *
 * Why an overlay rather than a separate window?
 *  - Reuses the existing renderer's chat IPC + config + provider state
 *    (no second app boot).
 *  - Tray-resident already — opening the panel is cheap, the overlay just
 *    floats on top of whatever tab the user was on.
 *  - Single source of truth for active provider / model / system prompt.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, Send, X, Loader2, Wand2, Copy, Check } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useConfigStore } from '../../store/useConfigStore'
import { vs } from '../../lib/bridge'
import { useDialog } from '../../lib/useDialog'
import { uid } from '../../lib/utils'
import type { ChatStreamChunk } from '@shared/types'

interface QuickAICommand {
  id: string
  label: string
  /**
   * Template applied to the clipboard text. `{TEXT}` is replaced with the
   * user's clipboard contents. Kept simple — no Mustache, just one token.
   */
  template: string
}

const COMMANDS: QuickAICommand[] = [
  {
    id: 'explain',
    label: 'Explain',
    template:
      'Explain the following clearly and concisely. If it is code, describe what it does and any non-obvious behaviour:\n\n{TEXT}'
  },
  {
    id: 'improve',
    label: 'Improve writing',
    template:
      'Rewrite the following to be clearer and more polished while preserving the meaning and tone:\n\n{TEXT}'
  },
  {
    id: 'summarise',
    label: 'Summarise',
    template: 'Summarise the following in 2-4 bullet points:\n\n{TEXT}'
  },
  {
    id: 'translate',
    label: 'Translate to English',
    template: 'Translate the following to English. If it is already English, paraphrase it:\n\n{TEXT}'
  },
  {
    id: 'fix',
    label: 'Fix grammar',
    template:
      'Fix grammar, spelling, and punctuation in the following. Return only the corrected text:\n\n{TEXT}'
  }
]

const MAX_CLIPBOARD_PREVIEW = 200

export function QuickAIOverlay(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState('')
  const [copied, setCopied] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const requestIdRef = useRef<string | null>(null)

  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)

  // Wire the global hotkey: subscribe once, open on every fire.
  useEffect(() => {
    return vs.events.onQuickAiOpen(() => setOpen(true))
  }, [])

  // Read clipboard when the overlay opens — surfaces "use as context" UI
  // if there's something there. Only opt-in: we don't pre-fill the input.
  useEffect(() => {
    if (!open) return
    void navigator.clipboard
      .readText()
      .then((text) => {
        const trimmed = (text ?? '').trim()
        if (trimmed) setClipboard(trimmed)
      })
      .catch(() => {
        // Clipboard read denied — fine, commands just become unavailable.
      })
  }, [open])

  // Subscribe to streaming chunks for THIS overlay's request only. The chat
  // store has its own onChunk handler for thread streams; we use a separate
  // route that filters by requestId so we don't pollute or get polluted.
  useEffect(() => {
    return vs.events.onChunk((chunk: ChatStreamChunk) => {
      if (chunk.requestId !== requestIdRef.current) return
      setAnswer((prev) => prev + chunk.delta)
    })
  }, [])

  const close = (): void => {
    if (streaming && requestIdRef.current) {
      void vs.ai.abort(requestIdRef.current)
    }
    setOpen(false)
    // Reset on close so the next summon is clean.
    setPrompt('')
    setAnswer('')
    setError(null)
    setClipboard('')
    setStreaming(false)
    requestIdRef.current = null
  }

  useDialog(dialogRef, close, { autoFocus: false })

  // Focus the textarea on open — the autoFocus opt-out above prevents the
  // dialog helper from stealing focus to the wrong element.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const submit = async (overridePrompt?: string): Promise<void> => {
    const finalPrompt = (overridePrompt ?? prompt).trim()
    if (!finalPrompt || streaming || !config) return
    const provider = config.providers.find((p) => p.id === config.activeProvider)
    if (!provider) {
      setError('No AI provider configured. Open Settings to pick one.')
      return
    }
    if (provider.needsKey && !provider.hasKey) {
      setError(`${provider.label} needs an API key — add one in Settings.`)
      return
    }

    setError(null)
    setAnswer('')
    setStreaming(true)
    const requestId = uid()
    requestIdRef.current = requestId

    try {
      const outcome = await vs.ai.chat({
        requestId,
        provider: provider.id,
        model: provider.model,
        // Single, intentionally tight system prompt — Quick AI is one-shot,
        // not a full agent loop, and certainly not the user's long-running
        // chat assistant. Keep replies short and useful.
        system:
          'You are VoidSoul Quick AI. Answer the question directly and concisely. ' +
          'Use Markdown for formatting. No greeting, no sign-off.',
        messages: [{ role: 'user', content: finalPrompt }],
        temperature: 0.4
      })
      if (outcome.error && outcome.error !== 'aborted') {
        setError(outcome.error)
      }
    } catch (err) {
      // Network drop, IPC crash, malformed response — without this guard the
      // streaming flag stuck on `true` forever and the overlay looked frozen.
      setError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setStreaming(false)
      requestIdRef.current = null
    }
  }

  const runCommand = (cmd: QuickAICommand): void => {
    if (!clipboard) {
      pushToast('info', 'Copy some text first, then re-open Quick AI.')
      return
    }
    const filled = cmd.template.replace('{TEXT}', clipboard)
    // Surface the assembled prompt in the input so the user can tweak before
    // re-running. Then auto-submit on first click — power-users get speed,
    // first-timers see what happened.
    setPrompt(filled)
    void submit(filled)
  }

  const copyAnswer = async (): Promise<void> => {
    if (!answer) return
    try {
      await navigator.clipboard.writeText(answer)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      pushToast('error', "Couldn't copy to clipboard.")
    }
  }

  const clipboardPreview = useMemo(() => {
    if (!clipboard) return ''
    return clipboard.length > MAX_CLIPBOARD_PREVIEW
      ? `${clipboard.slice(0, MAX_CLIPBOARD_PREVIEW)}…`
      : clipboard
  }, [clipboard])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[65] flex items-start justify-center bg-black/70 pt-16"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Quick AI"
            className="glass mx-3 flex w-full max-w-[440px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.96, y: -8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Input row */}
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
              <Sparkles size={14} className="shrink-0 text-[var(--accent)]" />
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                placeholder="Ask anything — Enter to send"
                rows={1}
                spellCheck
                autoCorrect="on"
                className="scrollbar-void max-h-24 flex-1 resize-none bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
                aria-label="Quick AI prompt"
              />
              {streaming ? (
                <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" />
              ) : (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!prompt.trim()}
                  className="shrink-0 rounded-md p-1 text-[var(--accent)] transition hover:bg-white/10 disabled:opacity-40"
                  title="Send (Enter)"
                  aria-label="Send"
                >
                  <Send size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={close}
                className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-white/10 hover:text-slate-200"
                title="Close (Esc)"
                aria-label="Close Quick AI"
              >
                <X size={13} />
              </button>
            </div>

            {/* AI Commands — only when clipboard has text AND we're not
                already showing an answer (the result is the more important
                surface once it's there). */}
            {clipboard && !answer && !streaming && (
              <div className="border-b border-white/5 bg-black/20 px-3 py-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                  <Wand2 size={10} />
                  <span>Apply to clipboard:</span>
                  <span
                    className="ml-auto truncate text-slate-500"
                    title={clipboard}
                    style={{ maxWidth: '180px' }}
                  >
                    "{clipboardPreview}"
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {COMMANDS.map((cmd) => (
                    <button
                      key={cmd.id}
                      type="button"
                      onClick={() => runCommand(cmd)}
                      className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-200 transition hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)]"
                    >
                      {cmd.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Answer surface */}
            {(answer || streaming || error) && (
              <div className="flex max-h-[300px] flex-col gap-2 overflow-y-auto px-3 py-3">
                {error ? (
                  <p className="text-[11px] text-rose-300">⚠️ {error}</p>
                ) : (
                  <>
                    <pre className="scrollbar-void whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-slate-100">
                      {answer}
                      {streaming && (
                        <span className="inline-block h-3 w-1.5 animate-pulse bg-[var(--accent)] align-middle" />
                      )}
                    </pre>
                    {answer && !streaming && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void copyAnswer()}
                          className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/10"
                        >
                          {copied ? <Check size={10} /> : <Copy size={10} />}
                          {copied ? 'Copied' : 'Copy answer'}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Empty-state hint */}
            {!answer && !streaming && !error && !clipboard && (
              <div className="px-3 py-3 text-[11px] leading-relaxed text-slate-500">
                One-shot answers. Type a question and hit Enter. To run a preset
                command on selected text, copy it first then re-open Quick AI.
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
