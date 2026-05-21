/**
 * The Chat view — a focused conversation surface reached from the Nexus HUD.
 * The header carries the back link, threads sidebar trigger, search, and the
 * Agent / Private toggles. Each chat lives in its own named thread.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  ChevronLeft,
  Bot,
  Shield,
  Search,
  ScrollText,
  ChevronDown,
  ChevronUp,
  Trash2,
  PanelLeft,
  Share2
} from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import { ChatComposer } from './ChatComposer'
import { ChatSearch } from './ChatSearch'
import { ThreadsDrawer } from './ThreadsDrawer'
import { ShareDialog } from './ShareDialog'
import { ThreadOverridesDialog } from './ThreadOverridesDialog'
import { MODES } from '@shared/modes'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { useWidgetStore } from '../../store/useWidgetStore'
import { useConfigStore } from '../../store/useConfigStore'
import { Toggle } from '../common/ui'
import { cn } from '../../lib/utils'
import { CHAT_STRINGS } from '../../lib/chatStrings'

/** Shows the cached "story so far" recap when a long chat is being summarised. */
function SummaryBanner(): JSX.Element | null {
  const summary = useChatStore((s) => s.summary)
  const messages = useChatStore((s) => s.messages)
  const clearSummary = useChatStore((s) => s.clearSummary)
  const [expanded, setExpanded] = useState(false)
  if (!summary) return null

  // Count is derived live from the boundary id rather than stored on the
  // summary — the stored copy would go stale every time the summary was
  // reused across new turns. The summary covers everything up to AND
  // INCLUDING the boundary message, so the count is `boundaryIdx + 1`.
  const boundaryIdx = summary.coversUpToId
    ? messages.findIndex((m) => m.id === summary.coversUpToId)
    : -1
  const liveCount = boundaryIdx >= 0 ? boundaryIdx + 1 : 0

  return (
    <div className="mx-3 mt-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[10px]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ScrollText size={11} className="shrink-0 text-[var(--accent)]" />
        <span className="font-semibold text-slate-300">Earlier conversation summarised</span>
        <span className="truncate text-slate-500">
          covers {liveCount} earlier message{liveCount === 1 ? '' : 's'}
        </span>
        <span className="ml-auto shrink-0 text-slate-500">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
          <p className="whitespace-pre-wrap leading-relaxed text-slate-300">{summary.text}</p>
          <button
            type="button"
            onClick={() => void clearSummary()}
            className="flex items-center gap-1 text-rose-400 transition hover:underline"
          >
            <Trash2 size={10} />
            Forget the summary
          </button>
        </div>
      )}
    </div>
  )
}

export function ChatView(): JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const threads = useChatStore((s) => s.threads)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const setTab = useWidgetStore((s) => s.setTab)
  const agentMode = useConfigStore((s) => s.config?.chat.agent ?? true)
  const setAgentMode = useConfigStore((s) => s.setAgentMode)
  const privateChat = useConfigStore((s) => s.config?.chat.private ?? false)
  const setPrivateChat = useConfigStore((s) => s.setPrivateChat)
  const pushToast = useUiStore((s) => s.pushToast)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [overridesOpen, setOverridesOpen] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const globalMode = useConfigStore((s) => s.config?.activeMode ?? 'indie-dev')
  // Single memo for every value derived from the threads list — without
  // this each one ran a `.find()` over `threads` on every render,
  // including every streaming token tick.
  const { activeThread, titleText, effectiveModeName, pinnedOverride } = useMemo(() => {
    const active = activeThreadId ? threads.find((t) => t.id === activeThreadId) : undefined
    const modeId = active?.pinnedMode ?? globalMode
    return {
      activeThread: active,
      titleText: privateChat
        ? 'Private conversation'
        : active?.title || 'Conversation',
      effectiveModeName: MODES.find((m) => m.id === modeId)?.name ?? modeId,
      pinnedOverride: Boolean(active && (active.pinnedMode || active.pinnedSystemPrompt))
    }
  }, [threads, activeThreadId, privateChat, globalMode])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])

  /** Scrolls the matched message into view and gives it a brief accent ring. */
  const jumpTo = (messageId: string): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlightedId(messageId)
    window.setTimeout(() => {
      setHighlightedId((current) => (current === messageId ? null : current))
    }, 1800)
  }

  // Listen for cross-thread search jumps — the GlobalSearchDialog dispatches
  // this after switching to the target thread. We wait a tick so the new
  // thread's messages have rendered before we try to scroll to a node.
  // The closure only reads scrollRef.current and calls setHighlightedId, so
  // a `[]` dep array is safe — re-binding per streamed token would only
  // burn add/removeListener cycles for no behavioural gain.
  useEffect(() => {
    const onJump = (event: Event): void => {
      const messageId = (event as CustomEvent<{ messageId: string }>).detail?.messageId
      if (!messageId) return
      // Defer by one paint — the thread switch may still be hydrating bubbles.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => jumpTo(messageId)))
    }
    window.addEventListener('chat:jump-to', onJump)
    return () => window.removeEventListener('chat:jump-to', onJump)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const togglePrivate = (next: boolean): void => {
    void setPrivateChat(next)
    pushToast('info', next ? CHAT_STRINGS.privateOn : CHAT_STRINGS.privateOff)
  }

  const openShare = (): void => {
    // `messages` is the live transcript for the active thread; the summary
    // sidebar entry only carries metadata, so check the message list itself.
    if (!activeThread || messages.length === 0) {
      pushToast('info', 'Nothing to share yet — send a message first.')
      return
    }
    setShareOpen(true)
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
        <button
          type="button"
          onClick={() => setTab('nexus')}
          className="flex items-center rounded-md px-1.5 py-1 text-[11px] text-slate-400 transition hover:bg-white/5 hover:text-white"
          title="Back to Nexus"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => setThreadsOpen(true)}
          title="Conversations"
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
        >
          <PanelLeft size={13} />
        </button>
        <span
          className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-slate-300"
          title={titleText}
        >
          {privateChat && <Shield size={11} className="shrink-0 text-[var(--accent)]" />}
          <span className="truncate">{titleText}</span>
        </span>
        {activeThread && (
          <button
            type="button"
            onClick={() => setOverridesOpen(true)}
            title={
              pinnedOverride
                ? 'Per-thread overrides active — click to edit'
                : 'Pin a mode or system prompt to this thread'
            }
            className={cn(
              'shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide transition',
              pinnedOverride
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border border-white/10 text-slate-500 hover:bg-white/5 hover:text-slate-300'
            )}
          >
            {effectiveModeName}
            {pinnedOverride ? ' ·  📌' : ''}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSearchOpen((o) => !o)}
            title="Search this conversation"
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md transition',
              searchOpen
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            )}
          >
            <Search size={13} />
          </button>
          <button
            type="button"
            onClick={openShare}
            title="Share conversation (copy / save / gist)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <Share2 size={13} />
          </button>
          <div
            className="flex items-center gap-1"
            title="Private mode — chat isn’t saved or remembered"
          >
            <Shield
              size={13}
              className={privateChat ? 'text-[var(--accent)]' : 'text-slate-500'}
            />
            <Toggle checked={privateChat} onChange={togglePrivate} label="Private mode" />
          </div>
          <div
            className="flex items-center gap-1"
            title="Agent mode — let VoidSoul run permission-gated tools"
          >
            <Bot size={13} className={agentMode ? 'text-[var(--accent)]' : 'text-slate-500'} />
            <Toggle checked={agentMode} onChange={(v) => void setAgentMode(v)} label="Agent mode" />
          </div>
        </div>
      </div>

      {searchOpen && (
        <ChatSearch
          onClose={() => setSearchOpen(false)}
          onJumpTo={(id) => {
            jumpTo(id)
            setSearchOpen(false)
          }}
        />
      )}

      <SummaryBanner />

      <div ref={scrollRef} className="scrollbar-void flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            highlighted={highlightedId === message.id}
          />
        ))}
      </div>
      <ChatComposer />

      <AnimatePresence>
        {threadsOpen && <ThreadsDrawer onClose={() => setThreadsOpen(false)} />}
      </AnimatePresence>

      <ShareDialog
        thread={activeThread ? { title: activeThread.title, messages } : null}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />

      <ThreadOverridesDialog
        thread={activeThread ?? null}
        open={overridesOpen}
        onClose={() => setOverridesOpen(false)}
      />
    </div>
  )
}
