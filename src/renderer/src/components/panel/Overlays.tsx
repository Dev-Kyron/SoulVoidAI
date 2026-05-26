/**
 * Floating overlays rendered above the panel: transient toast notifications
 * and the modal permission-approval dialog.
 */
import { Suspense, lazy, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  X,
  Info,
  AlertTriangle,
  Undo2,
  ShieldQuestion,
  TerminalSquare,
  FilePlus,
  FileEdit
} from 'lucide-react'
import { useUiStore, type ToastKind } from '../../store/useUiStore'
import { undoAction } from '../../lib/actions'
import { PERMISSIONS } from '@shared/permissions'
import { cn } from '../../lib/utils'

// Lazy-loaded — the review dialog mounts at most once per beta tester's
// lifetime, so there's no reason to weigh down the initial bundle with it.
// The boundary only fetches when `reviewDialogOpen` flips true.
const ReviewDialog = lazy(() =>
  import('../settings/ReviewDialog').then((m) => ({ default: m.ReviewDialog }))
)

const TOAST_STYLE: Record<ToastKind, string> = {
  success: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  error: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
  info: 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-slate-100'
}

function ToastIcon({ kind }: { kind: ToastKind }): JSX.Element {
  if (kind === 'success') return <Check size={14} />
  if (kind === 'error') return <AlertTriangle size={14} />
  return <Info size={14} />
}

function ToastHost(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-40 flex flex-col gap-1.5">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className={cn(
              'pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] shadow-panel backdrop-blur',
              TOAST_STYLE[toast.kind]
            )}
          >
            <ToastIcon kind={toast.kind} />
            <span className="flex-1 break-words">{toast.message}</span>
            {toast.undoId && (
              <button
                type="button"
                onClick={() => {
                  void undoAction(toast.undoId as string)
                  dismiss(toast.id)
                }}
                className="flex items-center gap-1 rounded-md bg-white/15 px-1.5 py-0.5 font-semibold transition hover:bg-white/25"
              >
                <Undo2 size={11} />
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="rounded p-0.5 opacity-60 transition hover:opacity-100"
            >
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function PermissionDialog(): JSX.Element {
  const prompt = useUiStore((s) => s.permissionPrompt)
  const queueLength = useUiStore((s) => s.permissionQueue.length)
  const resolve = useUiStore((s) => s.resolvePermission)
  const definition = prompt ? PERMISSIONS.find((p) => p.id === prompt.permission) : null
  const denyRef = useRef<HTMLButtonElement>(null)

  // v1.12.3 — Escape key denies. Default-safe: a panicked user mashing Esc
  // gets the safer outcome (no new permission granted) rather than nothing
  // happening. Also focus Deny on open so the same is true for Enter key.
  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolve(false)
      }
    }
    window.addEventListener('keydown', onKey)
    denyRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, resolve])

  return (
    <AnimatePresence>
      {prompt && definition && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Permission required"
            className="glass w-full rounded-2xl p-4 shadow-panel"
            initial={{ scale: 0.92, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0 }}
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
              <ShieldQuestion size={22} />
            </div>
            <h3 className="text-sm font-semibold text-white">Permission required</h3>
            <p className="mt-1.5 text-[12px] text-slate-300">
              <span className="font-semibold text-white">{prompt.actionLabel}</span> needs the{' '}
              <span className="font-semibold text-[var(--accent)]">{definition.label}</span>{' '}
              permission.
            </p>
            <p className="mt-1.5 rounded-lg bg-black/30 px-2.5 py-2 text-[11px] text-slate-400">
              {definition.description}
            </p>
            <p className="mt-2 text-[10px] text-slate-500">
              You can revoke this at any time from Settings → Permissions.
              {queueLength > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-300">
                    {queueLength} more request{queueLength === 1 ? '' : 's'} queued
                  </span>
                </>
              )}
              {' · Esc to deny'}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                ref={denyRef}
                type="button"
                onClick={() => resolve(false)}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[12px] font-medium text-slate-300 transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/20"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => resolve(true)}
                className="flex-1 rounded-lg bg-[var(--accent)] py-2 text-[12px] font-semibold text-white transition hover:brightness-110"
              >
                Grant permission
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * v1.12.3 — Per-command shell approval modal. Fires BEFORE every `run_shell`
 * call (even when `terminal` permission is already granted) so a runaway
 * agent can't silently `rm -rf` once the user grants the broad terminal
 * permission. The previous gate was too coarse: terminal granted → all
 * commands flow. Now the user sees and approves each command, with the
 * full text + working directory visible so a malicious or hallucinated
 * command is obvious before it runs.
 *
 * Default focus is Cancel; Escape cancels; the command renders in monospace
 * so subtle character substitutions (e.g., a homoglyph in a path) are
 * easier to spot.
 */
function ShellApprovalDialog(): JSX.Element {
  const prompt = useUiStore((s) => s.shellApproval)
  const queueLength = useUiStore((s) => s.shellApprovalQueue.length)
  const resolve = useUiStore((s) => s.resolveShellApproval)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolve(false)
      }
    }
    window.addEventListener('keydown', onKey)
    cancelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, resolve])

  return (
    <AnimatePresence>
      {prompt && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Shell command approval"
            className="glass w-full max-w-md rounded-2xl p-4 shadow-panel"
            initial={{ scale: 0.92, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0 }}
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300">
              <TerminalSquare size={22} />
            </div>
            <h3 className="text-sm font-semibold text-white">Run shell command?</h3>
            <p className="mt-1.5 text-[12px] text-slate-300">
              The agent wants to run this command. Review carefully — shell
              commands can modify or delete files, install software, or change
              system settings.
            </p>
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-black/50 px-2.5 py-2 font-mono text-[11px] text-amber-200">
              {prompt.command}
            </pre>
            {prompt.cwd && (
              <p className="mt-1.5 truncate text-[10px] text-slate-500">
                in <span className="font-mono text-slate-400">{prompt.cwd}</span>
              </p>
            )}
            <p className="mt-2 text-[10px] text-slate-500">
              Esc to cancel
              {queueLength > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-300">
                    {queueLength} more command{queueLength === 1 ? '' : 's'} queued
                  </span>
                </>
              )}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => resolve(false)}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[12px] font-medium text-slate-300 transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resolve(true)}
                className="flex-1 rounded-lg bg-rose-500/80 py-2 text-[12px] font-semibold text-white transition hover:bg-rose-500"
              >
                Run command
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * v1.13.0 — `write_file` approval modal. Renders BEFORE the write so the
 * user reviews a unified diff (existing file) or full-content preview
 * (new file) and clicks Apply or Cancel. This is the "feels like
 * Claude / Cursor" piece for agent-driven edits — previously write_file
 * would silently overwrite and surface as a one-line "Wrote 1234
 * characters to..." line in the bubble.
 *
 * Diff is computed in `actions.ts` (renderer) using the `diff` package
 * before the dialog opens, so this component is purely a renderer for
 * pre-formatted unified-diff text. Lines starting with `+` are added
 * (emerald), `-` are removed (rose), `@@` are hunk headers (slate), the
 * rest are context.
 */
function WriteApprovalDialog(): JSX.Element {
  const prompt = useUiStore((s) => s.writeApproval)
  const queueLength = useUiStore((s) => s.writeApprovalQueue.length)
  const resolve = useUiStore((s) => s.resolveWriteApproval)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolve(false)
      }
    }
    window.addEventListener('keydown', onKey)
    cancelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, resolve])

  if (!prompt) {
    return (
      <AnimatePresence>{/* nothing */}</AnimatePresence>
    )
  }

  const isNewFile = prompt.previousContent === null
  const Icon = isNewFile ? FilePlus : FileEdit
  // For new files the unified diff just shows the whole new content
  // prefixed with `+ ` per line. We render the same colourised view.
  const diffLines = prompt.unifiedDiff.split('\n')
  // Stats — counting +/- lines lets the user judge change size at a
  // glance. Skip the file-header lines ("+++", "---") which would
  // double-count as additions/removals otherwise.
  const additions = diffLines.filter(
    (l) => l.startsWith('+') && !l.startsWith('+++')
  ).length
  const removals = diffLines.filter(
    (l) => l.startsWith('-') && !l.startsWith('---')
  ).length

  return (
    <AnimatePresence>
      <motion.div
        className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 p-5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="File write approval"
          className="glass flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl p-4 shadow-panel"
          initial={{ scale: 0.92, y: 12 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.92, opacity: 0 }}
        >
          <div className="mb-3 flex items-start gap-3">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
                isNewFile
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-[var(--accent-soft)] text-[var(--accent)]'
              )}
            >
              <Icon size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-white">
                {isNewFile ? 'Create new file?' : 'Apply changes to file?'}
              </h3>
              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400" title={prompt.path}>
                {prompt.path}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">
                <span className="text-emerald-400">+{additions}</span>{' '}
                <span className="text-rose-400">−{removals}</span> · Esc to cancel
                {queueLength > 0 && (
                  <>
                    {' · '}
                    <span className="text-amber-300">
                      {queueLength} more write{queueLength === 1 ? '' : 's'} queued
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>
          {/* Diff body — pre-formatted, scrollable, monospace. Each line
            * styled by leading marker so a quick scan reads as a normal
            * unified diff. Max-h-[55vh] keeps the dialog itself bounded. */}
          <pre className="scrollbar-void flex-1 overflow-auto rounded-lg bg-black/50 px-2 py-2 font-mono text-[11px] leading-snug">
            {diffLines.map((line, i) => {
              const marker = line[0]
              const cls =
                line.startsWith('+++') || line.startsWith('---')
                  ? 'text-slate-500'
                  : line.startsWith('@@')
                    ? 'text-cyan-300'
                    : marker === '+'
                      ? 'text-emerald-300'
                      : marker === '-'
                        ? 'text-rose-300'
                        : 'text-slate-300'
              return (
                <div key={i} className={cn('whitespace-pre-wrap break-words', cls)}>
                  {line || ' '}
                </div>
              )
            })}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={() => resolve(false)}
              className="flex-1 rounded-lg border border-white/10 py-2 text-[12px] font-medium text-slate-300 transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/20"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => resolve(true)}
              className={cn(
                'flex-1 rounded-lg py-2 text-[12px] font-semibold text-white transition',
                isNewFile
                  ? 'bg-emerald-500/80 hover:bg-emerald-500'
                  : 'bg-[var(--accent)] hover:brightness-110'
              )}
            >
              {isNewFile ? 'Create file' : 'Apply changes'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export function Overlays(): JSX.Element {
  // Gate the lazy import on the open flag so the chunk only loads when the
  // user actually opens the dialog — not on every app launch.
  const reviewOpen = useUiStore((s) => s.reviewDialogOpen)

  // v1.12.5 — on window close / renderer reload, deny + flush every
  // pending prompt so awaiting agent code can unwind cleanly. Without
  // this, a renderer reload during HMR could leave a stale promise
  // referenced by the old agent loop. Beforeunload fires synchronously
  // in Electron renderers before the JS context tears down, so we have
  // time to walk the queues and resolve(false) on each. The cleanup
  // runs once per Overlays mount — both panel and Settings host this
  // component, so either window's close triggers the flush.
  useEffect(() => {
    const cancelAll = (): void => {
      useUiStore.getState().cancelAllPrompts()
    }
    window.addEventListener('beforeunload', cancelAll)
    return () => window.removeEventListener('beforeunload', cancelAll)
  }, [])

  return (
    <>
      <ToastHost />
      <PermissionDialog />
      <ShellApprovalDialog />
      <WriteApprovalDialog />
      {reviewOpen && (
        <Suspense fallback={null}>
          <ReviewDialog />
        </Suspense>
      )}
    </>
  )
}
