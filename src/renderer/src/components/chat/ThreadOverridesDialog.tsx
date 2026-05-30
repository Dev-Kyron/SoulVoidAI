/**
 * Per-thread overrides dialog. Lets the user pin a specific mode + a custom
 * system prompt to the active thread — overriding the global config for that
 * conversation only. Both fields can be cleared independently to fall back
 * to the global defaults.
 *
 * Surfaces from the small mode pill in the ChatView header.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Sliders, RotateCcw, Plus } from 'lucide-react'
import { MODES } from '@shared/modes'
import { useChatStore } from '../../store/useChatStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { useProjectsStore } from '../../store/useProjectsStore'
import { cn } from '../../lib/utils'
import { useDialog } from '../../lib/useDialog'
import type { ModeId, ThreadSummary } from '@shared/types'

interface ThreadOverridesDialogProps {
  thread: ThreadSummary | null
  open: boolean
  onClose: () => void
}

export function ThreadOverridesDialog({
  thread,
  open,
  onClose
}: ThreadOverridesDialogProps): JSX.Element {
  const globalMode = useConfigStore((s) => s.config?.activeMode ?? 'indie-dev')
  const globalPrompt = useConfigStore((s) => s.config?.systemPrompt ?? '')
  const setThreadMode = useChatStore((s) => s.setThreadMode)
  const setThreadSystemPrompt = useChatStore((s) => s.setThreadSystemPrompt)
  const pushToast = useUiStore((s) => s.pushToast)
  const projects = useProjectsStore((s) => s.projects)
  const createProject = useProjectsStore((s) => s.create)
  const setThreadProject = useProjectsStore((s) => s.setThreadProject)
  const [draft, setDraft] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)

  useEffect(() => {
    if (open && thread) setDraft(thread.pinnedSystemPrompt ?? '')
  }, [open, thread])

  if (!thread) return <AnimatePresence />

  const pinnedMode = thread.pinnedMode ?? null
  const effectiveMode = pinnedMode ?? globalMode
  const promptDirty = draft.trim() !== (thread.pinnedSystemPrompt ?? '').trim()
  const hasPromptOverride = Boolean(thread.pinnedSystemPrompt)

  const pickMode = async (mode: ModeId | null): Promise<void> => {
    await setThreadMode(thread.id, mode)
    pushToast(
      'info',
      mode === null
        ? 'Thread mode reset to global default.'
        : `Pinned ${MODES.find((m) => m.id === mode)?.name ?? mode} to this thread.`
    )
  }

  const savePrompt = async (): Promise<void> => {
    const trimmed = draft.trim()
    await setThreadSystemPrompt(thread.id, trimmed || null)
    pushToast('success', trimmed ? 'Per-thread system prompt saved.' : 'Per-thread prompt cleared.')
  }

  const resetPrompt = async (): Promise<void> => {
    setDraft('')
    await setThreadSystemPrompt(thread.id, null)
    pushToast('info', 'Per-thread prompt reset to global.')
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[58] flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Thread overrides"
            className="glass w-full max-w-[420px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Sliders size={15} className="text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-[13px] font-semibold text-white">
                  This thread's overrides
                </h2>
                <p className="truncate text-[10px] text-slate-500">{thread.title}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3 p-4">
              {/* Project picker — drops the thread into a Project so its
                  shared instructions apply on top of the global prompt. */}
              <div>
                <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                  Project
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => void setThreadProject(thread.id, null)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[10px] font-medium transition',
                      !thread.projectId
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                    )}
                  >
                    No project
                  </button>
                  {projects.map((p) => {
                    const active = thread.projectId === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => void setThreadProject(thread.id, p.id)}
                        className={cn(
                          'rounded-md px-2 py-0.5 text-[10px] font-medium transition',
                          active
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                        )}
                        title={p.instructions ?? p.description ?? p.name}
                      >
                        {p.name}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={async () => {
                      const name = window.prompt('Project name')
                      if (!name || !name.trim()) return
                      const instructions =
                        window.prompt(
                          "Project instructions (appended to every thread's system prompt). Leave blank to skip."
                        ) ?? ''
                      const project = await createProject({
                        name: name.trim(),
                        instructions: instructions.trim() || null
                      })
                      await setThreadProject(thread.id, project.id)
                      pushToast('success', `Project "${project.name}" created.`)
                    }}
                    className="flex items-center gap-1 rounded-md border border-dashed border-white/10 px-2 py-0.5 text-[10px] text-slate-400 transition hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
                  >
                    <Plus size={9} />
                    New project
                  </button>
                </div>
                {thread.projectId && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                    {(() => {
                      const project = projects.find((p) => p.id === thread.projectId)
                      if (!project) return null
                      return project.instructions
                        ? `Shared instructions: ${project.instructions.slice(0, 140)}${project.instructions.length > 140 ? '…' : ''}`
                        : "No shared instructions — using this thread's baseline only."
                    })()}
                  </p>
                )}
              </div>

              {/* Mode picker */}
              <div>
                <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                  Mode for this thread
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => void pickMode(null)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[10px] font-medium transition',
                      pinnedMode === null
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                    )}
                    title="Follow whatever mode is global"
                  >
                    Use global · {MODES.find((m) => m.id === globalMode)?.name ?? globalMode}
                  </button>
                  {MODES.map((mode) => {
                    const active = pinnedMode === mode.id
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => void pickMode(mode.id)}
                        className={cn(
                          'rounded-md px-2 py-0.5 text-[10px] font-medium transition',
                          active
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                        )}
                      >
                        {mode.name}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                  Currently using:{' '}
                  <span className="text-slate-300">
                    {MODES.find((m) => m.id === effectiveMode)?.name ?? effectiveMode}
                  </span>
                  {pinnedMode === null && ' (global)'}
                </p>
              </div>

              {/* System prompt override */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                    System prompt override
                  </p>
                  {hasPromptOverride && (
                    <button
                      type="button"
                      onClick={() => void resetPrompt()}
                      className="flex items-center gap-1 text-[9px] text-slate-400 transition hover:text-rose-300"
                    >
                      <RotateCcw size={9} />
                      Reset to global
                    </button>
                  )}
                </div>
                <textarea
                  value={draft}
                  rows={5}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    hasPromptOverride
                      ? ''
                      : `Leave blank to follow the global prompt:\n\n${globalPrompt.slice(0, 200)}${globalPrompt.length > 200 ? '…' : ''}`
                  }
                  className="scrollbar-void w-full resize-none rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] leading-relaxed text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Replaces the global baseline for this thread only. The mode prompt fragment still
                  appends on top.
                </p>
                {promptDirty && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void savePrompt()}
                      className="rounded-md bg-[var(--accent)] px-3 py-1 text-[10px] font-semibold text-white transition hover:brightness-110"
                    >
                      Save prompt
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft(thread.pinnedSystemPrompt ?? '')}
                      className="rounded-md border border-white/10 px-3 py-1 text-[10px] text-slate-300 transition hover:bg-white/5"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
