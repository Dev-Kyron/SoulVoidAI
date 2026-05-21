/**
 * Modal for creating a custom Nexus quick action — opened by the "+" node on
 * the HUD circle. Launches an app, opens a website or a folder.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Box, Folder, Globe, Plus, X } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useDialog } from '../../lib/useDialog'
import { cn } from '../../lib/utils'
import type { CustomActionKind } from '@shared/types'

const KINDS: Array<{ id: CustomActionKind; label: string; icon: typeof Box; placeholder: string }> = [
  { id: 'app', label: 'App', icon: Box, placeholder: 'App name or path' },
  { id: 'url', label: 'Website', icon: Globe, placeholder: 'https://…' },
  { id: 'folder', label: 'Folder', icon: Folder, placeholder: 'Folder path or ~downloads' }
]

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[12px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

export function AddActionDialog(): JSX.Element {
  const open = useUiStore((s) => s.addActionOpen)
  const setOpen = useUiStore((s) => s.setAddActionOpen)
  const addAction = useMemoryStore((s) => s.addAction)
  const actions = useMemoryStore((s) => s.data?.customActions ?? [])
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<CustomActionKind>('app')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, () => setOpen(false))

  const full = actions.length >= 8

  useEffect(() => {
    if (open) {
      setLabel('')
      setKind('app')
      setTarget('')
      setBusy(false)
    }
  }, [open])

  const close = (): void => setOpen(false)

  const submit = async (): Promise<void> => {
    if (full || busy || !label.trim() || !target.trim()) return
    setBusy(true)
    await addAction(label.trim(), kind, target.trim())
    close()
  }

  const placeholder = KINDS.find((k) => k.id === kind)?.placeholder ?? ''

  return (
    <AnimatePresence>
      {open && (
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
            aria-label="New Nexus action"
            className="glass w-full max-w-[320px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Plus size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                New Nexus Action
              </h2>
              <button
                type="button"
                onClick={close}
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3 p-4">
              {full ? (
                <p className="text-[11px] text-amber-400">
                  The Nexus circle is full (8 actions). Remove one in Settings → Memory first.
                </p>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-[9px] uppercase tracking-wider text-slate-500">
                      Name
                    </label>
                    <input
                      autoFocus
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Action name"
                      className={FIELD}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[9px] uppercase tracking-wider text-slate-500">
                      Type
                    </label>
                    <div className="flex gap-1.5">
                      {KINDS.map((k) => {
                        const Icon = k.icon
                        const active = k.id === kind
                        return (
                          <button
                            key={k.id}
                            type="button"
                            onClick={() => setKind(k.id)}
                            className={cn(
                              'flex flex-1 flex-col items-center gap-1 rounded-lg border py-2 text-[10px] font-medium transition',
                              active
                                ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-white'
                                : 'border-white/10 bg-black/20 text-slate-400 hover:bg-white/5'
                            )}
                          >
                            <Icon size={14} />
                            {k.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-[9px] uppercase tracking-wider text-slate-500">
                      Target
                    </label>
                    <input
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submit()
                      }}
                      placeholder={placeholder}
                      className={FIELD}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={close}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5"
              >
                {full ? 'Close' : 'Cancel'}
              </button>
              {!full && (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || !label.trim() || !target.trim()}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                >
                  <Plus size={13} />
                  Add to Nexus
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
