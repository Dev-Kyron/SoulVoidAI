/**
 * Token-based search across the persistent chat history. Renders a slim
 * search bar with live results — click a result to scroll that message into
 * view (briefly highlighted by the parent ChatView).
 */
import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { WELCOME_MESSAGE_ID, type ChatMessage } from '@shared/types'

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Picks a ~120-char window around the earliest matched token. */
function buildSnippet(content: string, tokens: string[]): string {
  const lc = content.toLowerCase()
  let earliest = -1
  for (const t of tokens) {
    const idx = lc.indexOf(t)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx
  }
  if (earliest === -1) return content.slice(0, 140)
  const start = Math.max(0, earliest - 32)
  const end = Math.min(content.length, earliest + 110)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}

function matches(message: ChatMessage, tokens: string[]): boolean {
  if (message.id === WELCOME_MESSAGE_ID) return false
  if (!message.content) return false
  const haystack = message.content.toLowerCase()
  return tokens.every((t) => haystack.includes(t))
}

interface ChatSearchProps {
  onClose: () => void
  onJumpTo: (messageId: string) => void
}

export function ChatSearch({ onClose, onJumpTo }: ChatSearchProps): JSX.Element {
  const [query, setQuery] = useState('')
  const messages = useChatStore((s) => s.messages)

  const tokens = useMemo(() => tokenize(query), [query])

  const results = useMemo(() => {
    if (tokens.length === 0) return []
    return messages.filter((m) => matches(m, tokens))
  }, [messages, tokens])

  return (
    <div className="border-b border-white/5 bg-black/30">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Search size={13} className="shrink-0 text-slate-400" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'Enter' && results.length > 0) {
              e.preventDefault()
              onJumpTo(results[results.length - 1].id)
            }
          }}
          placeholder="Search this conversation…"
          className="flex-1 bg-transparent text-[12px] text-slate-100 outline-none placeholder:text-slate-500"
        />
        {tokens.length > 0 && (
          <span className="shrink-0 text-[10px] text-slate-500">
            {results.length} match{results.length === 1 ? '' : 'es'}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close search"
          className="shrink-0 text-slate-400 transition hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      {tokens.length > 0 && (
        <div className="scrollbar-void max-h-48 overflow-y-auto border-t border-white/5 p-1.5">
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-[10px] text-slate-500">No matches.</p>
          ) : (
            results
              .slice()
              .reverse()
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onJumpTo(m.id)}
                  className="flex w-full flex-col gap-0.5 rounded p-1.5 text-left transition hover:bg-white/5"
                >
                  <span className="text-[8px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    {m.role}
                    {m.createdAt &&
                      ` · ${new Date(m.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
                  </span>
                  <span className="text-[11px] leading-snug text-slate-300">
                    {buildSnippet(m.content, tokens)}
                  </span>
                </button>
              ))
          )}
        </div>
      )}
    </div>
  )
}
