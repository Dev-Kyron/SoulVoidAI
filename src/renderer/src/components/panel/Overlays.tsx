/**
 * Floating overlays rendered above the panel: transient toast notifications
 * and the modal permission-approval dialog.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Check, X, Info, AlertTriangle, Undo2, ShieldQuestion } from 'lucide-react'
import { useUiStore, type ToastKind } from '../../store/useUiStore'
import { undoAction } from '../../lib/actions'
import { PERMISSIONS } from '@shared/permissions'
import { cn } from '../../lib/utils'

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
  const resolve = useUiStore((s) => s.resolvePermission)
  const definition = prompt ? PERMISSIONS.find((p) => p.id === prompt.permission) : null

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
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => resolve(false)}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[12px] font-medium text-slate-300 transition hover:bg-white/5"
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

export function Overlays(): JSX.Element {
  return (
    <>
      <ToastHost />
      <PermissionDialog />
    </>
  )
}
