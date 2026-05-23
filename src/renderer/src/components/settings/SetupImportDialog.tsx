/**
 * Selective-import modal for MCP servers detected on the user's machine.
 *
 * Two callsites in `McpSettings`:
 *   · "Import from Claude Desktop" → opens this with source='claude-desktop'
 *   · "Import from Cursor"         → opens this with source='cursor'
 *
 * Lifecycle:
 *  1. Open → call `vs.setup.detect()` and pull the right source's servers.
 *     Cross-reference with VoidSoul's installed-server names so already-
 *     imported ones render as a non-checkable "✓ Already imported" row.
 *  2. User ticks the entries they want, hits Import.
 *  3. We call `vs.setup.importClaudeServers(names)` (or cursor variant) and
 *     swap to the success state — "3 imported, 2 skipped, 1 failed" with
 *     per-failure detail rows so the user can see exactly what didn't work.
 *  4. Done button closes + tells the parent to refresh its server list.
 *
 * Why not pull in MutableObserver / live re-detection: detection is cheap
 * (<50 ms) and happens once per dialog-open. If the user externally edits
 * their Claude Desktop config while this dialog is open, they can just
 * close + reopen. Simpler than wiring file-watchers across the boundary.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Puzzle,
  Sparkles,
  X
} from 'lucide-react'
import { useDialog } from '../../lib/useDialog'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import type { DetectedMcpServer, SetupImportResult } from '@shared/types'

export type ImportSource = 'claude-desktop' | 'cursor'

const SOURCE_LABEL: Record<ImportSource, string> = {
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor'
}

interface SetupImportDialogProps {
  source: ImportSource | null
  onClose: () => void
  /** Called after a successful import so the parent can refresh its
   *  server list (the newly-imported servers are connecting in the
   *  background and their tools will appear within seconds). */
  onImported: () => void
  /** Names of MCP servers VoidSoul already has — used to mark "Already
   *  imported" rows so the user doesn't double-import. */
  installedNames: ReadonlySet<string>
}

type Phase = 'loading' | 'picking' | 'importing' | 'done'

export function SetupImportDialog({
  source,
  onClose,
  onImported,
  installedNames
}: SetupImportDialogProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [servers, setServers] = useState<DetectedMcpServer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<SetupImportResult | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)
  // Tracks "is the dialog still alive" so an in-flight import IPC that
  // resolves AFTER the user closed the dialog doesn't fire setState on
  // an unmounted component. Bumped on each open/close cycle.
  const aliveRef = useRef(true)

  const open = source !== null

  // Re-run detection every time the dialog opens. Cheap (<50ms) and means
  // the user's view always matches what's actually on disk right now,
  // even if they edited the source config externally between opens.
  useEffect(() => {
    if (!open || !source) {
      // Closed → mark not-alive so any in-flight submit IPC bails on its
      // setState calls when it eventually resolves.
      aliveRef.current = false
      return
    }
    aliveRef.current = true
    let cancelled = false
    setPhase('loading')
    setServers([])
    setSelected(new Set())
    setResult(null)
    void vs.setup.detect().then((report) => {
      if (cancelled) return
      const list =
        source === 'claude-desktop' ? report.claudeDesktop.mcpServers : report.cursor.mcpServers
      setServers(list)
      // Pre-select everything that's NOT already installed — the user's
      // most common intent is "import everything that's new". They can
      // untick individual rows before hitting Import.
      const preselected = new Set(
        list.filter((s) => !installedNames.has(s.name)).map((s) => s.name)
      )
      setSelected(preselected)
      setPhase('picking')
    })
    return () => {
      cancelled = true
    }
  }, [open, source, installedNames])

  const toggle = (name: string): void => {
    if (installedNames.has(name)) return // can't pick already-imported
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const importableCount = useMemo(
    () => servers.filter((s) => !installedNames.has(s.name)).length,
    [servers, installedNames]
  )
  const allImportable = useMemo(
    () => servers.filter((s) => !installedNames.has(s.name)).map((s) => s.name),
    [servers, installedNames]
  )
  const allSelected = importableCount > 0 && allImportable.every((n) => selected.has(n))

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(allImportable))
  }

  const submit = async (): Promise<void> => {
    if (!source || selected.size === 0) return
    setPhase('importing')
    const names = [...selected]
    const fn =
      source === 'claude-desktop' ? vs.setup.importClaudeServers : vs.setup.importCursorServers
    const res = await fn(names)
    // Dialog may have been closed mid-import — bail before setState fires
    // on an unmounted component. The import itself still committed to disk
    // (we don't cancel the IPC), and onImported() fires below so the
    // parent's server list refreshes correctly either way.
    if (!aliveRef.current) {
      if (res.imported > 0) onImported()
      return
    }
    setResult(res)
    setPhase('done')
    if (res.imported > 0) onImported()
  }

  const sourceLabel = source ? SOURCE_LABEL[source] : ''

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[55] flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Import MCP servers from ${sourceLabel}`}
            className="glass flex max-h-[80vh] w-full max-w-[440px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Sparkles size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                Import from {sourceLabel}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {phase === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-slate-400">
                  <Loader2 size={13} className="animate-spin" />
                  Scanning {sourceLabel}…
                </div>
              )}

              {(phase === 'picking' || phase === 'importing') && (
                <>
                  {servers.length === 0 ? (
                    <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-4 text-center text-[11px] text-slate-400">
                      No MCP servers configured in {sourceLabel} yet.
                    </p>
                  ) : (
                    <>
                      {/* Select-all bar. Hidden when 0 servers are
                          importable — selecting nothing is a no-op then. */}
                      {importableCount > 0 && (
                        <div className="mb-2 flex items-center justify-between text-[10px] text-slate-400">
                          <span>
                            {servers.length} found · {importableCount} importable
                          </span>
                          <button
                            type="button"
                            onClick={toggleAll}
                            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent)] transition hover:bg-[var(--accent-soft)]"
                          >
                            {allSelected ? 'Deselect all' : 'Select all'}
                          </button>
                        </div>
                      )}
                      <ul className="space-y-1.5">
                        {servers.map((server) => (
                          <ServerRow
                            key={server.name}
                            server={server}
                            checked={selected.has(server.name)}
                            alreadyInstalled={installedNames.has(server.name)}
                            disabled={phase === 'importing'}
                            onToggle={() => toggle(server.name)}
                          />
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}

              {phase === 'done' && result && <ResultSummary result={result} />}
            </div>

            <div className="flex gap-2 border-t border-white/10 px-4 py-3">
              {phase === 'done' ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110"
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={phase === 'importing'}
                    className="flex-1 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={phase !== 'picking' || selected.size === 0}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                  >
                    {phase === 'importing' ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Importing…
                      </>
                    ) : (
                      <>
                        <Download size={12} />
                        Import {selected.size > 0 ? `${selected.size} ` : ''}server
                        {selected.size === 1 ? '' : 's'}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ----------------------------- subcomponents -------------------------- */

function ServerRow({
  server,
  checked,
  alreadyInstalled,
  disabled,
  onToggle
}: {
  server: DetectedMcpServer
  checked: boolean
  alreadyInstalled: boolean
  disabled: boolean
  onToggle: () => void
}): JSX.Element {
  const commandPreview = `${server.command} ${server.args.join(' ')}`.trim()
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        disabled={alreadyInstalled || disabled}
        className={cn(
          'flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition',
          alreadyInstalled
            ? 'cursor-default border-emerald-500/30 bg-emerald-500/10'
            : checked
              ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
              : 'border-white/10 bg-black/30 hover:border-white/20'
        )}
      >
        {/* Checkbox or "already imported" indicator. */}
        <span
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
            alreadyInstalled
              ? 'border-emerald-400 bg-emerald-500/40 text-white'
              : checked
                ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                : 'border-white/30'
          )}
        >
          {(alreadyInstalled || checked) && <Check size={10} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Puzzle size={11} className="shrink-0 text-[var(--accent)]" />
            <p className="truncate text-[11px] font-semibold text-white">{server.name}</p>
            {alreadyInstalled && (
              <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-emerald-300">
                Already imported
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">{commandPreview}</p>
          {server.missingEnv.length > 0 && !alreadyInstalled && (
            <p className="mt-1 flex items-start gap-1 text-[9px] text-amber-300">
              <AlertCircle size={9} className="mt-0.5 shrink-0" />
              <span>
                Will need {server.missingEnv.join(', ')} after import —
                edit the server in Settings → MCP to paste the value.
              </span>
            </p>
          )}
        </div>
      </button>
    </li>
  )
}

function ResultSummary({ result }: { result: SetupImportResult }): JSX.Element {
  const totalActioned = result.imported + result.skipped + result.failures.length
  const allOk = result.failures.length === 0
  return (
    <div className="space-y-2">
      <div
        className={cn(
          'rounded-lg border px-3 py-2.5',
          allOk
            ? 'border-emerald-500/30 bg-emerald-500/10'
            : 'border-amber-500/30 bg-amber-500/10'
        )}
      >
        <p className="text-[12px] font-semibold text-white">
          {result.imported > 0
            ? `Imported ${result.imported} server${result.imported === 1 ? '' : 's'}`
            : 'Nothing imported'}
          {result.skipped > 0 && (
            <span className="text-slate-400">
              {' '}
              · {result.skipped} already installed
            </span>
          )}
        </p>
        {result.imported > 0 && (
          <p className="mt-0.5 text-[10px] text-slate-400">
            New servers connect in the background — give them a few seconds, their tools will
            appear in the list.
          </p>
        )}
        {totalActioned === 0 && (
          <p className="mt-0.5 text-[10px] text-slate-400">No items were selected.</p>
        )}
      </div>
      {result.failures.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {result.failures.length} failed
          </p>
          {result.failures.map((f) => (
            <div
              key={f.name}
              className="flex items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-200"
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">{f.name}</p>
                <p className="text-rose-200/80">{f.reason}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
