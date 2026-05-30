/**
 * Quick-reference help dialog. Opened by the "?" button in the panel header.
 * One scrollable card that explains tabs, memory layers, shortcuts and the
 * privacy / agent toggles — everything a returning user might forget.
 */
import { useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X,
  Keyboard,
  Radar,
  MessageSquare,
  ScrollText,
  SlidersHorizontal,
  Brain,
  Shield,
  Bot,
  FolderOpen
} from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { useDialog } from '../../lib/useDialog'

const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: 'Ctrl + Shift + Space', desc: 'Summon / hide the widget' },
  { keys: 'Ctrl + Shift + J', desc: 'Quick AI — one-shot answer (works from any app)' },
  { keys: 'Ctrl + K', desc: 'Open the command palette' },
  { keys: 'Ctrl + N', desc: 'Start a new chat thread' },
  { keys: 'Enter', desc: 'Send a message' },
  { keys: 'Shift + Enter', desc: 'New line in the composer' },
  { keys: 'Esc', desc: 'Close any open dialog' }
]

interface Section {
  icon: typeof Keyboard
  title: string
  body: JSX.Element
}

const SECTIONS: Section[] = [
  {
    icon: Radar,
    title: 'Nexus',
    body: (
      <>
        Your home screen — orb, quick actions, telemetry. Tap the orb to open the conversation. Add
        custom shortcuts via the <strong>+</strong> tile or in Settings → Memory → Quick Actions.
        Two layouts in Settings → Appearance: <strong>Simple</strong> (phone-style) and{' '}
        <strong>Advanced</strong> (radial HUD).
      </>
    )
  },
  {
    icon: MessageSquare,
    title: 'Conversation',
    body: (
      <>
        Each chat lives in its own <strong>thread</strong> — open the sidebar with the panel icon.
        New chat, rename, pin, delete from there. The header carries <strong>Search</strong> (this
        thread), <strong>Copy as Markdown</strong>, and the <strong>Private</strong> and{' '}
        <strong>Agent</strong> toggles.
      </>
    )
  },
  {
    icon: Brain,
    title: 'Memory',
    body: (
      <>
        Four layers stack to make VoidSoul remember you:
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">
          <li>
            <strong>Threads</strong> — every chat is saved.
          </li>
          <li>
            <strong>Story so far</strong> — long chats auto-summarised.
          </li>
          <li>
            <strong>Facts</strong> — durable bullets injected into every prompt (mode-taggable).
          </li>
          <li>
            <strong>RAG</strong> — embeds past messages so older snippets resurface.
          </li>
        </ul>
        Manage everything in Settings → Memory.
      </>
    )
  },
  {
    icon: Bot,
    title: 'Agent mode',
    body: (
      <>
        When on, VoidSoul can <strong>act on your machine</strong> — open apps, run shell commands,
        manage files, read the screen. Every sensitive tool call asks permission first, and the run
        lands in the Logs tab. Toggle on the chat header.
      </>
    )
  },
  {
    icon: Shield,
    title: 'Private mode',
    body: (
      <>
        Flip the shield on the chat header. The current chat <strong>isn’t saved</strong>, no facts
        are extracted, the screen-awareness line is suppressed in the prompt. Use for sensitive
        material.
      </>
    )
  },
  {
    icon: ScrollText,
    title: 'Logs',
    body: (
      <>
        Every AI call, automation action and permission change is recorded with full transparency.
        Filter by level, by category, or free-text search.
      </>
    )
  },
  {
    icon: SlidersHorizontal,
    title: 'Settings',
    body: (
      <>
        Hover any title for a hint. Memory is split into <strong>AI Memory</strong>,{' '}
        <strong>Quick Actions</strong> and <strong>Workspace</strong> sub-tabs. Backup & Sync
        exports everything (config, memory, plugins, chat history) as one portable JSON.
      </>
    )
  }
]

export function HelpDialog(): JSX.Element {
  const open = useUiStore((s) => s.helpOpen)
  const setOpen = useUiStore((s) => s.setHelpOpen)
  const dialogRef = useRef<HTMLDivElement>(null)

  const close = (): void => setOpen(false)
  // Esc to close, focus trap inside, restore focus on close. Only wires
  // when `open` is true — toggling re-runs the effect cleanly.
  useDialog(dialogRef, close)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[58] flex items-center justify-center bg-black/65 p-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Quick reference"
            className="glass flex max-h-full w-full max-w-[420px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Keyboard size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                Quick reference
              </h2>
              <button
                type="button"
                onClick={close}
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="scrollbar-void flex-1 space-y-4 overflow-y-auto p-4 text-[11px] leading-relaxed text-slate-300">
              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  <Keyboard size={11} className="text-[var(--accent)]" />
                  Shortcuts
                </h3>
                <ul className="space-y-1">
                  {SHORTCUTS.map((s) => (
                    <li key={s.keys} className="flex items-center justify-between gap-2">
                      <span>{s.desc}</span>
                      <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">
                        {s.keys}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>

              {SECTIONS.map(({ icon: Icon, title, body }) => (
                <section key={title}>
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                    <Icon size={11} className="text-[var(--accent)]" />
                    {title}
                  </h3>
                  <div className="text-slate-300">{body}</div>
                </section>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => void vs.system.openDataFolder()}
                className="flex items-center gap-1.5 text-[10px] text-slate-400 transition hover:text-white"
              >
                <FolderOpen size={11} />
                Open data folder
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
              >
                Got it
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
