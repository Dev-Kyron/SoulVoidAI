/**
 * A single chat message. User messages are accent-filled and right-aligned;
 * assistant messages render markdown in a glass bubble. Image attachments are
 * shown as thumbnails; an empty streaming reply shows animated dots.
 */
import { motion } from 'framer-motion'
import { FileText, Volume2, VolumeX, Wrench, Check, X, Maximize2 } from 'lucide-react'
import { Markdown } from './Markdown'
import { useConfigStore } from '../../store/useConfigStore'
import { useChatStore } from '../../store/useChatStore'
import { speakWith, stopSpeaking } from '../../lib/voice'
import { useIsSpeaking } from '../../hooks/useCurrentSpoken'
import { cn, formatTime } from '../../lib/utils'
import type { ChatMessage, ToolInvocation, VoiceConfig } from '@shared/types'

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
  move_mouse: 'Move mouse',
  click_mouse: 'Click mouse',
  type_text: 'Type text',
  send_keys: 'Send hotkey'
}

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
              <span className="font-mono font-semibold text-slate-200">
                {toolLabel(call.name)}
              </span>
              {Object.keys(call.args).length > 0 && (
                <span className="text-slate-500"> · {argsSummary(call.args)}</span>
              )}
              <p className="truncate text-slate-500">{call.result}</p>
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
  return (
    <div className="flex items-center gap-1 py-1">
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
  const displayContent = message.content + streamingExtra
  const images = (message.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl)
  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'text')
  // Two flavours: preview-eligible (has dataUrl) and oversize (text-only).
  const pdfFilesWithPreview = (message.attachments ?? []).filter(
    (a) => a.kind === 'pdf' && a.dataUrl
  )
  const pdfFilesTextOnly = (message.attachments ?? []).filter(
    (a) => a.kind === 'pdf' && !a.dataUrl
  )
  const canSpeak = !isUser && !message.streaming && !message.error && displayContent.length > 0

  return (
    <motion.div
      data-message-id={message.id}
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
          highlighted &&
            'ring-2 ring-offset-2 ring-offset-transparent ring-[var(--accent)]'
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
      </div>
      <div
        className={cn(
          'mt-0.5 flex items-center gap-1.5 px-1',
          isUser ? 'flex-row-reverse' : 'flex-row'
        )}
      >
        <span className="text-[9px] text-slate-500">{formatTime(message.createdAt)}</span>
        {!isUser && message.model && (
          <span
            className="text-[9px] text-slate-500/80"
            title={`Generated by ${message.model}`}
          >
            · {message.model}
          </span>
        )}
        {canSpeak && voice && (
          <SpeakerButton voice={voice} text={displayContent} />
        )}
      </div>
    </motion.div>
  )
}

/**
 * Per-message speaker control / mute toggle. Beta testers asked for a
 * quick way to silence a reply mid-read without hunting for global stop,
 * so the same button doubles as mute while TTS is active.
 *
 * Subscribes to the boolean `useIsSpeaking` rather than `useCurrentSpoken`
 * so a 50-sentence reply doesn't trigger a re-render in every visible
 * bubble each time the synth ticks to the next sentence — only the
 * speaking ↔ idle transition flips the icon, so the boolean is all we need.
 */
function SpeakerButton({ voice, text }: { voice: VoiceConfig; text: string }): JSX.Element {
  const speaking = useIsSpeaking()
  return (
    <button
      type="button"
      onClick={() => (speaking ? stopSpeaking() : speakWith(voice, text))}
      title={speaking ? 'Mute — stop reading aloud' : 'Read aloud'}
      aria-label={speaking ? 'Mute' : 'Read aloud'}
      aria-pressed={speaking}
      className={cn(
        'transition',
        speaking
          ? 'text-[var(--accent)] hover:text-rose-400'
          : 'text-slate-500 hover:text-[var(--accent)]'
      )}
    >
      {speaking ? <VolumeX size={11} /> : <Volume2 size={11} />}
    </button>
  )
}
