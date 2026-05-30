/**
 * v2.0 — Composer side-panel. A Cursor-style markdown editing surface
 * that lives next to the chat: the user edits a document, the chat is
 * the diff conversation that produces it.
 *
 * Scope of this v2.0 cut:
 *   - Toggle via the chat header chip (or Esc to close).
 *   - Edit tab: plain markdown textarea with mono font, no syntax
 *     highlighting yet — the textarea is the simplest thing that
 *     ships predictable cursor behaviour. Code highlighting can come
 *     later via @codemirror or @monaco when we know what users want.
 *   - Preview tab: renders the same Markdown component the chat uses,
 *     so the user sees the EXACT output they'd get pasting their doc.
 *   - "Send to Composer" / "Append to Composer" actions on assistant
 *     bubbles (see MessageBubble.tsx) — those are the integration
 *     points to keep the chat-as-diff workflow flowing.
 *   - Save-to-file via the existing share IPC. No per-thread SQLite
 *     persistence yet — v2.1 follow-up.
 *
 * Deliberately renderer-only state (useComposerStore). Reloading the
 * panel resets the doc. Users who want durability use the save button.
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, Pencil, Save, Trash2, X } from 'lucide-react'
import { useComposerStore } from '../../store/useComposerStore'
import { useUiStore } from '../../store/useUiStore'
import { Markdown } from '../chat/Markdown'
import { vs } from '../../lib/bridge'
import { cn, relativeTime } from '../../lib/utils'

type Tab = 'edit' | 'preview'

export function ComposerPanel(): JSX.Element {
  // Open-state gating lives in the parent (ChatView) so AnimatePresence
  // can play the exit animation when this component unmounts. We no
  // longer return null here — by the time we render, the parent has
  // already decided we should be visible.
  const content = useComposerStore((s) => s.content)
  const updatedAt = useComposerStore((s) => s.updatedAt)
  const setContent = useComposerStore((s) => s.setContent)
  const setOpen = useComposerStore((s) => s.setOpen)
  const clear = useComposerStore((s) => s.clear)
  const pushToast = useUiStore((s) => s.pushToast)
  const [tab, setTab] = useState<Tab>('edit')
  // Two-stage clear confirm, same pattern as the Memory "Forget all"
  // — prevents single-misclick wipes of a long-form document.
  const [confirmClear, setConfirmClear] = useState(false)

  // Esc closes the panel. Mirrors `useDialog`'s convention: bail when
  // focus is on a text input WITH a value, so the user's first Esc
  // clears their input (native browser behaviour) rather than closing
  // the surface they're typing in. Without this, hitting Esc inside
  // the Composer's own textarea (with a draft typed) would dismiss
  // the panel and silently discard the draft — bad UX.
  //
  // Also bails when a higher-z overlay (Settings dialog, share dialog,
  // confirm prompt) has captured the keypress — `useDialog` calls
  // stopPropagation in its capture-phase handler so the bubble-phase
  // handler we register here never fires when a dialog is open AND
  // the active element is dialog-internal. The remaining bubble-phase
  // edge case (dialog focused on input with content → useDialog bails
  // silently) is what the input-value check below covers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const active = document.activeElement
      const isTextInput =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      if (isTextInput && active.value) return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const charCount = content.length
  const lineCount = content.split('\n').length

  const handleSave = async (): Promise<void> => {
    const result = await vs.share.saveFile('composer', content || '<!-- empty composer -->', 'md')
    if (result.cancelled) return
    if (!result.ok) {
      pushToast('error', `Save failed: ${result.error ?? 'unknown error'}`)
      return
    }
    pushToast('success', `Saved to ${result.path}.`)
  }

  return (
    <motion.aside
      // Sits above the chat as a right-side overlay rather than
      // displacing the message log — the user keeps full chat context
      // visible while the doc surface slides in. ~60% of the panel
      // width is enough to read prose comfortably without crowding
      // the chat's reading column.
      className="absolute inset-y-0 right-0 z-30 flex w-[60%] min-w-[280px] flex-col border-l border-white/10 bg-void-800/95 backdrop-blur"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 360, damping: 32 }}
    >
      <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-200">Composer</span>
        {updatedAt && (
          <span className="text-[9px] text-slate-500">edited {relativeTime(updatedAt)}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <TabButton
            current={tab}
            value="edit"
            onClick={setTab}
            icon={<Pencil size={11} />}
            label="Edit"
          />
          <TabButton
            current={tab}
            value="preview"
            onClick={setTab}
            icon={<Eye size={11} />}
            label="Preview"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!content.trim()}
            title="Save document to .md file"
            className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white disabled:opacity-30"
          >
            <Save size={11} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true)
                window.setTimeout(() => setConfirmClear(false), 4000)
                return
              }
              setConfirmClear(false)
              clear()
            }}
            disabled={!content.trim()}
            title={
              confirmClear
                ? 'Tap again within 4s to confirm — clears the document.'
                : 'Clear document'
            }
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md transition',
              confirmClear
                ? 'bg-rose-500/20 text-rose-300'
                : 'text-slate-400 hover:bg-white/5 hover:text-rose-400',
              !content.trim() && 'opacity-30 hover:bg-transparent hover:text-slate-400'
            )}
          >
            <Trash2 size={11} />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
            className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'edit' ? (
          // Plain textarea: predictable cursor + native paste + native
          // undo/redo. A richer editor (CodeMirror / Monaco) lands in
          // v2.1 once we see what users want.
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write or paste markdown here, or hit ‘Send to Composer’ on any assistant reply."
            className="scrollbar-void h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-200 outline-none placeholder:text-slate-600"
            spellCheck
            /* Intentionally no autoFocus: the textarea unmounts/remounts
               on Edit↔Preview tab toggle, so autoFocus would steal focus
               every flip — including from the chat composer if the user
               is mid-typing. User clicks in to start editing. */
          />
        ) : (
          <div className="scrollbar-void markdown selectable h-full overflow-y-auto px-3 py-2">
            {content.trim() ? (
              <Markdown>{content}</Markdown>
            ) : (
              <p className="text-[11px] italic text-slate-500">
                Nothing to preview yet. Switch to Edit, or send an assistant reply over from the
                chat.
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-white/5 px-3 py-1.5 text-[9px] text-slate-500">
        <span>
          {lineCount} line{lineCount === 1 ? '' : 's'} · {charCount.toLocaleString()} char
          {charCount === 1 ? '' : 's'}
        </span>
        {/* v2.0 — explicitly call out the shared-across-threads
            behaviour. Per-thread SQLite persistence is a v2.1 task;
            users need to know that switching threads keeps the same
            document so a "Send to Composer" from Thread B isn't a
            surprise replacement of a Thread A draft. */}
        <span
          className="text-slate-600"
          title="The Composer document is shared across all chat threads in this session and lives in memory only. Save to a .md file to keep it across restarts."
        >
          shared across threads · save to keep
        </span>
      </footer>
    </motion.aside>
  )
}

function TabButton({
  current,
  value,
  onClick,
  icon,
  label
}: {
  current: Tab
  value: Tab
  onClick: (next: Tab) => void
  icon: JSX.Element
  label: string
}): JSX.Element {
  const active = current === value
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
