/**
 * MCP server manager. Each server is a stdio process VoidSoul spawns; when
 * connected, its tools become callable by the agent alongside the built-in
 * automation actions. Add a server with a command + args, toggle it on, and
 * its tools surface to the model automatically.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  Plus,
  Trash2,
  Plug,
  Power,
  RefreshCw,
  AlertTriangle,
  Sparkles,
  Store,
  Wrench
} from 'lucide-react'
import { useMcpStore } from '../../store/useMcpStore'
import { useUiStore } from '../../store/useUiStore'
import { EmptyState, Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import type { McpServerStatus, SetupReport } from '@shared/types'
import type { ImportSource } from './SetupImportDialog'

// Lazy — both dialogs only render on click; keep them out of the settings
// initial chunk so opening Settings is one fewer ms of parse work.
const SetupImportDialog = lazy(() =>
  import('./SetupImportDialog').then((m) => ({ default: m.SetupImportDialog }))
)
const McpMarketplaceDialog = lazy(() =>
  import('./McpMarketplaceDialog').then((m) => ({ default: m.McpMarketplaceDialog }))
)

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600 font-mono'

function ServerRow({ server }: { server: McpServerStatus }): JSX.Element {
  const remove = useMcpStore((s) => s.remove)
  const setEnabled = useMcpStore((s) => s.setEnabled)
  const reconnect = useMcpStore((s) => s.reconnect)
  const pushToast = useUiStore((s) => s.pushToast)
  const [expanded, setExpanded] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleReconnect = async (): Promise<void> => {
    setBusy(true)
    await reconnect(server.id)
    setBusy(false)
  }

  const connecting = server.enabled && !server.connected && !server.error
  const dotColor = !server.enabled
    ? 'bg-slate-500'
    : server.connected
      ? 'bg-emerald-400'
      : server.error
        ? 'bg-rose-400'
        : 'bg-amber-400'

  if (confirmingDelete) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-2">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-white">Remove "{server.name}"?</p>
          <p className="text-[10px] text-slate-400">
            Stops the process and forgets the config. Can't be undone.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false)
              void remove(server.id).then(() =>
                pushToast('success', `Removed "${server.name}".`)
              )
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-rose-400 transition hover:bg-rose-500/20"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="glass-soft rounded-lg px-2.5 py-2">
      <div className="flex items-start gap-2">
        {/* Pulse the dot while a connect is in flight so the UI doesn't read
            as "stuck" while we wait on a slow `npx` cold start. */}
        <span
          className={cn(
            'mt-1 h-2 w-2 shrink-0 rounded-full',
            dotColor,
            connecting && 'animate-pulse'
          )}
        />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-[11px] font-semibold text-white">{server.name}</p>
          <p className="truncate text-[9px] text-slate-500">
            {server.connected
              ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'} available`
              : server.error
                ? 'failed — click for details'
                : server.enabled
                  ? 'connecting…'
                  : 'disabled'}
          </p>
        </button>
        <Toggle
          checked={server.enabled}
          onChange={(v) => void setEnabled(server.id, v)}
          label={`Enable ${server.name}`}
        />
        <button
          type="button"
          onClick={() => void handleReconnect()}
          disabled={busy}
          title="Reconnect"
          className="shrink-0 text-slate-500 transition hover:text-[var(--accent)] disabled:opacity-40"
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          title="Remove server"
          className="shrink-0 text-slate-500 transition hover:text-rose-400"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-white/5 pt-2 text-[10px]">
          {server.error && (
            <div className="flex items-start gap-1.5 rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-rose-200">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="break-words font-mono">{server.error}</span>
            </div>
          )}
          {server.tools.length > 0 ? (
            <ul className="space-y-0.5">
              {server.tools.map((tool) => (
                <li key={tool.name} className="flex items-start gap-1.5 text-slate-400">
                  <Wrench size={9} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                  <div className="min-w-0">
                    <span className="font-mono text-slate-300">{tool.originalName}</span>
                    {tool.description && (
                      <span className="text-slate-500"> · {tool.description}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            !server.error && (
              <p className="text-slate-500">
                {server.enabled ? 'No tools reported yet.' : 'Enable to see tools.'}
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}

function AddServerForm({ onAdd }: { onAdd: () => void }): JSX.Element {
  const add = useMcpStore((s) => s.add)
  const pushToast = useUiStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsRaw, setArgsRaw] = useState('')
  const [envRaw, setEnvRaw] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!name.trim() || !command.trim() || busy) return
    setBusy(true)
    // Args input is a whitespace-separated string; quoted segments stay together.
    const args = parseArgs(argsRaw)
    // Env input is a `KEY=value` per line list — let MCP servers that need
    // secrets (API tokens, bot tokens) load them without putting the value
    // in plain Args. Lines without `=` and blank lines are ignored.
    const env = parseEnv(envRaw)
    const created = await add({
      name: name.trim(),
      command: command.trim(),
      args,
      ...(Object.keys(env).length ? { env } : {})
    })
    setBusy(false)
    setName('')
    setCommand('')
    setArgsRaw('')
    setEnvRaw('')
    setOpen(false)
    onAdd()
    pushToast(
      created.connected ? 'success' : 'error',
      created.connected
        ? `${created.name} connected · ${created.tools.length} tool(s).`
        : `${created.name} couldn't start: ${created.error ?? 'unknown error'}`
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 py-2 text-[10px] font-semibold text-slate-400 transition hover:border-[var(--accent-ring)] hover:text-[var(--accent)]"
      >
        <Plus size={12} />
        Add MCP server
      </button>
    )
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/20 p-2.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Name (e.g. "Filesystem")'
        className={FIELD}
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="Command (e.g. npx)"
        className={FIELD}
      />
      <input
        value={argsRaw}
        onChange={(e) => setArgsRaw(e.target.value)}
        placeholder='Args (e.g. -y @modelcontextprotocol/server-filesystem /path)'
        className={FIELD}
      />
      <textarea
        value={envRaw}
        onChange={(e) => setEnvRaw(e.target.value)}
        placeholder={'Env (optional, one KEY=value per line)\nDISCORD_BOT_TOKEN=...\nDISCORD_GUILD_ID=...'}
        rows={3}
        className={`${FIELD} resize-y font-mono`}
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!name.trim() || !command.trim() || busy}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[var(--accent)] py-1.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          <Power size={11} />
          {busy ? 'Connecting…' : 'Add & start'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-slate-400 transition hover:bg-white/5"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Splits a shell-like args string into tokens, honouring double-quoted runs. */
function parseArgs(raw: string): string[] {
  const out: string[] = []
  const trimmed = raw.trim()
  if (!trimmed) return out
  const re = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(trimmed)) !== null) {
    out.push(match[1] ?? match[2])
  }
  return out
}

/**
 * Parses a `KEY=value` per-line env block into the object shape the MCP
 * connection layer wants. Lines without an `=` are ignored (so comments
 * starting with `#` are silently dropped), blank lines are ignored, and
 * the value side accepts `=` literals beyond the first split point.
 */
function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

export function McpSettings(): JSX.Element {
  const servers = useMcpStore((s) => s.servers)
  const load = useMcpStore((s) => s.load)

  // Setup-detection result. Fetched once on mount + refreshed after each
  // import so the "Import from X" buttons reflect the current source-config
  // state. Null while the IPC round-trip is in flight (UI hides the import
  // strip during that brief window — empty is the right default).
  const [report, setReport] = useState<SetupReport | null>(null)
  const [importSource, setImportSource] = useState<ImportSource | null>(null)
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)

  const refreshReport = (): void => {
    void vs.setup.detect().then(setReport)
  }

  useEffect(() => {
    void load()
    refreshReport()
  }, [load])

  const totalTools = servers.reduce(
    (sum, s) => sum + (s.connected ? s.tools.length : 0),
    0
  )

  // Pass installed names into the dialog so it can mark already-imported
  // entries as non-checkable. We memo on a STRING KEY derived from the
  // names — not the `servers` array reference — so reconnects / toggle /
  // tool-count refreshes don't allocate a new Set and re-fire the
  // dialog's detection useEffect each time.
  const installedNamesKey = servers
    .map((s) => s.name)
    .sort()
    .join('|')
  const installedNames = useMemo(
    () => new Set(servers.map((s) => s.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key drives identity
    [installedNamesKey]
  )

  return (
    <CollapsibleSection
      title="MCP Servers"
      hint="Model Context Protocol servers — pluggable tool sources. Add a command (e.g. an npx-based server) and its tools become callable by the agent alongside the built-in ones. Stdio transport for now."
    >
      <div className="mb-2 flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-1.5 text-slate-400">
          <Plug size={11} className="text-[var(--accent)]" />
          <span>
            {servers.filter((s) => s.connected).length}/{servers.length} connected ·{' '}
            {totalTools} tool{totalTools === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Import + browse strip — surfaces the "you've already configured
          things elsewhere, want them here?" buttons (when detected) plus
          the always-on "Browse marketplace" entry point so users can
          discover canonical MCP servers without typing npx commands. */}
      <ImportStrip
        report={report}
        onOpen={setImportSource}
        onBrowse={() => setMarketplaceOpen(true)}
      />

      <div className="space-y-1.5">
        {servers.length === 0 ? (
          <EmptyState
            icon={<Plug size={20} />}
            title="No MCP servers yet"
            hint="Add a Model Context Protocol server to give the agent more tools — file system access, GitHub, databases, anything that speaks MCP."
          />
        ) : (
          servers.map((server) => <ServerRow key={server.id} server={server} />)
        )}
      </div>

      <div className="mt-2">
        <AddServerForm onAdd={() => void load()} />
      </div>

      {/* Both dialogs are lazy-loaded; wrapping in a no-fallback Suspense
          keeps the brief chunk-fetch flicker invisible (each dialog has
          its own loading state on top of that anyway). Gating on the
          open flag means the chunk isn't even fetched until the user
          actually clicks to open the dialog. */}
      {importSource !== null && (
        <Suspense fallback={null}>
          <SetupImportDialog
            source={importSource}
            installedNames={installedNames}
            onClose={() => setImportSource(null)}
            onImported={() => {
              void load()
              refreshReport()
            }}
          />
        </Suspense>
      )}

      {marketplaceOpen && (
        <Suspense fallback={null}>
          <McpMarketplaceDialog
            open={marketplaceOpen}
            onClose={() => setMarketplaceOpen(false)}
          />
        </Suspense>
      )}
    </CollapsibleSection>
  )
}

/**
 * Top-of-section action strip. Always shows "Browse marketplace" — the
 * canonical discovery surface; additionally surfaces "Import from Claude
 * Desktop" / "Import from Cursor" when detected so users who already set
 * up MCP servers in those apps can mirror them in one click. Each import
 * button carries a small count chip ("5") so the user knows there's
 * something there to import before clicking.
 */
function ImportStrip({
  report,
  onOpen,
  onBrowse
}: {
  report: SetupReport | null
  onOpen: (source: ImportSource) => void
  onBrowse: () => void
}): JSX.Element {
  const claudeCount = report?.claudeDesktop.mcpServers.length ?? 0
  const cursorCount = report?.cursor.mcpServers.length ?? 0
  const claudeAvailable = (report?.claudeDesktop.installed ?? false) && claudeCount > 0
  const cursorAvailable = (report?.cursor.installed ?? false) && cursorCount > 0
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={onBrowse}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--accent)] transition hover:brightness-110"
      >
        <Store size={11} />
        Browse marketplace
      </button>
      {claudeAvailable && (
        <ImportButton
          label="Import from Claude Desktop"
          count={claudeCount}
          onClick={() => onOpen('claude-desktop')}
        />
      )}
      {cursorAvailable && (
        <ImportButton
          label="Import from Cursor"
          count={cursorCount}
          onClick={() => onOpen('cursor')}
        />
      )}
    </div>
  )
}

function ImportButton({
  label,
  count,
  onClick
}: {
  label: string
  count: number
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--accent)] transition hover:brightness-110"
    >
      <Sparkles size={11} />
      {label}
      <span className="rounded-full bg-white/10 px-1.5 text-[9px] text-white">{count}</span>
    </button>
  )
}
