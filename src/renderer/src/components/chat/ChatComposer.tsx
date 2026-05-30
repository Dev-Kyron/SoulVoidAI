/**
 * Message composer: an auto-sizing textarea with attachment controls
 * (image / file picker, screenshot capture, OCR screen-read) and a combined
 * send / stop button. Saved prompts can be pushed in from Settings → Memory.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ImagePlus,
  Camera,
  ScanText,
  SendHorizontal,
  Square,
  X,
  FileText,
  Trash2,
  Brain,
  ChevronDown,
  Eye,
  Sparkles,
  AudioLines
} from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useConversationStore } from '../../store/useConversationStore'
import { useUiStore } from '../../store/useUiStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { extractFacts } from '../../lib/factExtractor'
import { runAction } from '../../lib/actions'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { CHAT_STRINGS } from '../../lib/chatStrings'
import { MicButton } from '../common/MicButton'
import { useFileDrop } from '../../lib/useFileDrop'
import { useClipboardPaste } from '../../lib/useClipboardPaste'
import { modelHasVision } from '@shared/modelCapabilities'
import { WELCOME_MESSAGE_ID } from '@shared/types'
import { useT } from '../../lib/i18n'

/**
 * Per-thread model picker pill. Shows the model currently in use (override or
 * provider default) and lets the user swap it for THIS thread only — handy
 * when you want gpt-4o for vision on one chat while keeping a cheaper default
 * everywhere else. Lives inside the composer area to stay close to the action.
 */
function ModelPickerPill(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // v2.0 a11y — stable id pairing trigger ↔ listbox. The trigger's
  // `aria-controls` and the popover's `id` must match for AT engines
  // to follow the haspopup/expanded relationship into the listbox
  // rather than treating it as a detached pop-up.
  const listboxId = useId()
  const config = useConfigStore((s) => s.config)
  const provider = config?.providers.find((p) => p.id === config.activeProvider)
  // Subscribe to JUST this provider's model slice — using the whole `models`
  // map would re-run this component every time any other provider's list
  // landed in the store.
  const liveList = useConfigStore((s) => (provider ? s.models[provider.id] : undefined))
  const loadModels = useConfigStore((s) => s.loadModels)
  const modelOverride = useChatStore((s) => s.modelOverride)
  const setModelOverride = useChatStore((s) => s.setModelOverride)

  useEffect(() => {
    if (!open || !provider) return
    // Lazy-fetch the live model list the first time the picker opens, so we
    // surface fresh models without doing it on every chat boot.
    if (!liveList) void loadModels(provider.id)
  }, [open, provider, liveList, loadModels])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Dedup live list against defaults so the popover doesn't list a model
  // twice. Memoised so re-renders triggered by other store slices (or by
  // the popover toggling open) don't re-build the array.
  const merged = useMemo(
    () => (provider ? Array.from(new Set([...(liveList ?? []), ...provider.defaultModels])) : []),
    [liveList, provider]
  )

  if (!provider) return null

  const activeModel = modelOverride || provider.model
  const overridden = Boolean(modelOverride)

  // When no manual override is set, the router picks per-prompt — vision,
  // tool-heavy, coding, reasoning, fast, etc. Surface that in the pill so
  // beta testers stop manually switching providers thinking they have to;
  // the badge tells them VoidSoul is already choosing the right one each
  // time. The actual model used lands on every assistant bubble via the
  // existing `model:` stamp.
  const tooltip = overridden
    ? `Locked to ${activeModel} for this thread. Click to change or unlock.`
    : `Auto-routing per prompt — vision goes to a vision model, code to a coding model, etc. Default: ${activeModel}. Click to lock to one model.`

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={tooltip}
        aria-label={
          overridden
            ? `Model: ${activeModel} (locked for this thread)`
            : `Model: auto-routing, default ${activeModel}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        className={cn(
          'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition',
          overridden
            ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
            : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
        )}
      >
        {overridden ? (
          modelHasVision(activeModel) && <Eye size={9} className="text-emerald-400" />
        ) : (
          <Sparkles size={9} className="text-emerald-300" />
        )}
        <span className="max-w-[180px] truncate">
          {overridden ? activeModel : `Auto · ${activeModel}`}
        </span>
        <ChevronDown size={10} />
      </button>
      {open && (
        // Anchored `right-0` so the popover grows LEFTWARDS from the pill —
        // the pill sits at the right edge of the composer toolbar, so a
        // `left-0` anchor would extend past the panel wall and get clipped
        // by the outer `overflow-hidden`. Width capped relative to the
        // viewport too, in case a future narrower panel surface mounts this.
        // role=listbox + aria-label completes the haspopup/expanded chain
        // declared on the trigger pill — screen readers announce the
        // popover as a model picker list, not a generic group.
        <div
          id={listboxId}
          role="listbox"
          aria-label="Pick a model for this thread"
          className="absolute bottom-full right-0 z-30 mb-1 w-[240px] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-[var(--surface-card-strong)] py-1 shadow-xl"
        >
          <button
            type="button"
            onClick={() => {
              setModelOverride(null)
              setOpen(false)
            }}
            title="VoidSoul picks per prompt across every configured provider — vision tasks go to a vision model, agent runs to a fast tool-use model, etc."
            role="option"
            aria-selected={!overridden}
            className={cn(
              'flex w-full items-start gap-2 px-3 py-2 text-left text-[11px] transition hover:bg-white/5',
              !overridden ? 'text-[var(--accent)]' : 'text-slate-300'
            )}
          >
            <Sparkles
              size={11}
              className={cn('mt-0.5 shrink-0', !overridden ? 'text-emerald-300' : 'text-slate-500')}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">Auto-route</span>
              <span className="block truncate text-[9px] text-slate-500">
                Picks per prompt · {provider.model}
              </span>
            </span>
            {!overridden && <span className="mt-0.5 shrink-0 text-[9px]">active</span>}
          </button>
          {merged.length > 0 && <div className="my-1 border-t border-white/5" />}
          <div className="scrollbar-void max-h-[240px] overflow-y-auto">
            {merged.map((id) => {
              const selected = modelOverride === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setModelOverride(id)
                    setOpen(false)
                  }}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] transition hover:bg-white/5',
                    selected ? 'text-[var(--accent)]' : 'text-slate-300'
                  )}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {modelHasVision(id) && <Eye size={9} className="text-emerald-400 shrink-0" />}
                    <span className="truncate">{id}</span>
                  </span>
                  {selected && <span className="text-[9px]">active</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolButton({
  icon,
  title,
  onClick,
  disabled,
  active
}: {
  icon: JSX.Element
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      // Icon-only buttons need an accessible name for screen readers. The
      // `title` doubles as the SR label so each composer tool announces
      // ("Attach image", "Capture screenshot", etc.) rather than just "button".
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-slate-400 hover:bg-white/10 hover:text-white'
      )}
    >
      {icon}
    </button>
  )
}

export function ChatComposer(): JSX.Element {
  const [text, setText] = useState('')
  const [remembering, setRemembering] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const t = useT()

  const streaming = useChatStore((s) => s.streaming)
  const attachments = useChatStore((s) => s.attachments)
  const pendingInsert = useChatStore((s) => s.pendingInsert)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const clear = useChatStore((s) => s.clear)
  const removeAttachment = useChatStore((s) => s.removeAttachment)
  const addImage = useChatStore((s) => s.addImageAttachment)
  const addText = useChatStore((s) => s.addTextAttachment)
  const addPdf = useChatStore((s) => s.addPdfAttachment)
  const clearInsert = useChatStore((s) => s.clearInsert)
  const pushToast = useUiStore((s) => s.pushToast)

  const resize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`
  }

  // A saved prompt sent over from Settings → Memory.
  useEffect(() => {
    if (!pendingInsert) return
    setText((prev) => (prev.trim() ? `${prev}\n${pendingInsert}` : pendingInsert))
    clearInsert()
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      resize()
    })
  }, [pendingInsert, clearInsert])

  const submit = (): void => {
    if (streaming) return
    void send(text)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const pickFile = async (): Promise<void> => {
    const file = await vs.system.pickFile()
    if (!file) return
    if (file.kind === 'image' && file.dataUrl) addImage(file.name, file.dataUrl)
    else if (file.kind === 'pdf' && file.dataUrl && file.text !== undefined)
      addPdf(file.name, file.text, file.dataUrl)
    else if (file.text !== undefined) addText(file.name, file.text)
  }

  /**
   * Manual override for the long-term memory: extract durable facts from the
   * current conversation regardless of the auto-extract toggle, then toast
   * what landed in memory so the user sees it worked.
   */
  const rememberThis = async (): Promise<void> => {
    if (remembering) return
    if (useConfigStore.getState().config?.chat.private) {
      pushToast('info', CHAT_STRINGS.rememberedDisabledByPrivate)
      return
    }
    const messages = useChatStore.getState().messages.filter((m) => m.id !== WELCOME_MESSAGE_ID)
    if (messages.length === 0) {
      pushToast('info', 'Have a conversation first — nothing to remember yet.')
      return
    }
    setRemembering(true)
    const before = useMemoryStore.getState().data?.facts.length ?? 0
    const added = await extractFacts(messages, { force: true })
    const after = useMemoryStore.getState().data?.facts.length ?? before
    setRemembering(false)
    if (added > 0 && after > before) {
      pushToast(
        'success',
        `Remembered ${added} thing${added === 1 ? '' : 's'} — see Settings → Memory.`
      )
    } else {
      pushToast('info', CHAT_STRINGS.rememberedNothing)
    }
  }

  const canSend = streaming || text.trim().length > 0 || attachments.length > 0
  // Drag-and-drop file attach — composer accepts images and the same text
  // extensions the file picker does. Visual outline lights up while a drag
  // is over the composer area; release adds the files to the attachments
  // list. Matches the pick-via-button flow's semantics so users with no
  // mouse-button preference get identical results.
  const drop = useFileDrop()
  // Ctrl+V image / file paste — same attachment semantics as drag-and-drop
  // so a clipboard screenshot lands the same way a dragged screenshot would.
  // Text paste still falls through to the textarea's default handler.
  const onPaste = useClipboardPaste()

  return (
    <div
      className={cn(
        'relative border-t border-white/5 bg-black/20 px-3 py-2.5 transition',
        drop.isDragging && 'bg-[var(--accent-soft)]'
      )}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      {drop.isDragging && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--accent-ring)] bg-black/40 text-[12px] font-semibold text-[var(--accent)]">
          {t('composer.drop_to_attach')}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-1.5 rounded-lg bg-white/10 py-1 pl-1.5 pr-1 text-[10px]"
            >
              {attachment.kind === 'image' && attachment.dataUrl ? (
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="h-6 w-6 rounded object-cover"
                />
              ) : (
                <FileText size={12} />
              )}
              <span className="max-w-[90px] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                aria-label={`Remove attachment ${attachment.name}`}
                className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-1.5 flex items-center justify-end">
        <ModelPickerPill />
      </div>

      <div className="flex items-end gap-1.5">
        <div className="flex gap-0.5">
          <ToolButton
            icon={<ImagePlus size={16} />}
            title={t('composer.attach')}
            onClick={() => void pickFile()}
          />
          <ToolButton
            icon={<Camera size={16} />}
            title={t('composer.screenshot')}
            onClick={() => void runAction({ type: 'screenshot', params: {} }, 'Screenshot')}
          />
          <ToolButton
            icon={<ScanText size={16} />}
            title={t('composer.read_screen')}
            onClick={() => void runAction({ type: 'read-screen', params: {} }, 'Read screen text')}
          />
          <MicButton className="h-8 w-8" />
          <ConversationButton />
          <ToolButton
            icon={<Brain size={16} className={remembering ? 'animate-pulse' : undefined} />}
            title={t('composer.remember')}
            onClick={() => void rememberThis()}
            disabled={remembering}
            active={remembering}
          />
          <ToolButton icon={<Trash2 size={15} />} title={t('composer.clear')} onClick={clear} />
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder={t('composer.placeholder')}
          // v2.0 a11y — `placeholder` is NOT an accessible name (it
          // disappears as soon as the user types); the aria-label gives
          // screen readers a stable handle. Mirrors the visible UI
          // language so sighted + SR users see the same affordance.
          aria-label={t('composer.placeholder')}
          onChange={(e) => {
            setText(e.target.value)
            resize()
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          // Electron's Chromium ships a built-in spellchecker — explicit
          // attribute because <textarea> defaults vary across distros and
          // beta testers flagged the missing red-underline on misspellings.
          spellCheck
          autoCorrect="on"
          className="scrollbar-void max-h-[110px] flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-[var(--accent-ring)]"
        />

        <button
          type="button"
          onClick={() => (streaming ? stop() : submit())}
          disabled={!canSend}
          title={streaming ? t('composer.stop') : t('composer.send')}
          aria-label={streaming ? t('composer.stop') : t('composer.send')}
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
            'disabled:cursor-not-allowed disabled:opacity-40',
            streaming
              ? 'bg-rose-500/80 text-white hover:bg-rose-500'
              : 'bg-[var(--accent)] text-white hover:brightness-110'
          )}
        >
          {streaming ? <Square size={14} className="fill-current" /> : <SendHorizontal size={16} />}
        </button>
      </div>
    </div>
  )
}

/**
 * v2.0 — Launches conversation mode (full-duplex hands-free voice).
 * Distinct from MicButton: that's a single-shot push-to-transcribe;
 * this one opens a continuous, interruptible session that auto-loops
 * between user turns and assistant replies until the user exits.
 *
 * Pulled into its own component so the Zustand subscription is local —
 * the broader ChatComposer doesn't need to re-render every time the
 * conversation state ticks over.
 */
function ConversationButton(): JSX.Element {
  const status = useConversationStore((s) => s.status)
  const toggle = useConversationStore((s) => s.toggle)
  const active = status !== 'idle'
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      title={active ? 'Exit conversation mode' : 'Start conversation mode (Ctrl/Cmd+Shift+V)'}
      aria-label={active ? 'Exit conversation mode' : 'Start conversation mode'}
      aria-pressed={active}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg transition',
        active
          ? 'bg-[var(--accent)] text-white shadow-[0_0_12px_var(--accent-glow)]'
          : 'text-slate-400 hover:bg-white/10 hover:text-white'
      )}
    >
      <AudioLines size={16} className={active ? 'animate-pulse' : undefined} />
    </button>
  )
}
