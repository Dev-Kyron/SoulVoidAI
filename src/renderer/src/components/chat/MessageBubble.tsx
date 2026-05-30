/**
 * A single chat message. User messages are accent-filled and right-aligned;
 * assistant messages render markdown in a glass bubble. Image attachments are
 * shown as thumbnails; an empty streaming reply shows animated dots.
 */
import { useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import { motion } from 'framer-motion'
import {
  FileText,
  Volume2,
  VolumeX,
  Wrench,
  Check,
  X,
  Maximize2,
  Play,
  PanelRight,
  Loader2
} from 'lucide-react'
import { Markdown } from './Markdown'
import { useConfigStore } from '../../store/useConfigStore'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { useComposerStore } from '../../store/useComposerStore'
import { speakWith, stopSpeaking } from '../../lib/voice'
import { useSpeakerState } from '../../hooks/useCurrentSpoken'
import { cn, formatTime } from '../../lib/utils'
import { stripVoiceTagsOnly } from '@shared/voiceMarkers'
import {
  WELCOME_MESSAGE_ID,
  type ChatMessage,
  type ToolInvocation,
  type VoiceConfig
} from '@shared/types'

function argsSummary(args: Record<string, unknown>): string {
  const parts = Object.values(args).map((v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 40 ? `${s.slice(0, 40)}…` : s
  })
  const joined = parts.join(', ')
  return joined.length > 70 ? `${joined.slice(0, 70)}…` : joined
}

/**
 * Friendly noun phrases per tool — used by both the live "in-flight" step
 * and the post-result card so the user sees the same vocabulary in both.
 * Missing tools fall back to the snake_case name with underscores stripped.
 */
const TOOL_LABELS: Record<string, string> = {
  web_search: 'Web search',
  web_fetch: 'Read page',
  run_python: 'Run Python',
  generate_image: 'Generate image',
  see_screen: 'See screen',
  read_screen: 'Read screen text',
  read_file: 'Read file',
  write_file: 'Write file',
  list_files: 'List files',
  run_command: 'Run command',
  open_app: 'Open app',
  open_url: 'Open URL',
  open_folder: 'Open folder',
  organize_folder: 'Organise folder',
  move_mouse: 'Move mouse',
  click_mouse: 'Click mouse',
  click_on_screen: 'Click on screen',
  type_text: 'Type text',
  send_keys: 'Send hotkey',
  hotkey: 'Send hotkey',
  save_document: 'Save document',
  visual_click: 'Click on screen'
}

/**
 * v1.12.7 — tools whose `result` field carries substantive multi-line
 * output the user will want to actually READ, not a one-line "ok" status.
 * For these, we render the body in a scrollable code-style panel instead
 * of the default `truncate` paragraph. Compared to the previous render,
 * a `run_python` script that printed 8000 chars used to be a single
 * "Read 3 files…" snippet — now the full stdout/stderr is visible.
 */
const EXPANDABLE_OUTPUT_TOOLS = new Set([
  'run_python',
  'run_shell',
  'run_command',
  'read_file',
  'list_files',
  'web_fetch',
  'web_search',
  'read_screen'
])

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ')
}

/** Renders the automation actions the assistant ran for this message. */
function ToolCalls({ calls }: { calls: ToolInvocation[] }): JSX.Element {
  return (
    <div className="mb-1.5 space-y-1">
      {calls.map((call) => (
        <div
          key={call.id}
          className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[10px]"
        >
          <div className="flex items-start gap-1.5">
            <Wrench size={11} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <span className="font-mono font-semibold text-slate-200">{toolLabel(call.name)}</span>
              {Object.keys(call.args).length > 0 && (
                <span className="text-slate-500"> · {argsSummary(call.args)}</span>
              )}
              {/* v1.12.7 — render multi-line result tools in a scrollable
               * code panel instead of the default one-line truncate.
               * Previously run_python's stdout (up to 8000 chars per the
               * tool impl) showed as a single "Read 3 files..." crumb;
               * the user couldn't see what the script actually printed.
               * Failed calls always get the expanded view too so error
               * stack traces aren't lost to truncation. */}
              {call.result && (EXPANDABLE_OUTPUT_TOOLS.has(call.name) || !call.ok) ? (
                <pre className="scrollbar-void mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 px-2 py-1.5 font-mono text-[10px] leading-snug text-slate-300">
                  {call.result}
                </pre>
              ) : (
                <p className="truncate text-slate-500">{call.result}</p>
              )}
            </div>
            {call.ok ? (
              <Check size={12} className="shrink-0 text-emerald-400" />
            ) : (
              <X size={12} className="shrink-0 text-rose-400" />
            )}
          </div>
          {call.imageOutput && (
            <img
              src={call.imageOutput}
              alt={(call.args.prompt as string) ?? 'Generated image'}
              className="mt-2 w-full cursor-zoom-in rounded-md ring-1 ring-white/10 transition hover:ring-[var(--accent-ring)]"
              onClick={() => window.open(call.imageOutput, '_blank', 'noopener')}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function StreamingDots(): JSX.Element {
  // v2.0 a11y — purely decorative animation; the parent bubble's
  // `aria-busy="true"` already conveys "in progress" to screen readers
  // and the LiveRegion will announce the completed reply. Marking the
  // dots aria-hidden stops the AT from announcing "three dots".
  return (
    <div aria-hidden="true" className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </div>
  )
}

/** "Verb form" of a tool label for the live in-flight indicator. */
function toolProgressLabel(name: string, args: Record<string, unknown>): string {
  const verb = `${toolLabel(name)}…`
  const detail =
    (args.query as string | undefined) ||
    (args.url as string | undefined) ||
    (args.path as string | undefined) ||
    (args.prompt as string | undefined) ||
    ''
  if (!detail) return verb
  const trimmed = detail.length > 40 ? `${detail.slice(0, 40)}…` : detail
  return `${toolLabel(name)}: ${trimmed}`
}

/** Pulsing "Running tool…" line shown while a tool call is in-flight. */
function LiveToolStep({
  name,
  args
}: {
  name: string
  args: Record<string, unknown>
}): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 rounded-lg border border-[var(--accent-ring)]/40 bg-[var(--accent-soft)] px-2 py-1.5 text-[10px] text-[var(--accent)]">
      <motion.span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.1, repeat: Infinity }}
      />
      <span className="truncate">{toolProgressLabel(name, args)}</span>
    </div>
  )
}

export function MessageBubble({
  message,
  highlighted
}: {
  message: ChatMessage
  highlighted?: boolean
}): JSX.Element {
  const isUser = message.role === 'user'
  const voice = useConfigStore((s) => s.config?.voice)
  // While this bubble is the in-flight assistant turn, fold the live streaming
  // slot into the displayed content. The slot lives outside `messages` so we
  // don't re-clone the full thread per token — only bubbles that match the
  // pending id subscribe to it, so every other bubble stays inert.
  const streamingExtra = useChatStore((s) =>
    s.pendingAssistantId === message.id ? s.streamingContent : ''
  )
  // Live "Running web_search…" indicator — only the pending assistant turn
  // subscribes; every other bubble bails out at the equality check.
  const pendingTool = useChatStore((s) =>
    s.pendingAssistantId === message.id ? s.pendingTool : null
  )
  // v1.3.0: assistant replies may contain <voice tone="...">...</voice>
  // markers (the voice pipeline reads them to drive TTS). Strip the tag
  // tokens out before rendering — the content inside the tags STAYS
  // visible in chat (the voice layer is a subset of the chat layer, not
  // a parallel narrative), only the angle-bracket wrappers come out.
  //
  // v2.0 round-6 perf — split into a memoized static-part strip + a
  // per-token tail strip. Previously the regex ran over the FULL
  // accumulated body on every render (including unrelated re-renders
  // from sibling bubbles). For a long assistant reply that's an O(N)
  // pass per render × many renders. Static content is memoized so it
  // only re-runs when `message.content` actually changes; the small
  // streaming tail is the only piece that re-strips per token.
  const staticStripped = useMemo(() => stripVoiceTagsOnly(message.content), [message.content])
  const displayContent = streamingExtra
    ? staticStripped + stripVoiceTagsOnly(streamingExtra)
    : staticStripped
  const images = (message.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl)
  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'text')
  // Two flavours: preview-eligible (has dataUrl) and oversize (text-only).
  const pdfFilesWithPreview = (message.attachments ?? []).filter(
    (a) => a.kind === 'pdf' && a.dataUrl
  )
  const pdfFilesTextOnly = (message.attachments ?? []).filter((a) => a.kind === 'pdf' && !a.dataUrl)
  const canSpeak = !isUser && !message.streaming && !message.error && displayContent.length > 0

  return (
    <motion.div
      data-message-id={message.id}
      // v2.0 a11y — `article` role lets screen-reader users navigate
      // bubble-by-bubble with the AT's "next article" shortcut (D in
      // NVDA, jaws). `aria-busy` flips to true while the streaming
      // bubble is still filling in so the AT knows not to re-read
      // the partial content mid-stream; the dedicated LiveRegion
      // announces "Reply ready" once the stream completes (see
      // useChatStore's success branch).
      role="article"
      aria-label={isUser ? 'You said' : message.error ? 'Assistant error' : 'Assistant replied'}
      aria-busy={message.streaming || undefined}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}
    >
      <div
        className={cn(
          'max-w-[86%] rounded-2xl px-3 py-2 text-[13px] transition',
          isUser
            ? 'rounded-br-sm bg-[var(--accent)] text-white'
            : message.error
              ? 'rounded-bl-sm border border-rose-500/40 bg-rose-500/10 text-rose-100'
              : 'glass-soft rounded-bl-sm text-slate-100',
          highlighted && 'ring-2 ring-offset-2 ring-offset-transparent ring-[var(--accent)]'
        )}
      >
        {images.length > 0 && (
          <div className="mb-1.5 grid grid-cols-2 gap-1.5">
            {images.map((img) => (
              <img
                key={img.id}
                src={img.dataUrl}
                alt={img.name}
                className="h-20 w-full rounded-lg object-cover ring-1 ring-white/15"
              />
            ))}
          </div>
        )}

        {textFiles.map((file) => (
          <div
            key={file.id}
            className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-black/25 px-2 py-1 text-[11px]"
          >
            <FileText size={12} />
            <span className="truncate">{file.name}</span>
          </div>
        ))}

        {pdfFilesWithPreview.map((file) => (
          <div
            key={file.id}
            className="mb-1.5 overflow-hidden rounded-lg bg-black/25 ring-1 ring-white/10"
          >
            <div className="flex items-center justify-between gap-1.5 px-2 py-1 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <FileText size={12} className="text-rose-300" />
                <span className="truncate">{file.name}</span>
              </div>
              <button
                type="button"
                onClick={() => window.open(file.dataUrl, '_blank', 'noopener')}
                title="Open PDF in a new window"
                aria-label={`Open ${file.name} in a new window`}
                className="rounded p-0.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                <Maximize2 size={11} />
              </button>
            </div>
            {/* Chromium's built-in PDF viewer — handles zoom, scroll, search,
               page nav out of the box from a data URL. */}
            <embed
              src={file.dataUrl}
              type="application/pdf"
              className="block h-72 w-full bg-white"
            />
          </div>
        ))}

        {pdfFilesTextOnly.map((file) => (
          <div
            key={file.id}
            className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-black/25 px-2 py-1 text-[11px]"
            title="PDF too large for inline preview — text extracted for the model only."
          >
            <FileText size={12} className="text-rose-300" />
            <span className="truncate">{file.name}</span>
            <span className="text-slate-500">· preview unavailable (large file)</span>
          </div>
        ))}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCalls calls={message.toolCalls} />
        )}

        {pendingTool && <LiveToolStep name={pendingTool.name} args={pendingTool.args} />}

        {isUser ? (
          displayContent && (
            <p className="selectable whitespace-pre-wrap break-words">{displayContent}</p>
          )
        ) : displayContent ? (
          <div className="selectable markdown break-words">
            <Markdown>{displayContent}</Markdown>
          </div>
        ) : (
          <StreamingDots />
        )}

        {!isUser && message.paused && !message.streaming && (
          // v2.0 — Resume button for step-cap pauses. Pre-2.0 users had to
          // read the pause prefix and manually type "continue" to extend
          // the run. Now they tap Resume; the store fires the same magic
          // word into send(). Hidden while ANY message is streaming so
          // the user can't queue a continue mid-reply (send() early-
          // returns in that case anyway, but the disabled state makes
          // the constraint visible instead of silent). The button itself
          // captures the active thread id at render and re-checks at
          // click time — guards against the (rare) race where a thread
          // switch races the click and would otherwise inject "continue"
          // into the wrong thread.
          <ResumeButton />
        )}
      </div>
      <div
        className={cn(
          'mt-0.5 flex items-center gap-1.5 px-1',
          isUser ? 'flex-row-reverse' : 'flex-row'
        )}
      >
        <span className="text-[9px] text-slate-500">{formatTime(message.createdAt)}</span>
        {!isUser && message.model && (
          <span className="text-[9px] text-slate-500/80" title={`Generated by ${message.model}`}>
            · {message.model}
          </span>
        )}
        {!isUser && message.routingReason && (
          // v1.13.6 — Auto-router decision badge. Only present when the
          // router overrode the user's active provider for this turn;
          // hovering the chip reveals the full reason (task label + the
          // scoring bits that swung it). Lets users see WHY a different
          // model answered without having to dig through Logs.
          <span
            className="rounded-sm bg-[var(--accent-soft)] px-1 py-px text-[8px] uppercase tracking-wider text-[var(--accent)]"
            title={`Auto-router: ${message.routingReason}`}
          >
            Auto
          </span>
        )}
        {canSpeak && voice && <SpeakerButton voice={voice} text={displayContent} />}
        {!isUser &&
          !message.streaming &&
          !message.error &&
          message.id !== WELCOME_MESSAGE_ID &&
          displayContent.length > 0 && (
            // v2.0 — Composer drop button. Shovels the assistant's reply
            // straight into the markdown side-panel. Hidden on:
            //   - streaming bubbles (mid-stream → partial doc)
            //   - error bubbles (the user doesn't want "⚠ 429 — rate
            //     limited" landing in their draft)
            //   - the synthetic welcome message (every other consumer
            //     in the codebase filters this out for the same reason)
            //   - empty bubbles
            // Toasts on plain-click because the side panel may not be
            // open at the moment of click.
            <ComposerDropButton text={displayContent} />
          )}
      </div>
    </motion.div>
  )
}

/**
 * Per-message speaker control. Three visual states:
 *   idle     — speaker icon, click to start reading
 *   warming  — spinner, "Preparing voice…" (Piper synth in flight or
 *              audio decoded but not yet playing; can be 1-3s on cold
 *              caches or long inputs — previously the button stayed
 *              in `idle` here and the click felt ignored)
 *   speaking — mute icon, click to stop
 *
 * Subscribes to `useSpeakerState` rather than `useIsSpeaking` so the
 * warming state can be surfaced. State flips on transitions only —
 * sentence-by-sentence ticks during a long reply don't re-render
 * every visible bubble.
 *
 * Click handler routes warming → stop too, so a user who regrets
 * pressing Read Aloud doesn't have to wait for synth to finish
 * before being able to cancel.
 */
function SpeakerButton({ voice, text }: { voice: VoiceConfig; text: string }): JSX.Element {
  const state = useSpeakerState()
  const busy = state !== 'idle'
  const tooltip =
    state === 'warming'
      ? 'Preparing voice…'
      : state === 'speaking'
        ? 'Mute — stop reading aloud'
        : 'Read aloud'
  // Mirror the visible tooltip — "Stop" alone leaves SR users guessing
  // what's being stopped during the warming window.
  const ariaLabel =
    state === 'speaking' ? 'Mute' : state === 'warming' ? 'Stop preparing voice' : 'Read aloud'
  return (
    <button
      type="button"
      onClick={() => (busy ? stopSpeaking() : speakWith(voice, text))}
      title={tooltip}
      aria-label={ariaLabel}
      aria-pressed={state === 'speaking'}
      aria-busy={state === 'warming'}
      className={cn(
        'transition',
        busy
          ? 'text-[var(--accent)] hover:text-rose-400'
          : 'text-slate-500 hover:text-[var(--accent)]'
      )}
    >
      {state === 'warming' ? (
        <Loader2 size={11} className="animate-spin" />
      ) : state === 'speaking' ? (
        <VolumeX size={11} />
      ) : (
        <Volume2 size={11} />
      )}
    </button>
  )
}

/**
 * v2.0 — Resume button rendered on assistant bubbles that hit the
 * MAX_AGENT_STEPS ceiling. Sends the literal string "continue" through
 * the standard send() path — the agent loop sees the full conversation
 * history with its earlier tool-call breadcrumbs and picks up from
 * where it stopped. Disabled while ANY reply is streaming so the user
 * can't queue a duplicate continue mid-reply.
 *
 * Why disable rather than hide on streaming: the bubble is staying
 * paused either way; hiding the button would imply the pause was
 * resolved on its own. Disabled-with-tooltip explains "wait for the
 * current reply to finish" without lying about state.
 *
 * Thread-id guard: the bubble belongs to the active thread (that's
 * how messages are filtered to it). We capture the active thread id
 * at render and re-check at click time — protects against the
 * race where a thread switch lands between paint and click, which
 * would otherwise see send() inject "continue" into the wrong thread.
 */
function ResumeButton(): JSX.Element {
  const send = useChatStore((s) => s.send)
  const streaming = useChatStore((s) => s.streaming)
  const ownerThreadId = useChatStore((s) => s.activeThreadId)
  const pushToast = useUiStore((s) => s.pushToast)
  const handleClick = (): void => {
    // Re-read activeThreadId at click time. The captured `ownerThreadId`
    // is the value at render; mismatch means a thread switch happened
    // between paint and click. Bail with a clarifying toast rather than
    // silently driving the wrong conversation.
    const currentThread = useChatStore.getState().activeThreadId
    if (currentThread !== ownerThreadId) {
      pushToast('info', 'Switch back to the paused thread to resume from there.')
      return
    }
    void send('continue')
  }
  return (
    <div className="mt-2 flex">
      <button
        type="button"
        disabled={streaming}
        onClick={handleClick}
        title={
          streaming ? 'Wait for the current reply to finish first.' : 'Resume the paused agent run'
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent)] transition',
          streaming
            ? 'cursor-not-allowed opacity-50'
            : 'hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-white'
        )}
      >
        <Play size={11} fill="currentColor" />
        Resume
      </button>
    </div>
  )
}

/**
 * v2.0 — drops an assistant reply into the Composer side-panel.
 *
 * Two click modes that share one button:
 *   - Plain click → REPLACE the document content with this reply.
 *   - Alt/Option-click → APPEND this reply to the existing document
 *     (with a blank line separator). Useful when the user is iterating
 *     and wants to keep stacking output rather than discard prior edits.
 *
 * Always opens the panel as a side-effect so the user sees their
 * action take effect even if the panel was closed at click time.
 * Pushes a toast on plain-click because the panel-open animation
 * doesn't always make the destination obvious from the chat side.
 */
function ComposerDropButton({ text }: { text: string }): JSX.Element {
  const setContent = useComposerStore((s) => s.setContent)
  const appendContent = useComposerStore((s) => s.appendContent)
  const setOpen = useComposerStore((s) => s.setOpen)
  const pushToast = useUiStore((s) => s.pushToast)
  const handleClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    if (e.altKey) {
      appendContent(text)
      setOpen(true)
      return
    }
    setContent(text)
    setOpen(true)
    pushToast('success', 'Sent to Composer.')
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      title="Send to Composer (Alt-click to append)"
      aria-label="Send this reply to the Composer side-panel"
      className="text-slate-500 transition hover:text-[var(--accent)]"
    >
      <PanelRight size={11} />
    </button>
  )
}
