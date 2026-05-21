/**
 * MCP server manager. Each server is a stdio process VoidSoul spawns; when
 * connected, its tools become callable by the agent alongside the built-in
 * automation actions. Add a server with a command + args, toggle it on, and
 * its tools surface to the model automatically.
 */
import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  Plug,
  Power,
  RefreshCw,
  AlertTriangle,
  Wrench
} from 'lucide-react'
import { useMcpStore } from '../../store/useMcpStore'
import { useUiStore } from '../../store/useUiStore'
import { EmptyState, Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { cn } from '../../lib/utils'
import type { McpServerStatus } from '@shared/types'

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
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!name.trim() || !command.trim() || busy) return
    setBusy(true)
    // Args input is a whitespace-separated string; quoted segments stay together.
    const args = parseArgs(argsRaw)
    const created = await add({ name: name.trim(), command: command.trim(), args })
    setBusy(false)
    setName('')
    setCommand('')
    setArgsRaw('')
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

export function McpSettings(): JSX.Element {
  const servers = useMcpStore((s) => s.servers)
  const load = useMcpStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  const totalTools = servers.reduce(
    (sum, s) => sum + (s.connected ? s.tools.length : 0),
    0
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
    </CollapsibleSection>
  )
}
