/**
 * MCP server marketplace browser. Fetches the curated registry from the
 * project repo and lets the user one-click install canonical community
 * MCP servers (filesystem, GitHub, Slack, Postgres, etc.) without typing
 * a single `npx @modelcontextprotocol/...` command by hand.
 *
 * Two flows depending on the entry:
 *  · Zero prompts (Memory, Puppeteer, Sequential Thinking, etc.) →
 *    click Install → goes straight to `addServer()` + success toast.
 *  · One or more prompts (filesystem path, GitHub token, etc.) →
 *    click Install → small "Configure & install" sheet slides in with
 *    the right inputs. Submit → addServer → close back to the card list.
 *
 * State machine inside the dialog:
 *   loading → list → (configuring → installing) → list
 * The list never closes during install — successful installs add a
 * green "✓ Installed" badge to the card so the user can install several
 * in one session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import { useMcpStore } from '../../store/useMcpStore'
import { useUiStore } from '../../store/useUiStore'
import { useDialog } from '../../lib/useDialog'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import type {
  McpInstallValues,
  McpRegistryArgPrompt,
  McpRegistryEntry,
  McpRegistryEnvPrompt
} from '@shared/types'

const COMMUNITY_LINK = 'https://github.com/punkpeye/awesome-mcp-servers'

interface McpMarketplaceDialogProps {
  open: boolean
  onClose: () => void
}

type ListPhase = 'loading' | 'ready' | 'error'

export function McpMarketplaceDialog({ open, onClose }: McpMarketplaceDialogProps): JSX.Element {
  // Subscribe to `servers` directly (stable reference under Zustand's default
  // equality) and derive the Set in a memo. The earlier version `useMcpStore(s => new Set(...))`
  // returned a fresh Set on every store tick, so any unrelated MCP store
  // change (toggle/reconnect/add/remove from another tab) re-rendered the
  // whole dialog + re-ran `filtered`.
  const servers = useMcpStore((s) => s.servers)
  const installedNames = useMemo(
    () => new Set(servers.map((server) => server.name)),
    [servers]
  )
  const reloadMcp = useMcpStore((s) => s.load)
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [entries, setEntries] = useState<McpRegistryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [configuring, setConfiguring] = useState<McpRegistryEntry | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)

  // Bumped on every load() call; in-flight responses compare against the
  // current token in a ref and bail if a newer request started — guards
  // both the initial mount and manual refresh against close/re-open races.
  const requestToken = useRef(0)
  const load = useCallback(() => {
    const myToken = ++requestToken.current
    setPhase('loading')
    setError(null)
    void vs.mcpMarketplace
      .browse()
      .then((list) => {
        if (requestToken.current !== myToken) return
        setEntries(list)
        setPhase('ready')
      })
      .catch((err) => {
        if (requestToken.current !== myToken) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
  }, [])

  useEffect(() => {
    if (!open) return
    setFilter('')
    setConfiguring(null)
    load()
    // Increment on close so any still-pending response is invalidated.
    return () => {
      requestToken.current++
    }
  }, [open, load])

  const filtered = useMemo(() => {
    if (!filter.trim()) return entries
    const needle = filter.trim().toLowerCase()
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.description.toLowerCase().includes(needle) ||
        e.category.toLowerCase().includes(needle) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(needle))
    )
  }, [entries, filter])

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
            aria-label="Browse MCP servers"
            className="glass flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Plug size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                MCP server marketplace
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

            {/* Search + refresh row — hidden during error/loading since
                there's nothing to search yet. */}
            {phase === 'ready' && (
              <div className="border-b border-white/5 px-4 py-2">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search
                      size={11}
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
                    />
                    <input
                      type="text"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search by name, description, tag…"
                      className="w-full rounded-md border border-white/10 bg-black/30 py-1.5 pl-7 pr-2 text-[11px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[var(--accent-ring)]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={load}
                    title="Refresh registry"
                    aria-label="Refresh"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
                  >
                    <RefreshCw size={11} />
                  </button>
                </div>
              </div>
            )}

            <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {phase === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-slate-400">
                  <Loader2 size={14} className="animate-spin" />
                  Loading marketplace…
                </div>
              )}
              {phase === 'error' && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-200">
                  <p className="font-semibold">Couldn&apos;t load the marketplace.</p>
                  <p className="mt-0.5 text-[10px] text-rose-300/80">{error}</p>
                  <button
                    type="button"
                    onClick={load}
                    className="mt-2 flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-[10px] text-rose-200 transition hover:bg-rose-500/20"
                  >
                    <RefreshCw size={10} />
                    Try again
                  </button>
                </div>
              )}
              {phase === 'ready' && filtered.length === 0 && (
                <p className="rounded-lg border border-white/10 bg-black/30 p-4 text-center text-[11px] text-slate-400">
                  {filter
                    ? 'No matches.'
                    : 'No MCP servers in the registry yet — check back soon.'}
                </p>
              )}
              {phase === 'ready' && filtered.length > 0 && (
                <ul className="space-y-1.5">
                  {filtered.map((entry) => (
                    <MarketplaceCard
                      key={entry.id}
                      entry={entry}
                      installed={installedNames.has(entry.name)}
                      onInstall={() => setConfiguring(entry)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-white/10 px-4 py-3 text-center text-[10px] text-slate-500">
              <a
                href={COMMUNITY_LINK}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  window.open(COMMUNITY_LINK, '_blank')
                }}
                className="inline-flex items-center gap-1 text-slate-400 transition hover:text-[var(--accent)]"
              >
                Browse all community servers
                <ExternalLink size={9} />
              </a>
            </div>
          </motion.div>

          {/* Configure-and-install sheet — slides over the card list when
              the user picks an entry that has prompts (or just confirms
              the install for parameterless entries). */}
          <AnimatePresence>
            {configuring && (
              <ConfigureSheet
                entry={configuring}
                onClose={() => setConfiguring(null)}
                onInstalled={() => {
                  setConfiguring(null)
                  void reloadMcp()
                }}
              />
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ----------------------------- card row -------------------------------- */

function MarketplaceCard({
  entry,
  installed,
  onInstall
}: {
  entry: McpRegistryEntry
  installed: boolean
  onInstall: () => void
}): JSX.Element {
  return (
    <li className="glass-soft rounded-lg px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Plug size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] font-semibold text-white">{entry.name}</p>
            {entry.requires && (
              <span
                title={`Requires ${entry.requires} installed on your system.`}
                className="rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 text-[9px] text-amber-300"
              >
                requires {entry.requires}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{entry.description}</p>
          <div className="mt-1 flex items-center gap-2 text-[9px] text-slate-500">
            <span className="rounded bg-white/5 px-1.5 py-0.5">{entry.category}</span>
            {entry.author && <span>· {entry.author}</span>}
            {entry.docsUrl && (
              <a
                href={entry.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  if (entry.docsUrl) window.open(entry.docsUrl, '_blank')
                }}
                className="ml-auto flex items-center gap-0.5 text-slate-500 transition hover:text-[var(--accent)]"
              >
                docs <ExternalLink size={8} />
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installed}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition disabled:cursor-not-allowed',
            installed
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-[var(--accent)] text-white hover:brightness-110'
          )}
        >
          {installed ? (
            <>
              <Check size={11} />
              Installed
            </>
          ) : (
            <>
              <Download size={11} />
              Install
            </>
          )}
        </button>
      </div>
    </li>
  )
}

/* ----------------------- configure & install sheet -------------------- */

function ConfigureSheet({
  entry,
  onClose,
  onInstalled
}: {
  entry: McpRegistryEntry
  onClose: () => void
  onInstalled: () => void
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [args, setArgs] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.argPrompts.map((p) => [p.key, '']))
  )
  const [env, setEnv] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.envPrompts.map((p) => [p.key, '']))
  )
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const allFilled =
    entry.argPrompts.every((p) => args[p.key]?.trim()) &&
    entry.envPrompts.every((p) => env[p.key]?.trim())

  const submit = async (): Promise<void> => {
    if (!allFilled || busy) return
    setBusy(true)
    setErrorMsg(null)
    const result = await vs.mcpMarketplace.install(entry, {
      args,
      env
    } as McpInstallValues)
    setBusy(false)
    if (result.ok) {
      pushToast(
        'success',
        result.skipped
          ? `${entry.name} is already installed.`
          : result.status?.connected
            ? `${entry.name} connected · ${result.status.tools.length} tool(s).`
            : `${entry.name} installed — connecting…`
      )
      onInstalled()
    } else {
      setErrorMsg(result.error ?? 'Install failed.')
    }
  }

  // Zero-prompt entries: render the confirm form rather than auto-installing,
  // so the user has a clear "yes, install this thing" moment instead of a
  // surprise toast. One click to confirm matches the "Install" label.
  const hasNoPrompts = entry.argPrompts.length === 0 && entry.envPrompts.length === 0

  return (
    <motion.div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Install ${entry.name}`}
        className="glass flex max-h-[85vh] w-full max-w-[400px] flex-col overflow-hidden rounded-2xl shadow-panel"
        initial={{ scale: 0.94, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <Sparkles size={15} className="text-[var(--accent)]" />
          <h3 className="flex-1 font-display text-[13px] font-semibold text-white">
            Install {entry.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 transition hover:text-slate-200"
          >
            <X size={15} />
          </button>
        </div>

        <div className="scrollbar-void min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <p className="text-[11px] leading-relaxed text-slate-300">{entry.description}</p>

          {hasNoPrompts && (
            <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
              No configuration needed — click Install and the server boots immediately.
            </p>
          )}

          {entry.argPrompts.map((prompt) => (
            <PromptField
              key={`arg-${prompt.key}`}
              prompt={prompt}
              value={args[prompt.key] ?? ''}
              onChange={(v) => setArgs((prev) => ({ ...prev, [prompt.key]: v }))}
            />
          ))}

          {entry.envPrompts.map((prompt) => (
            <EnvPromptField
              key={`env-${prompt.key}`}
              prompt={prompt}
              value={env[prompt.key] ?? ''}
              onChange={(v) => setEnv((prev) => ({ ...prev, [prompt.key]: v }))}
            />
          ))}

          {entry.requires && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-200">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                This server needs <code className="rounded bg-black/40 px-1">{entry.requires}</code>{' '}
                installed on your system. Install will fail without it.
              </span>
            </p>
          )}

          {errorMsg && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {errorMsg}
            </p>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-white/10 px-3 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!allFilled || busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {busy ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Installing…
              </>
            ) : (
              <>
                <Download size={12} />
                Install
              </>
            )}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function PromptField({
  prompt,
  value,
  onChange
}: {
  prompt: McpRegistryArgPrompt
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {prompt.label}
      </label>
      <input
        type={prompt.secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={prompt.placeholder}
        className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[var(--accent-ring)]"
      />
      {prompt.description && (
        <p className="mt-1 text-[10px] leading-snug text-slate-500">{prompt.description}</p>
      )}
    </div>
  )
}

function EnvPromptField({
  prompt,
  value,
  onChange
}: {
  prompt: McpRegistryEnvPrompt
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  // Show / hide toggle for secret env values so users can sanity-check
  // a pasted token without re-pasting it.
  const [visible, setVisible] = useState(false)
  const isSecret = prompt.secret !== false // default to secret
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {prompt.label}
      </label>
      <div className="relative">
        <input
          type={isSecret && !visible ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 pr-9 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[var(--accent-ring)]"
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide value' : 'Show value'}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-200"
          >
            {visible ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      {prompt.description && (
        <p className="mt-1 text-[10px] leading-snug text-slate-500">{prompt.description}</p>
      )}
    </div>
  )
}
