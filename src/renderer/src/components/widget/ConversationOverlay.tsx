/**
 * v2.0 — Conversational voice mode overlay.
 *
 * Full-panel UI that surfaces during a conversation session: a big
 * state-aware orb at the centre, the last user transcript as a quiet
 * caption, and the streaming assistant reply (text mirror of what
 * Piper is speaking) for the user who wants to glance + read instead
 * of listen. Exit button + Esc binding to drop out.
 *
 * Mounts inside the widget panel (z-50), above ChatView/Nexus. The
 * underlying chat thread keeps growing in the background — when the
 * user exits conv mode, every turn is in the transcript ready to scroll
 * back through.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { useRef } from 'react'
import { X, Mic } from 'lucide-react'
import { Orb } from './Orb'
import { useConversationStore } from '../../store/useConversationStore'
import { useChatStore } from '../../store/useChatStore'
import { useCurrentSpoken } from '../../hooks/useCurrentSpoken'
import { useDialog } from '../../lib/useDialog'
import { stripVoiceTagsOnly } from '@shared/voiceMarkers'
import type { WidgetState } from '@shared/types'

const STATE_COPY: Record<string, string> = {
  listening: 'Listening',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking'
}

/** Map the conversation state machine onto the existing orb state vocab
 *  so the orb's animation primitives stay the source of truth for what
 *  a "listening" vs "processing" orb looks like. */
function orbStateFor(status: string): WidgetState {
  if (status === 'listening') return 'listening'
  if (status === 'transcribing' || status === 'thinking') return 'processing'
  if (status === 'speaking') return 'processing'
  return 'idle'
}

/**
 * Always-mounted wrapper. We let AnimatePresence + the `active` gate
 * inside `<ConversationOverlayBody>` handle the show/hide; this
 * structure dodges the React-StrictMode double-effect cleanup trap
 * (which would otherwise call `stop()` on dev mount) AND ensures
 * `useDialog`'s effect re-runs cleanly when the open flag transitions.
 */
export function ConversationOverlay(): JSX.Element {
  const status = useConversationStore((s) => s.status)
  return <AnimatePresence>{status !== 'idle' && <ConversationOverlayBody />}</AnimatePresence>
}

function ConversationOverlayBody(): JSX.Element {
  const status = useConversationStore((s) => s.status)
  const lastUserTurn = useConversationStore((s) => s.lastUserTurn)
  const stop = useConversationStore((s) => s.stop)
  // Live mirror of the sentence Piper is currently saying — drives the
  // text-with-the-voice readout so users can glance + read. Falls back
  // to the streamingContent slot when nothing's playing yet (thinking
  // phase).
  const currentSpoken = useCurrentSpoken()
  const streamingContent = useChatStore((s) => s.streamingContent)

  const dialogRef = useRef<HTMLDivElement>(null)
  // Esc exits the conversation — body is only mounted when status !== 'idle',
  // so we pass `open: true` unconditionally; useDialog's effect runs on
  // mount with the ref already populated (motion.div ref attaches before
  // effects), so the focus trap + Esc binding wire up immediately.
  useDialog(dialogRef, stop, { open: true })

  const orbState = orbStateFor(status)
  // The reply mirror: prefer the actively-spoken sentence (more
  // accurate to what the user is hearing); fall back to the streamed
  // chat text so the user sees text the moment tokens arrive, before
  // Piper synthesises the first audio.
  const replyText = currentSpoken || stripVoiceTagsOnly(streamingContent || '').trim()

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Conversation mode"
      className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-void-800/95 px-6 backdrop-blur"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <button
        type="button"
        onClick={stop}
        aria-label="Exit conversation mode"
        title="Exit (Esc)"
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-white"
      >
        <X size={16} />
      </button>

      <div
        aria-hidden="true"
        // Big orb that visually carries the state — uses the existing
        // STATE_COLOR map so this surface looks consistent with every
        // other place an orb appears (tray, widget collapsed mode,
        // bubble busy badge).
        className="mb-6"
      >
        <Orb size={96} state={orbState} animated />
      </div>

      <p className="mb-1 text-[10px] uppercase tracking-[0.22em] text-slate-500" aria-live="polite">
        {STATE_COPY[status] ?? status}
      </p>

      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        {lastUserTurn && (
          <p className="text-[11px] italic text-slate-500" title="What I heard you say">
            “{lastUserTurn}”
          </p>
        )}
        {replyText && (
          <p
            className="max-h-[40vh] overflow-y-auto text-[14px] leading-relaxed text-slate-100"
            aria-live="polite"
          >
            {replyText}
          </p>
        )}
        {!lastUserTurn && !replyText && (
          <p className="flex items-center gap-2 text-[11px] text-slate-500">
            <Mic size={11} />
            Speak when you’re ready.
          </p>
        )}
      </div>

      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-slate-600">
        Esc to exit · barge in any time
      </p>
    </motion.div>
  )
}
