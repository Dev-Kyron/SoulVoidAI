/**
 * First-run discovery panel — the "we took a look around your machine"
 * magic-moment UX. Mirrors `SetupImportDialog` (Phase 3) in that it lists
 * detected MCP servers + env API keys + local providers and lets the user
 * pick what to import, but presents the full report at once across all
 * sources, with a single "Import everything" CTA built for first-launch.
 *
 * Lifecycle:
 *  1. Open → call `vs.setup.detect()` once.
 *  2. If the report has anything importable, render the checklist with
 *     everything pre-selected (most common intent is "yes, import it all").
 *  3. If the report is empty, render a friendly "no existing AI tools
 *     found, here's how to set one up" panel instead — the same component
 *     either way, so manual re-runs from About work in either state.
 *  4. User hits "Import everything" → orchestrator runs each section's
 *     import IPC in sequence, aggregating results.
 *  5. Success state shows what landed, single "Start chatting" CTA closes
 *     the panel and lands the user back in the chat.
 *
 * Non-blocking by design: a "Skip for now" link in the corner lets users
 * opt out of the magic moment without losing access to their existing
 * config flow. The panel marks the user as `onboarded: true` either way
 * so it doesn't show up again on next launch.
 */
import { useEffect, useRef, useState } from 'react'
import { useDialog } from '../../lib/useDialog'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Brain,
  Check,
  KeyRound,
  Loader2,
  MessageSquareText,
  Puzzle,
  Server,
  Sparkles,
  X
} from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useConfigStore } from '../../store/useConfigStore'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import type {
  DetectedEnvKey,
  DetectedLocalProvider,
  DetectedMcpServer,
  SetupReport
} from '@shared/types'

type Phase = 'loading' | 'review' | 'importing' | 'done'

/* ---------------------------- selection state -------------------------- */

/**
 * Which detected items the user has ticked. Names for MCP rows (unique
 * per source), provider ids for env-key rows. Local providers don't
 * appear in selection — they're already auto-connected and listed
 * informationally.
 */
interface Selection {
  claude: Set<string>
  cursor: Set<string>
  envKeys: Set<string> // provider ids
}

function makeSelection(report: SetupReport | null): Selection {
  if (!report) return { claude: new Set(), cursor: new Set(), envKeys: new Set() }
  // Pre-select everything by default — the user's overwhelming intent on
  // a clean install is "import all the things." They can untick individual
  // rows before clicking Import.
  return {
    claude: new Set(report.claudeDesktop.mcpServers.map((s) => s.name)),
    cursor: new Set(report.cursor.mcpServers.map((s) => s.name)),
    envKeys: new Set(report.envKeys.map((k) => k.providerId))
  }
}

/* ----------------------------- orchestrator --------------------------- */

interface ImportSummary {
  mcpImported: number
  mcpSkipped: number
  mcpFailures: { name: string; reason: string }[]
  keysImported: number
  keyFailures: { providerId: string; reason: string }[]
}

/**
 * Run all selected imports in sequence. MCP servers go in two batches
 * (one per source) so the user sees a single per-source result they can
 * map back to the original Claude / Cursor surface. Env keys go one by
 * one because each is its own IPC + own success/failure outcome.
 */
async function runImportAll(selection: Selection): Promise<ImportSummary> {
  const out: ImportSummary = {
    mcpImported: 0,
    mcpSkipped: 0,
    mcpFailures: [],
    keysImported: 0,
    keyFailures: []
  }

  // The two MCP batches touch different source configs and end with
  // independent addServer calls — safe to parallelise. Env-keys MUST
  // stay sequential below because each setApiKey hits the same store.
  const mcpBatches = await Promise.all([
    selection.claude.size > 0
      ? vs.setup.importClaudeServers([...selection.claude])
      : Promise.resolve({ imported: 0, skipped: 0, failures: [] }),
    selection.cursor.size > 0
      ? vs.setup.importCursorServers([...selection.cursor])
      : Promise.resolve({ imported: 0, skipped: 0, failures: [] })
  ])
  for (const r of mcpBatches) {
    out.mcpImported += r.imported
    out.mcpSkipped += r.skipped
    out.mcpFailures.push(...r.failures)
  }

  // Sequential — each setApiKey writes to the same store. Parallel writes
  // could race on the underlying JsonStore.
  for (const providerId of selection.envKeys) {
    const r = await vs.setup.importEnvKey(providerId as never)
    if (r.success) out.keysImported++
    else out.keyFailures.push({ providerId, reason: r.error ?? 'Unknown' })
  }

  return out
}

/* ------------------------------- panel -------------------------------- */

export function SetupDiscoveryPanel(): JSX.Element {
  const open = useUiStore((s) => s.setupDiscoveryOpen)
  const setOpen = useUiStore((s) => s.setSetupDiscoveryOpen)
  const setOnboarded = useConfigStore((s) => s.setOnboarded)
  const [phase, setPhase] = useState<Phase>('loading')
  const [report, setReport] = useState<SetupReport | null>(null)
  const [selection, setSelection] = useState<Selection>(() => makeSelection(null))
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Tracks "is the panel still on screen" — so an in-flight `runImportAll`
  // that resolves AFTER the user closed the panel doesn't fire setState
  // on an unmounted component. The actual imports still commit to disk;
  // the user just doesn't see the result UI.
  const aliveRef = useRef(true)
  // Wire Esc-to-close + outside-click + focus trap. Same `close()` path
  // the explicit X / Skip buttons use so the onboarded flag is updated
  // consistently regardless of which dismissal route the user takes.
  useDialog(dialogRef, () => close())

  // Fetch the report each time the panel opens — keeps the view honest
  // if the user added something to their Claude Desktop config and
  // re-triggered the panel from About.
  useEffect(() => {
    if (!open) {
      aliveRef.current = false
      return
    }
    aliveRef.current = true
    let cancelled = false
    setPhase('loading')
    setReport(null)
    setSummary(null)
    void vs.setup.detect().then((r) => {
      if (cancelled) return
      setReport(r)
      setSelection(makeSelection(r))
      setPhase('review')
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    // Only flip the `onboarded` flag when the user has actually seen the
    // detection result — closing during the initial scan shouldn't burn
    // the magic-moment for next launch. Loading-phase closes (Esc, X,
    // outside click) leave the flag alone so we'll greet them again.
    if (phase === 'review' || phase === 'done') {
      void setOnboarded(true)
    }
  }

  const totalImportable = report
    ? report.claudeDesktop.mcpServers.length +
      report.cursor.mcpServers.length +
      report.envKeys.length
    : 0

  const totalSelected =
    selection.claude.size + selection.cursor.size + selection.envKeys.size

  const handleImportAll = async (): Promise<void> => {
    setPhase('importing')
    const result = await runImportAll(selection)
    // Panel may have been closed mid-import — bail before setState fires
    // on an unmounted component. Imports already committed to disk; the
    // user just won't see the success summary.
    if (!aliveRef.current) return
    setSummary(result)
    setPhase('done')
  }

  // Toggle helpers — one per section, since the section key tells the
  // helper which set in `selection` to mutate.
  const toggleMcp = (source: 'claude' | 'cursor', name: string): void => {
    setSelection((prev) => {
      const next = new Set(prev[source])
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { ...prev, [source]: next }
    })
  }
  const toggleEnvKey = (providerId: string): void => {
    setSelection((prev) => {
      const next = new Set(prev.envKeys)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return { ...prev, envKeys: next }
    })
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[60] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="VoidSoul setup"
            onClick={(e) => e.stopPropagation()}
            className="glass flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
          >
            {/* Hero header. Slightly taller + more colourful than a normal
                dialog because this is the user's first VoidSoul impression
                — worth the visual weight. */}
            <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[var(--accent-soft)] via-transparent to-transparent px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-white shadow-glow">
                  <Sparkles size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[15px] font-semibold text-white">
                    Welcome to VoidSoul
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-300">
                    {phase === 'done'
                      ? "You're ready to chat."
                      : "We took a look around your machine for AI tools you've already set up."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => close()}
                  title="Skip for now"
                  aria-label="Skip setup"
                  className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {phase === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-slate-400">
                  <Loader2 size={14} className="animate-spin" />
                  Scanning…
                </div>
              )}

              {phase === 'review' && report && (
                <ReviewBody
                  report={report}
                  selection={selection}
                  totalImportable={totalImportable}
                  onToggleMcp={toggleMcp}
                  onToggleEnvKey={toggleEnvKey}
                />
              )}

              {phase === 'importing' && (
                <div className="flex flex-col items-center justify-center gap-3 py-10">
                  <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
                  <p className="text-[12px] text-slate-300">Importing {totalSelected} item
                    {totalSelected === 1 ? '' : 's'}…</p>
                </div>
              )}

              {phase === 'done' && summary && <DoneBody summary={summary} />}
            </div>

            {/* Footer adapts to the phase — review shows Skip + Import; done
                shows Start chatting; loading/importing show nothing
                (everything's busy). */}
            <div className="flex gap-2 border-t border-white/10 px-5 py-3">
              {phase === 'review' && (
                <>
                  <button
                    type="button"
                    onClick={() => close()}
                    className="rounded-lg border border-white/10 px-3 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5"
                  >
                    Skip for now
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleImportAll()}
                    disabled={totalSelected === 0}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                  >
                    <Sparkles size={12} />
                    {totalImportable === 0
                      ? 'Configure manually →'
                      : totalSelected === totalImportable
                        ? `Import everything (${totalSelected})`
                        : `Import ${totalSelected} item${totalSelected === 1 ? '' : 's'}`}
                  </button>
                </>
              )}
              {phase === 'done' && (
                <button
                  type="button"
                  onClick={() => close()}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110"
                >
                  <MessageSquareText size={12} />
                  Start chatting
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------------------------- review body ----------------------------- */

function ReviewBody({
  report,
  selection,
  totalImportable,
  onToggleMcp,
  onToggleEnvKey
}: {
  report: SetupReport
  selection: Selection
  totalImportable: number
  onToggleMcp: (source: 'claude' | 'cursor', name: string) => void
  onToggleEnvKey: (providerId: string) => void
}): JSX.Element {
  if (totalImportable === 0 && report.localProviders.length === 0) {
    // Nothing detected anywhere — the user's machine is clean. Friendly
    // pointer at the manual setup path so the panel never feels like a
    // dead end.
    return (
      <div className="rounded-xl border border-white/10 bg-black/30 p-4">
        <p className="text-[12px] font-semibold text-white">
          No AI tools detected on this machine.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          That&apos;s normal for a fresh setup. The quickest way to get going is to install Ollama
          for a free local model, or paste an API key from any provider in Settings → AI Provider.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {report.claudeDesktop.mcpServers.length > 0 && (
        <Section
          icon={<Server size={13} className="text-[var(--accent)]" />}
          title="Claude Desktop · MCP servers"
          subtitle={`${report.claudeDesktop.mcpServers.length} found in your Claude config.`}
        >
          {report.claudeDesktop.mcpServers.map((server) => (
            <McpRow
              key={`claude-${server.name}`}
              server={server}
              checked={selection.claude.has(server.name)}
              onToggle={() => onToggleMcp('claude', server.name)}
            />
          ))}
        </Section>
      )}

      {report.cursor.mcpServers.length > 0 && (
        <Section
          icon={<Server size={13} className="text-[var(--accent)]" />}
          title="Cursor · MCP servers"
          subtitle={`${report.cursor.mcpServers.length} found in your Cursor config.`}
        >
          {report.cursor.mcpServers.map((server) => (
            <McpRow
              key={`cursor-${server.name}`}
              server={server}
              checked={selection.cursor.has(server.name)}
              onToggle={() => onToggleMcp('cursor', server.name)}
            />
          ))}
        </Section>
      )}

      {report.envKeys.length > 0 && (
        <Section
          icon={<KeyRound size={13} className="text-[var(--accent)]" />}
          title="API keys from your environment"
          subtitle="Detected in your shell env vars. Stored locally + encrypted; never leaves this machine."
        >
          {report.envKeys.map((key) => (
            <EnvKeyRow
              key={key.providerId}
              entry={key}
              checked={selection.envKeys.has(key.providerId)}
              onToggle={() => onToggleEnvKey(key.providerId)}
            />
          ))}
        </Section>
      )}

      {/* Local providers — informational only, not selectable. They're
          already auto-connected via the existing boot-time probe; this
          section just confirms the user that VoidSoul saw them. */}
      {report.localProviders.length > 0 && (
        <Section
          icon={<Brain size={13} className="text-emerald-400" />}
          title="Local providers · already connected"
          subtitle="Auto-detected on boot. No import needed — they're ready to use."
        >
          {report.localProviders.map((p) => (
            <LocalProviderRow key={p.providerId} entry={p} />
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  subtitle,
  children
}: {
  icon: JSX.Element
  title: string
  subtitle: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-2 flex items-start gap-2">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-white">{title}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function McpRow({
  server,
  checked,
  onToggle
}: {
  server: DetectedMcpServer
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition',
        checked
          ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
          : 'border-white/10 bg-black/30 hover:border-white/20'
      )}
    >
      <Checkbox checked={checked} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Puzzle size={10} className="shrink-0 text-[var(--accent)]" />
          <p className="truncate text-[11px] font-semibold text-white">{server.name}</p>
        </div>
        <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">
          {server.command} {server.args.join(' ')}
        </p>
        {server.missingEnv.length > 0 && (
          <p className="mt-1 text-[9px] text-amber-300">
            Will need {server.missingEnv.join(', ')} after import.
          </p>
        )}
      </div>
    </button>
  )
}

function EnvKeyRow({
  entry,
  checked,
  onToggle
}: {
  entry: DetectedEnvKey
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition',
        checked
          ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)]'
          : 'border-white/10 bg-black/30 hover:border-white/20'
      )}
    >
      <Checkbox checked={checked} />
      <KeyRound size={10} className="shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold capitalize text-white">{entry.providerId}</p>
        <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">
          {entry.varName} · {entry.keyPreview}
        </p>
      </div>
    </button>
  )
}

function LocalProviderRow({ entry }: { entry: DetectedLocalProvider }): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-emerald-400 bg-emerald-500/40 text-white">
        <Check size={10} />
      </span>
      <Brain size={10} className="shrink-0 text-emerald-400" />
      <p className="text-[11px] font-semibold capitalize text-white">{entry.providerId}</p>
      <span className="ml-auto text-[9px] uppercase tracking-wide text-emerald-300">running</span>
    </div>
  )
}

function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
        checked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-white/30'
      )}
    >
      {checked && <Check size={10} />}
    </span>
  )
}

/* ----------------------------- done body ------------------------------ */

function DoneBody({ summary }: { summary: ImportSummary }): JSX.Element {
  const failures = [
    ...summary.mcpFailures.map((f) => ({ label: f.name, reason: f.reason })),
    ...summary.keyFailures.map((f) => ({ label: f.providerId, reason: f.reason }))
  ]
  const cleanRun = failures.length === 0
  return (
    <div className="space-y-3">
      <div
        className={cn(
          'rounded-xl border p-4',
          cleanRun
            ? 'border-emerald-500/30 bg-emerald-500/10'
            : 'border-amber-500/30 bg-amber-500/10'
        )}
      >
        <div className="mb-2 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/30 text-emerald-300">
            <Check size={16} />
          </div>
          <p className="text-[13px] font-semibold text-white">
            {summary.mcpImported + summary.keysImported > 0
              ? "You're set up."
              : 'Ready to configure.'}
          </p>
        </div>
        <ul className="space-y-0.5 pl-1 text-[11px] text-slate-300">
          {summary.mcpImported > 0 && (
            <li>· {summary.mcpImported} MCP server{summary.mcpImported === 1 ? '' : 's'} imported</li>
          )}
          {summary.mcpSkipped > 0 && (
            <li className="text-slate-500">
              · {summary.mcpSkipped} already installed
            </li>
          )}
          {summary.keysImported > 0 && (
            <li>
              · {summary.keysImported} API key{summary.keysImported === 1 ? '' : 's'} imported into the
              OS keychain
            </li>
          )}
          {summary.mcpImported === 0 && summary.keysImported === 0 && (
            <li className="text-slate-400">
              Nothing was imported — you can paste an API key in Settings → AI Provider whenever
              you&apos;re ready.
            </li>
          )}
        </ul>
      </div>

      {failures.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {failures.length} couldn&apos;t be imported
          </p>
          {failures.map((f) => (
            <div
              key={f.label}
              className="flex items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-200"
            >
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">{f.label}</p>
                <p className="text-rose-200/80">{f.reason}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
