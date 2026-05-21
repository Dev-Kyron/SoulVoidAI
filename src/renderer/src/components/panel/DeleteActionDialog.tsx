/**
 * Confirmation modal for removing a custom quick action from the Nexus panel.
 * Opened by the delete badge on a custom action's node or app tile.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Trash2, X } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useDialog } from '../../lib/useDialog'

export function DeleteActionDialog(): JSX.Element {
  const target = useUiStore((s) => s.actionToDelete)
  const setTarget = useUiStore((s) => s.setActionToDelete)
  const removeAction = useMemoryStore((s) => s.removeAction)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, () => setTarget(null))

  useEffect(() => {
    if (target) setBusy(false)
  }, [target])

  const close = (): void => setTarget(null)

  const confirm = async (): Promise<void> => {
    if (!target || busy) return
    setBusy(true)
    await removeAction(target.id)
    setTarget(null)
  }

  return (
    <AnimatePresence>
      {target && (
        <motion.div
          className="absolute inset-0 z-[55] flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Remove action"
            className="glass w-full max-w-[300px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Trash2 size={15} className="text-rose-400" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                Remove action
              </h2>
              <button
                type="button"
                onClick={close}
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="p-4">
              <p className="text-[12px] leading-relaxed text-slate-300">
                Remove <span className="font-semibold text-white">{target.label}</span> from the
                Nexus panel? You can add it again any time.
              </p>
            </div>

            <div className="flex gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={close}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-rose-500 py-2 text-[11px] font-semibold text-white transition hover:bg-rose-400 disabled:opacity-40"
              >
                <Trash2 size={13} />
                Remove
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
