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
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Zap,
  X
} from 'lucide-react'
import { useMcpStore } from '../../store/useMcpStore'
import { useUiStore } from '../../store/useUiStore'
import { useDialog } from '../../lib/useDialog'
import { vs } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { filterZeroConfigEntries } from '../../lib/mcpQuickStart'
import { QuickStartDialog } from './QuickStartDialog'
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
  /** v1.12.0 — when set, auto-opens the Quick Start sub-dialog once
   *  marketplace entries finish loading. Used by the McpSettings empty-
   *  state banner so a first-time user lands directly on Quick Start
   *  instead of having to find the button in the marketplace header. */
  initialView?: 'quickStart'
}

type ListPhase = 'loading' | 'ready' | 'error'

export function McpMarketplaceDialog({
  open,
  onClose,
  initialView
}: McpMarketplaceDialogProps): JSX.Element {
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
  // v1.11.1 — new filter + sort axes for the marketplace store UX.
  // category=null means "All categories". sourceFilter='all' means
  // all sources. sort defaults to 'recommended' which surfaces curated
  // picks first, then by source quality, then alphabetical.
  const [category, setCategory] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<
    'all' | 'curated' | 'smithery' | 'glama' | 'pulsemcp'
  >('all')
  const [sortMode, setSortMode] = useState<'recommended' | 'name' | 'category'>('recommended')
  const [configuring, setConfiguring] = useState<McpRegistryEntry | null>(null)
  // v1.12.0 — Quick Start dialog overlay. Opened from the header button
  // (and the McpSettings empty-state banner). Reuses `entries` so it
  // doesn't double-fetch the marketplace.
  const [quickStartOpen, setQuickStartOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, onClose)

  // Bumped on every load() call; in-flight responses compare against the
  // current token in a ref and bail if a newer request started — guards
  // both the initial mount and manual refresh against close/re-open races.
  const requestToken = useRef(0)
  // v1.12.0 — `force` bypasses the main-process 30s TTL cache. Used by
  // the Refresh button so a user reacting to a network hiccup actually
  // re-fetches; the default open-dialog load happily hits the cache so
  // StrictMode double-mounts don't burn 8 HTTPS requests.
  const load = useCallback((force = false) => {
    const myToken = ++requestToken.current
    setPhase('loading')
    setError(null)
    void vs.mcpMarketplace
      .browse(force ? { force: true } : undefined)
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
    setCategory(null)
    setSourceFilter('all')
    setSortMode('recommended')
    setConfiguring(null)
    // Reset Quick Start on every open so a previous open's state doesn't
    // bleed through. Auto-open (when initialView === 'quickStart') happens
    // in a separate effect that waits for entries to be ready — opening
    // Quick Start before entries load would show empty profile counts.
    setQuickStartOpen(false)
    load()
    // Increment on close so any still-pending response is invalidated.
    return () => {
      requestToken.current++
    }
  }, [open, load])

  // v1.12.0 — auto-open Quick Start once entries are ready, but ONLY on
  // the initial open with `initialView === 'quickStart'`. Tracking 'armed'
  // via a ref so opening it once doesn't keep re-firing when the user
  // closes Quick Start, browses, and `phase` happens to stay 'ready'.
  const autoOpenArmed = useRef(false)
  useEffect(() => {
    if (open && initialView === 'quickStart') autoOpenArmed.current = true
    if (!open) autoOpenArmed.current = false
  }, [open, initialView])
  useEffect(() => {
    if (phase === 'ready' && autoOpenArmed.current) {
      autoOpenArmed.current = false
      setQuickStartOpen(true)
    }
  }, [phase])

  // v1.11.1 — category list with live counts, derived from the loaded
  // entries. Order: most-populated first so users see the biggest
  // buckets up top. Always includes "All" at index 0.
  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
    }
    const ordered = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }))
    return ordered
  }, [entries])

  /** Source-rank used by the 'recommended' sort. Order matches the main-
   *  process dedup trust order (Curated > PulseMCP > Smithery > Glama) so
   *  the badge a user sees and the sort weight a user feels agree. v1.12.0
   *  fix — PulseMCP was previously dropped to the bottom of the sort even
   *  though it ranks above Smithery in dedup. */
  const sourceRank = (source: McpRegistryEntry['source']): number => {
    if (source === 'curated') return 0
    if (source === 'pulsemcp') return 1
    if (source === 'smithery') return 2
    if (source === 'glama') return 3
    return 4
  }

  // Apply filters + sort. Done in a single memo so we don't pay for
  // re-sorting on every keystroke when the source/category didn't change.
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    let list = entries
    if (needle) {
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          e.description.toLowerCase().includes(needle) ||
          e.category.toLowerCase().includes(needle) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(needle))
      )
    }
    if (category) {
      list = list.filter((e) => e.category === category)
    }
    if (sourceFilter !== 'all') {
      list = list.filter((e) => (e.source ?? 'curated') === sourceFilter)
    }
    const sorted = [...list]
    if (sortMode === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    } else if (sortMode === 'category') {
      sorted.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    } else {
      // 'recommended' — source rank first, then name. Curated wins
      // because we hand-pick those; the catalogue sources tie-break
      // alphabetically for predictability.
      sorted.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name))
    }
    return sorted
  }, [entries, filter, category, sourceFilter, sortMode])

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
            // v1.11.4 — fixed canvas. Old `max-h` + `w-full max-w-` made
            // the dialog resize as entries loaded / filters applied,
            // which read as the layout "jittering" — UI felt unstable.
            // Locking to a fixed height + width means the canvas stays
            // put and the inner scroll area absorbs all content variation.
            // v1.12.0 — bumped 960 → 1200 so the card grid breathes; the
            // tighter previous width forced badge rows to wrap and made
            // the marketplace feel cramped at the typical Settings size.
            className="glass flex h-[85vh] w-[min(1200px,95vw)] flex-col overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
              <Plug size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                MCP server marketplace
              </h2>
              {phase === 'ready' && (
                <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                  {filtered.length} / {entries.length}
                </span>
              )}
              {/* v1.12.0 — Quick Start button. Always present once entries
                * load so users discover the one-click bulk install even
                * after they've configured a server or two. Counts the
                * zero-config eligible entries so they know the upper
                * bound on what bulk install can grab. */}
              {phase === 'ready' && filterZeroConfigEntries(entries).length > 0 && (
                <button
                  type="button"
                  onClick={() => setQuickStartOpen(true)}
                  title="Bulk-install several zero-config MCP servers via a workflow profile."
                  className="flex items-center gap-1 rounded-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-semibold text-[var(--accent)] transition hover:brightness-110"
                >
                  <Rocket size={11} />
                  Quick Start
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-slate-500 transition hover:text-slate-200"
              >
                <X size={15} />
              </button>
            </div>

            {/* Toolbar — search + sort + source pills. Hidden during
              * load/error since there's nothing meaningful to filter yet. */}
            {phase === 'ready' && (
              <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-5 py-2.5">
                <div className="relative min-w-[200px] flex-1">
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
                {/* Source pills — All / Curated / PulseMCP / Smithery /
                  * Glama. v1.12.0 dropped Cline (no public JSON endpoint).
                  * flex-wrap so the row collapses to two lines on narrow
                  * Settings windows instead of overflowing. */}
                <div className="flex flex-wrap items-center gap-1 rounded-md border border-white/10 bg-black/20 p-0.5">
                  {(
                    [
                      ['all', 'All'],
                      ['curated', 'Curated'],
                      ['pulsemcp', 'PulseMCP'],
                      ['smithery', 'Smithery'],
                      ['glama', 'Glama']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSourceFilter(value)}
                      className={cn(
                        'rounded px-2 py-1 text-[10px] font-medium transition',
                        sourceFilter === value
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-slate-400 hover:bg-white/5 hover:text-white'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Sort dropdown */}
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                  className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-[var(--accent-ring)]"
                  title="Sort marketplace"
                >
                  <option value="recommended">Recommended</option>
                  <option value="name">Name A–Z</option>
                  <option value="category">Category</option>
                </select>
                <button
                  type="button"
                  onClick={() => load(true)}
                  title="Refresh registry"
                  aria-label="Refresh"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
                >
                  <RefreshCw size={11} />
                </button>
              </div>
            )}

            {/* Body — sidebar + grid (or full-width for loading/error) */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {/* Category sidebar — only when ready + we have categories */}
              {phase === 'ready' && categories.length > 0 && (
                <div className="scrollbar-void w-44 shrink-0 overflow-y-auto border-r border-white/5 px-2 py-3">
                  <p className="mb-1.5 px-2 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                    Categories
                  </p>
                  <button
                    type="button"
                    onClick={() => setCategory(null)}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2 py-1 text-[11px] transition',
                      category === null
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'text-slate-300 hover:bg-white/5'
                    )}
                  >
                    <span className="capitalize">All</span>
                    <span className="font-mono text-[9px] text-slate-500">{entries.length}</span>
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat.name}
                      type="button"
                      onClick={() => setCategory(cat.name)}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1 text-[11px] transition',
                        category === cat.name
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-slate-300 hover:bg-white/5'
                      )}
                    >
                      <span className="capitalize">{cat.name}</span>
                      <span className="font-mono text-[9px] text-slate-500">{cat.count}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Main scroll area — loading / error / empty / grid */}
              <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                      onClick={() => load(true)}
                      className="mt-2 flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-[10px] text-rose-200 transition hover:bg-rose-500/20"
                    >
                      <RefreshCw size={10} />
                      Try again
                    </button>
                  </div>
                )}
                {phase === 'ready' && filtered.length === 0 && (
                  <p className="rounded-lg border border-white/10 bg-black/30 p-4 text-center text-[11px] text-slate-400">
                    {filter || category || sourceFilter !== 'all'
                      ? 'No matches for the current filters.'
                      : 'No MCP servers in the registry yet — check back soon.'}
                  </p>
                )}
                {phase === 'ready' && filtered.length > 0 && (
                  <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                    {filtered.map((entry) => (
                      <MarketplaceCard
                        key={entry.id}
                        entry={entry}
                        installed={installedNames.has(entry.name)}
                        onInstall={() => setConfiguring(entry)}
                        onEasyInstall={async () => {
                          // v1.12.0 — bypass the configure dialog for
                          // entries with no prompts. Installs immediately
                          // and surfaces a toast on success/error so the
                          // user sees the outcome without needing to open
                          // the sheet just to click Install again.
                          try {
                            const created = await useMcpStore.getState().add({
                              name: entry.name,
                              command: entry.command,
                              args: entry.args,
                              ...(Object.keys(entry.env).length
                                ? { env: entry.env }
                                : {})
                            })
                            useUiStore.getState().pushToast(
                              created.connected ? 'success' : 'error',
                              created.connected
                                ? `${created.name} connected · ${created.tools.length} tool(s).`
                                : `${created.name} couldn\'t start: ${created.error ?? 'unknown error'}`
                            )
                          } catch (err) {
                            useUiStore.getState().pushToast(
                              'error',
                              `Install failed: ${err instanceof Error ? err.message : String(err)}`
                            )
                          }
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-white/10 px-5 py-3 text-center text-[10px] text-slate-500">
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
          {/* v1.12.0 — Quick Start overlay. Renders inside the marketplace
            * motion.div so closing it via backdrop click doesn't bubble
            * up to the marketplace's close-on-backdrop handler. */}
          <QuickStartDialog
            open={quickStartOpen}
            onClose={() => setQuickStartOpen(false)}
            entries={entries}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ----------------------------- card row -------------------------------- */

function MarketplaceCard({
  entry,
  installed,
  onInstall,
  onEasyInstall
}: {
  entry: McpRegistryEntry
  installed: boolean
  /** Open the configure-and-install sheet. Used for entries that have
   *  argPrompts or envPrompts the user needs to fill in. */
  onInstall: () => void
  /** v1.12.0 — install directly without opening the sheet. Used for
   *  entries with zero prompts ("Easy Add" button). */
  onEasyInstall: () => Promise<void>
}): JSX.Element {
  // v1.12.0 — an entry is one-click-installable when it\'s not
  // discovery-only AND has no prompts to fill in. Render "Easy Add"
  // instead of "Install" so users see at a glance which entries are
  // friction-free.
  const isEasyAdd =
    !entry.discoveryOnly &&
    entry.argPrompts.length === 0 &&
    entry.envPrompts.length === 0
  const [easyAdding, setEasyAdding] = useState(false)
  const handleEasyClick = async (): Promise<void> => {
    if (easyAdding) return
    setEasyAdding(true)
    try {
      await onEasyInstall()
    } finally {
      setEasyAdding(false)
    }
  }
  // v1.11.4 — div instead of li. The grid container is no longer a
  // <ul> (we render a flex grid now), so an <li> child would be
  // invalid HTML. Plain div keeps a11y honest without forcing a
  // <ul role="list"> wrapper around the grid.
  return (
    <div className="glass-soft rounded-lg px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Plug size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          {/* v1.12.0 — badge row uses flex-wrap so a card with 4 pills
            * (Curated + Verified + requires X + Easy Add) wraps cleanly
            * to a second line of WHOLE PILLS instead of breaking inside
            * one badge. Each pill carries whitespace-nowrap as a belt-
            * and-suspenders against narrow grid columns. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[11px] font-semibold text-white">{entry.name}</p>
            {/* v1.11.0 — source badge. Curated picks (our reviewed
              * registry) get a cyan badge; Smithery-sourced entries
              * get a purple badge so users can immediately tell the
              * community catalogue from our hand-picked list. Each
              * source has different trust + curation properties and
              * surfacing that upfront keeps expectations honest. */}
            {entry.source === 'smithery' ? (
              <span
                title="From the Smithery.ai community catalogue."
                className="whitespace-nowrap rounded-full border border-purple-400/30 bg-purple-500/10 px-1.5 text-[9px] text-purple-300"
              >
                Smithery
              </span>
            ) : entry.source === 'glama' ? (
              <span
                title="From the Glama.ai community catalogue."
                className="whitespace-nowrap rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 text-[9px] text-amber-300"
              >
                Glama
              </span>
            ) : entry.source === 'pulsemcp' ? (
              <span
                title="From the PulseMCP registry."
                className="whitespace-nowrap rounded-full border border-pink-400/30 bg-pink-500/10 px-1.5 text-[9px] text-pink-300"
              >
                PulseMCP
              </span>
            ) : entry.source === 'curated' ? (
              <span
                title="VoidSoul-curated pick — reviewed by us."
                className="whitespace-nowrap rounded-full border border-cyan-400/30 bg-cyan-500/10 px-1.5 text-[9px] text-cyan-300"
              >
                Curated
              </span>
            ) : null}
            {/* v1.12.0 — cryptographic Verified badge. Only set when the
              * source registry shipped a valid Ed25519 signature that
              * verified against our bundled public key. Pre-empts the
              * "malicious plugin owns your machine" failure mode from
              * the security audit. Hover for context. */}
            {entry.verified && (
              <span
                title="Ed25519 signature verified — this entry came from a source whose registry signature matches our bundled public key."
                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 text-[9px] text-emerald-300"
              >
                <ShieldCheck size={9} />
                Verified
              </span>
            )}
            {entry.requires && (
              <span
                title={`Requires ${entry.requires} installed on your system.`}
                className="whitespace-nowrap rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 text-[9px] text-amber-300"
              >
                requires {entry.requires}
              </span>
            )}
            {/* v1.12.0 — Easy Add badge. Mirrors the install-button label
              * up into the card so users scanning the marketplace can
              * spot the zero-friction entries at a glance instead of
              * opening each install sheet to find out. Yellow Zap matches
              * the action button so the visual language is consistent. */}
            {isEasyAdd && (
              <span
                title="No configuration needed — click Install and the server boots immediately."
                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border border-yellow-400/30 bg-yellow-500/10 px-1.5 text-[9px] text-yellow-300"
              >
                <Zap size={9} />
                Easy Add
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
        {/* v1.11.4 — discovery-only entries (Glama) have no install
          * command in the registry data we receive, so we render a
          * "View" button that opens the entry's detail page in the
          * user's browser instead of triggering an install flow. They
          * can read install instructions there + paste into our Add
          * MCP form. Honest representation of what we can actually do
          * for the user. */}
        {entry.discoveryOnly ? (
          <button
            type="button"
            onClick={() => {
              if (entry.docsUrl) window.open(entry.docsUrl, '_blank')
            }}
            disabled={!entry.docsUrl}
            title="Opens the registry's detail page in your browser. Read install instructions there + paste into Settings → MCP → Add."
            className="flex shrink-0 items-center gap-1 rounded-md border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-200 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ExternalLink size={11} />
            View
          </button>
        ) : (
          <button
            type="button"
            onClick={isEasyAdd ? () => void handleEasyClick() : onInstall}
            disabled={installed || easyAdding}
            title={
              installed
                ? 'Already installed.'
                : isEasyAdd
                  ? 'No configuration needed — click to install and start the server immediately.'
                  : 'Open the configure-and-install sheet.'
            }
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition disabled:cursor-not-allowed',
              installed
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-[var(--accent)] text-white hover:brightness-110'
            )}
          >
            {/* v1.12.0 — button label is always "Install" for installable
              * entries; the badge row above carries the Easy Add cue.
              * Two "Easy Add" labels on the same card read as duplication.
              * The Zap icon stays for easy entries — quiet visual cue that
              * this one boots without a configure dialog. */}
            {installed ? (
              <>
                <Check size={11} />
                Installed
              </>
            ) : easyAdding ? (
              <>
                <Loader2 size={11} className="animate-spin" />
                Adding…
              </>
            ) : (
              <>
                {isEasyAdd ? <Zap size={11} /> : <Download size={11} />}
                Install
              </>
            )}
          </button>
        )}
      </div>
    </div>
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
