/**
 * Slide-in sidebar that lists every saved conversation thread. Click a row
 * to switch into that chat; hover for rename/delete; "+ New chat" creates a
 * fresh thread and switches to it. Designed to overlay the chat area on the
 * narrow VoidSoul panel rather than dock as a persistent sidebar.
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus,
  X,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  AlertTriangle,
  Star
} from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { cn, relativeTime } from '../../lib/utils'
import { EmptyState } from '../common/ui'
import type { ThreadSummary } from '@shared/types'

function ThreadRow({
  thread,
  active,
  onClick,
  onRename,
  onDelete,
  onTogglePin
}: {
  thread: ThreadSummary
  active: boolean
  onClick: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onTogglePin: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const commit = (): void => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== thread.title) onRename(trimmed)
    else setDraft(thread.title)
  }

  if (confirmingDelete) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-2">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-white">Delete "{thread.title}"?</p>
          <p className="text-[10px] text-slate-400">
            This removes the conversation and its embeddings. Can't be undone.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
            title="Delete"
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-rose-400 transition hover:bg-rose-500/20"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            title="Cancel"
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-2 rounded-lg border px-2.5 py-2 transition',
        active
          ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
          : 'border-white/5 bg-black/20 hover:border-white/15 hover:bg-black/30'
      )}
    >
      {thread.pinned ? (
        <Star
          size={13}
          className={cn(
            'mt-0.5 shrink-0 fill-current',
            active ? 'text-[var(--accent)]' : 'text-amber-400'
          )}
        />
      ) : (
        <MessageSquare
          size={13}
          className={cn('mt-0.5 shrink-0', active ? 'text-[var(--accent)]' : 'text-slate-500')}
        />
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(thread.title)
                setEditing(false)
              }
            }}
            className="w-full rounded border border-[var(--accent-ring)] bg-black/40 px-1.5 py-0.5 text-[11px] text-white outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onClick}
            className="block w-full text-left"
          >
            <p
              className={cn(
                'truncate text-[11px] font-semibold',
                active ? 'text-white' : 'text-slate-200'
              )}
            >
              {thread.title}
            </p>
            <p className="truncate text-[10px] text-slate-500">
              {thread.preview || '(empty)'}
            </p>
            <p className="mt-0.5 text-[9px] text-slate-600">
              {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'} ·{' '}
              {relativeTime(thread.updatedAt)}
            </p>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {/* Pin toggle stays visible when pinned so the state is obvious. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          title={thread.pinned ? 'Unpin' : 'Pin to top'}
          aria-label={thread.pinned ? 'Unpin thread' : 'Pin thread to top'}
          aria-pressed={thread.pinned}
          className={cn(
            'transition',
            thread.pinned
              ? 'text-amber-400 hover:text-amber-300'
              : 'text-slate-500 opacity-0 hover:text-amber-400 group-hover:opacity-100'
          )}
        >
          <Star size={11} className={thread.pinned ? 'fill-current' : undefined} />
        </button>
        <div className="flex flex-col gap-1 opacity-0 transition group-hover:opacity-100">
        {editing ? (
          <button
            type="button"
            onClick={commit}
            title="Save"
            aria-label="Save thread name"
            className="text-[var(--accent)] transition hover:brightness-125"
          >
            <Check size={12} />
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setDraft(thread.title)
              setEditing(true)
            }}
            title="Rename"
            aria-label="Rename thread"
            className="text-slate-500 transition hover:text-[var(--accent)]"
          >
            <Pencil size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConfirmingDelete(true)
          }}
          title="Delete conversation"
          aria-label="Delete thread"
          className="text-slate-500 transition hover:text-rose-400"
        >
          <Trash2 size={11} />
        </button>
        </div>
      </div>
    </div>
  )
}

export function ThreadsDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const threads = useChatStore((s) => s.threads)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const createThread = useChatStore((s) => s.createThread)
  const switchThread = useChatStore((s) => s.switchThread)
  const renameThread = useChatStore((s) => s.renameThread)
  const deleteThread = useChatStore((s) => s.deleteThread)
  const togglePinned = useChatStore((s) => s.togglePinned)
  const pushToast = useUiStore((s) => s.pushToast)

  // Pinned threads float to the top; within each group we preserve the
  // newest-first order the store already maintains. Memoised so we don't
  // re-clone-and-sort on every parent re-render.
  const sortedThreads = useMemo(
    () =>
      [...threads].sort((a, b) => {
        const pa = a.pinned ? 1 : 0
        const pb = b.pinned ? 1 : 0
        return pb - pa
      }),
    [threads]
  )

  const handleNew = async (): Promise<void> => {
    await createThread()
    onClose()
  }

  const handleSwitch = async (id: string): Promise<void> => {
    await switchThread(id)
    onClose()
  }

  const handleDelete = async (thread: ThreadSummary): Promise<void> => {
    await deleteThread(thread.id)
    pushToast('success', `Deleted "${thread.title}".`)
  }

  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col bg-void-800/95 backdrop-blur"
      initial={{ x: '-100%' }}
      animate={{ x: 0 }}
      exit={{ x: '-100%' }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-300">Conversations</span>
        <span className="text-[10px] text-slate-500">
          {threads.length} thread{threads.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="ml-auto text-slate-400 transition hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      <div className="border-b border-white/5 px-3 py-2">
        <button
          type="button"
          onClick={() => void handleNew()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] py-2 text-[11px] font-semibold text-white transition hover:bg-[var(--accent)]"
        >
          <Plus size={13} />
          New chat
        </button>
      </div>

      <div className="scrollbar-void flex-1 space-y-1.5 overflow-y-auto px-3 py-2">
        {threads.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="No conversations yet"
            hint="Send your first message and it'll be saved here. Conversations stay on this machine — nothing leaves unless you explicitly share."
          />
        ) : (
          sortedThreads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              active={thread.id === activeThreadId}
              onClick={() => void handleSwitch(thread.id)}
              onRename={(title) => void renameThread(thread.id, title)}
              onDelete={() => void handleDelete(thread)}
              onTogglePin={() => void togglePinned(thread.id)}
            />
          ))
        )}
      </div>
    </motion.div>
  )
}
