/**
 * Cross-thread search overlay. Bound to Cmd/Ctrl+F at the app root — opens
 * a centred dialog that queries every thread in SQLite (via the existing
 * `vs.history.search` IPC) and lets the user jump straight to a match in
 * any thread.
 *
 * The per-thread search (`ChatSearch.tsx`) stays as-is for the in-chat
 * "find within this conversation" loop; this dialog is the broader "Cmd+F
 * across my entire history" surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useChatStore } from '../../store/useChatStore'
import { useWidgetStore } from '../../store/useWidgetStore'
import { useT } from '../../lib/i18n'
import { useDialog } from '../../lib/useDialog'
import type { MessageSearchHit } from '@shared/types'

/** Debounce — the SQLite query is cheap but no point firing on every keystroke. */
const SEARCH_DEBOUNCE_MS = 180

interface Props {
  open: boolean
  onClose: () => void
}

export function GlobalSearchDialog({ open, onClose }: Props): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const t = useT()
  const switchThread = useChatStore((s) => s.switchThread)

  // Shared dialog plumbing — Esc (with input-aware "clear first" behaviour),
  // focus trap, focus restore on close. We disable the auto-focus-first-
  // focusable because the search input has its own focus call below.
  useDialog(dialogRef, onClose, { autoFocus: false })

  // Reset on open/close — opening a stale search would mislead.
  useEffect(() => {
    if (open) {
      setQuery('')
      setHits([])
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Debounced search.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const result = await vs.history.search(trimmed)
        if (!cancelled) setHits(result)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  const handleJump = useCallback(
    async (hit: MessageSearchHit) => {
      onClose()
      await switchThread(hit.threadId)
      // Make sure the panel is expanded so the result is actually visible.
      const widget = useWidgetStore.getState()
      if (!widget.expanded) await widget.expand()
      widget.setTab('chat')
      // Scroll the matched message into view. The chat surface listens for
      // a `chat:jump-to` custom event already used by per-thread search.
      window.dispatchEvent(
        new CustomEvent('chat:jump-to', { detail: { messageId: hit.messageId } })
      )
    },
    [onClose, switchThread]
  )

  // Group hits by thread for the rendered list. Threads ordered by their
  // most-recent hit's createdAt so the most relevant conversation sits up top.
  const untitledFallback = t('chat.search_untitled')
  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; hits: MessageSearchHit[] }>()
    for (const hit of hits) {
      const entry = map.get(hit.threadId)
      if (entry) entry.hits.push(hit)
      else map.set(hit.threadId, { title: hit.threadTitle || untitledFallback, hits: [hit] })
    }
    return Array.from(map.entries()).map(([threadId, value]) => ({
      threadId,
      ...value
    }))
  }, [hits, untitledFallback])

  if (!open) return null

  return (
    // z-[70] sits above QuickAI (z-65) and the tour 'try' phase corner
    // card (z-55) — that's the only overlay state where the user can
    // actively trigger the dialog. The fully-modal tour setup at z-80
    // would cover it, but the search task only appears in the 'try'
    // phase so there's nothing to collide with there.
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.search_all')}
        className="glass-soft w-full max-w-[560px] overflow-hidden rounded-2xl border-[var(--border-strong)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <Search size={14} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat.search_all_placeholder')}
            className="flex-1 bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
          />
          {loading && <span className="text-[10px] text-slate-500">…</span>}
          {!loading && query.length > 0 && (
            <span className="text-[10px] text-slate-500">
              {t(
                hits.length === 1 ? 'chat.search_matches_one' : 'chat.search_matches_many',
                { count: hits.length }
              )}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
            className="rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X size={13} />
          </button>
        </div>
        <div className="scrollbar-void max-h-[55vh] min-h-[100px] overflow-y-auto">
          {query.trim().length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-slate-500">
              {t('chat.search_hint')}
            </div>
          ) : hits.length === 0 && !loading ? (
            <div className="px-4 py-6 text-center text-[11px] text-slate-500">
              {t('chat.search_no_results')}
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.threadId} className="border-b border-white/5 last:border-b-0">
                <div className="bg-black/20 px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {group.title} · {group.hits.length}
                </div>
                {group.hits.map((hit) => (
                  <button
                    key={hit.messageId}
                    type="button"
                    onClick={() => void handleJump(hit)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition hover:bg-white/5"
                  >
                    <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {hit.role}
                      {hit.createdAt &&
                        ` · ${new Date(hit.createdAt).toLocaleDateString([], {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric'
                        })}`}
                    </span>
                    <span className="text-[12px] leading-snug text-slate-200">
                      {hit.snippet}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
