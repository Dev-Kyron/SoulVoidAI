/**
 * Plugin manager. Two tabs:
 *  · Installed — lists workflow packs on disk, lets each be enabled or
 *    disabled, surfaces validation errors, and runs a plugin's quick
 *    actions directly.
 *  · Browse    — fetches the curated public registry, shows install cards.
 *
 * Plugins are declarative JSON — no code execution. Installing a plugin
 * from the marketplace writes its manifest into the plugins folder and
 * reloads the registry; the actions become available immediately.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Users
} from 'lucide-react'
import { usePluginStore } from '../../store/usePluginStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { runAction } from '../../lib/actions'
import { resolveIcon } from '../../lib/icons'
import { vs } from '../../lib/bridge'
import { cn, isSafeExternalUrl } from '../../lib/utils'
import { EmptyState, Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { AgentReadinessNotice } from './AgentReadinessNotice'
import type { PluginInfo, PluginRegistryEntry, QuickAction } from '@shared/types'

type Tab = 'installed' | 'browse'

export function PluginSettings(): JSX.Element {
  const plugins = usePluginStore((s) => s.plugins)
  const actions = usePluginStore((s) => s.actions)
  const load = usePluginStore((s) => s.load)
  const pluginHooksOn = useConfigStore((s) => s.config?.chat.pluginHooks ?? false)
  const setPluginHooks = useConfigStore((s) => s.setPluginHooks)
  const [tab, setTab] = useState<Tab>('installed')

  useEffect(() => {
    void load()
  }, [load])

  // v2.0 — true when any installed plugin declares JS hooks. Drives the
  // "you have JS-enabled plugins, here's the master switch" banner.
  // Computed inline (cheap — plugin lists rarely top a dozen entries).
  const hasJsHooks = plugins.some((p) => (p.hookCount ?? 0) > 0)

  return (
    <CollapsibleSection
      title="Plugins"
      hint="Workflow packs that add quick actions. Most are pure JSON; v2.0 plugins can also subscribe to JS lifecycle hooks if you opt in."
    >
      {/* v1.12.6 — agent-readiness banner. Plugin actions are routed through
       * the same permission/tool pipeline, so the "inert without agent mode"
       * gap applies here too. */}
      <AgentReadinessNotice />

      {/* v2.0 — master JS-hook toggle. Only renders when at least one
          installed plugin actually declares hooks; no need to show a
          warning surface to users with pure-JSON plugins. */}
      {hasJsHooks && (
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200">
                <AlertTriangle size={11} />
                Plugin JavaScript hooks
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-amber-200/80">
                One or more installed plugins declare JS hook handlers that run in the main process
                with full Node access. Off by default — turn this on only after reviewing the code
                of each plugin you trust. Individual plugins must also be enabled.
              </p>
            </div>
            <Toggle checked={pluginHooksOn} onChange={(v) => void setPluginHooks(v)} />
          </div>
        </div>
      )}

      {/* Tab bar — Installed / Browse. Two-button radio group rather than
          a fancy tab strip; this is settings, not a primary nav. */}
      <div className="mb-3 flex gap-1 rounded-lg border border-white/10 p-0.5">
        <TabButton
          current={tab}
          value="installed"
          onClick={setTab}
          label="Installed"
          count={plugins.length}
        />
        <TabButton
          current={tab}
          value="browse"
          onClick={setTab}
          label="Browse"
          icon={<Store size={11} />}
        />
      </div>

      {tab === 'installed' ? (
        <InstalledTab plugins={plugins} actions={actions} />
      ) : (
        <BrowseTab installedIds={new Set(plugins.map((p) => p.id))} />
      )}
    </CollapsibleSection>
  )
}

/* ----------------------------- Tab bar -------------------------------- */

function TabButton({
  current,
  value,
  onClick,
  label,
  count,
  icon
}: {
  current: Tab
  value: Tab
  onClick: (v: Tab) => void
  label: string
  count?: number
  icon?: JSX.Element
}): JSX.Element {
  const active = current === value
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      )}
    >
      {icon}
      {label}
      {typeof count === 'number' && count > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 text-[9px]',
            active ? 'bg-white/15' : 'bg-white/10 text-slate-500'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/* --------------------------- Installed tab ---------------------------- */

function InstalledTab({
  plugins,
  actions
}: {
  plugins: PluginInfo[]
  actions: QuickAction[]
}): JSX.Element {
  const setEnabled = usePluginStore((s) => s.setEnabled)
  const reload = usePluginStore((s) => s.reload)
  return (
    <>
      <div className="mb-2 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={() => void reload()}
          className="flex items-center gap-1 text-[10px] text-slate-400 transition hover:text-white"
        >
          <RefreshCw size={11} />
          Reload
        </button>
        <button
          type="button"
          onClick={() => void vs.plugins.openFolder()}
          className="flex items-center gap-1 text-[10px] text-slate-400 transition hover:text-white"
        >
          <FolderOpen size={11} />
          Folder
        </button>
      </div>

      <div className="space-y-1.5">
        {plugins.length === 0 && (
          <EmptyState
            icon={<Puzzle size={20} />}
            title="No plugins installed yet"
            hint="Browse the community marketplace, or drop a plugin folder into the plugins directory."
            action={{
              label: 'Open plugins folder',
              onClick: () => void vs.plugins.openFolder()
            }}
          />
        )}
        {plugins.map((plugin) => {
          const pluginActions = actions.filter((a) => a.id.startsWith(`${plugin.id}:`))
          return (
            <div key={plugin.file} className="glass-soft rounded-lg px-2.5 py-2">
              <div className="flex items-start gap-2">
                <Puzzle size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[11px] font-semibold text-white">{plugin.name}</p>
                    {plugin.version && (
                      <span className="text-[9px] text-slate-500">v{plugin.version}</span>
                    )}
                  </div>
                  <p
                    className={
                      plugin.error
                        ? 'text-[10px] text-rose-400'
                        : 'text-[10px] leading-snug text-slate-400'
                    }
                  >
                    {plugin.error ?? plugin.description}
                  </p>
                  {!plugin.error && (
                    <p className="mt-0.5 text-[9px] text-slate-500">
                      {plugin.author} · {plugin.actionCount} action
                      {plugin.actionCount === 1 ? '' : 's'}
                    </p>
                  )}
                </div>
                {plugin.error ? (
                  <AlertTriangle size={14} className="shrink-0 text-rose-400" />
                ) : (
                  <Toggle
                    checked={plugin.enabled}
                    onChange={(value) => void setEnabled(plugin.id, value)}
                  />
                )}
              </div>

              {plugin.enabled && pluginActions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {pluginActions.map((action) => {
                    const Icon = resolveIcon(action.icon)
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => void runAction(action.action, action.label)}
                        className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                      >
                        <Icon size={11} />
                        {action.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Plugins are declarative JSON workflow packs. They bundle permission-gated quick actions — no
        code execution. Copy <span className="text-slate-400">example-pack.json</span> in the
        plugins folder to build your own.
      </p>
    </>
  )
}

/* ----------------------------- Browse tab ----------------------------- */

function BrowseTab({ installedIds }: { installedIds: Set<string> }): JSX.Element {
  const registry = usePluginStore((s) => s.registry)
  const registryError = usePluginStore((s) => s.registryError)
  const registryBusy = usePluginStore((s) => s.registryBusy)
  const browseRegistry = usePluginStore((s) => s.browseRegistry)
  const pushToast = useUiStore((s) => s.pushToast)
  const [filter, setFilter] = useState('')

  // First mount of the tab — kick off the registry fetch lazily so the
  // installed view doesn't pay the network cost when the user never
  // browses. browseRegistry caches; re-mounts after the first fetch are
  // instant.
  useEffect(() => {
    void browseRegistry()
  }, [browseRegistry])

  // v2.0 polish — surface registry-load failures via the toast layer too,
  // not just the inline rose panel. pushToast mirrors into the LiveRegion
  // so SR users hear "Couldn't load plugin registry — <reason>" instead
  // of silently staring at a visual error they can't read. We snapshot
  // the previous error so the toast only fires on the transition (null →
  // non-null), not every render that still shows the error state.
  const lastReportedError = useRef<string | null>(null)
  useEffect(() => {
    if (registryError && registryError !== lastReportedError.current) {
      lastReportedError.current = registryError
      pushToast('error', `Plugin registry: ${registryError}`)
    } else if (!registryError) {
      lastReportedError.current = null
    }
  }, [registryError, pushToast])

  const filtered = useMemo(() => {
    if (!registry) return null
    const needle = filter.trim().toLowerCase()
    if (!needle) return registry
    return registry.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.description.toLowerCase().includes(needle) ||
        (e.author?.toLowerCase().includes(needle) ?? false) ||
        (e.tags?.some((t) => t.toLowerCase().includes(needle)) ?? false)
    )
  }, [registry, filter])

  if (registryError) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-200">
        <p className="font-semibold">Couldn&apos;t load the registry.</p>
        <p className="mt-0.5 text-[10px] text-rose-300/80">{registryError}</p>
        <button
          type="button"
          onClick={() => void browseRegistry(true)}
          className="mt-2 flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-[10px] text-rose-200 transition hover:bg-rose-500/20"
        >
          <RefreshCw size={10} />
          Try again
        </button>
      </div>
    )
  }

  if (!registry || registryBusy) {
    return (
      <div className="flex h-24 items-center justify-center text-[11px] text-slate-500">
        <span className="animate-pulse">Loading marketplace…</span>
      </div>
    )
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={10}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search the marketplace…"
            aria-label="Search the plugin marketplace"
            className="w-full rounded-md border border-white/10 bg-black/30 py-1 pl-7 pr-2 text-[11px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-[var(--accent-ring)]"
          />
        </div>
        <button
          type="button"
          onClick={() => void browseRegistry(true)}
          title="Refresh registry"
          aria-label="Refresh registry"
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {(filtered ?? []).length === 0 ? (
        <EmptyState
          icon={<Store size={20} />}
          title={filter ? 'No matches' : 'Marketplace is empty'}
          hint={
            filter
              ? 'Try a different search term.'
              : 'No community plugins published yet — be the first to submit one via the project repo.'
          }
        />
      ) : (
        <div className="space-y-1.5">
          {(filtered ?? []).map((entry) => (
            <RegistryCard key={entry.id} entry={entry} installed={installedIds.has(entry.id)} />
          ))}
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
        Plugins from the marketplace are signed by the studio — they bundle the same
        permission-gated actions any plugin uses, no code runs. Review the actions before enabling.
      </p>
    </>
  )
}

function RegistryCard({
  entry,
  installed
}: {
  entry: PluginRegistryEntry
  installed: boolean
}): JSX.Element {
  const install = usePluginStore((s) => s.install)
  const pushToast = useUiStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)

  // v2.0 — community PR submission marker. Curated entries (studio-published)
  // get a "Verified" badge; community entries get an open-source badge plus
  // the submitter handle. Validators force missing/invalid source to
  // 'curated' so a pre-2.0 entry never accidentally badges as community.
  const isCommunity = entry.source === 'community'
  const hookCount = entry.hooks ? Object.keys(entry.hooks).length : 0
  // v2.0 polish — mirror the MarketplaceCard memoisation pattern. Without
  // this, every parent re-render (filter change, install completes,
  // installedIds set rebuilds) ran a fresh `new URL(entry.repoUrl)` and
  // re-formatted the date. Both inputs are immutable for the card's
  // lifetime, so memoising on the entry id is sufficient.
  const submittedAtLabel = useMemo(
    () => (entry.submittedAt ? new Date(entry.submittedAt).toLocaleDateString() : null),
    [entry.submittedAt]
  )
  const safeRepoUrl = useMemo(
    () => (entry.repoUrl && isSafeExternalUrl(entry.repoUrl) ? entry.repoUrl : null),
    [entry.repoUrl]
  )
  // Extra-warn when a community-submitted entry runs JavaScript. The
  // master hooks switch is still required to actually fire them, but the
  // user deserves to see this BEFORE they click Install — a stranger's
  // code running in-process is a meaningfully different consent than a
  // declarative `open-url` action.
  const showCommunityCodeWarning = isCommunity && hookCount > 0

  const handleInstall = async (): Promise<void> => {
    if (busy || installed) return
    if (showCommunityCodeWarning) {
      const confirmed = window.confirm(
        `"${entry.name}" was submitted by ${entry.submittedBy ?? 'a community contributor'} ` +
          `and declares ${hookCount} JavaScript hook${hookCount === 1 ? '' : 's'} that ` +
          `run in-process when enabled.\n\nReview the source before installing.\n\nInstall anyway?`
      )
      if (!confirmed) return
    }
    setBusy(true)
    try {
      await install(entry)
      pushToast('success', `Installed ${entry.name}.`)
    } catch (err) {
      pushToast('error', `Install failed — ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass-soft rounded-lg px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Puzzle size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[11px] font-semibold text-white">{entry.name}</p>
            <span className="text-[9px] text-slate-500">v{entry.version}</span>
            {/* Trust badge — small, always visible. Curated wears the
                emerald shield; community wears the slate "users" mark. */}
            {isCommunity ? (
              <span
                className="flex items-center gap-0.5 rounded-full bg-slate-500/15 px-1.5 text-[9px] font-medium text-slate-300"
                title="Community-submitted via public PR. Review before install."
              >
                <Users size={9} />
                Community
              </span>
            ) : (
              <span
                className="flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[9px] font-medium text-emerald-300"
                title="Studio-curated entry."
              >
                <ShieldCheck size={9} />
                Verified
              </span>
            )}
            {hookCount > 0 && (
              <span
                className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 text-[9px] font-medium text-amber-200"
                title={`Runs ${hookCount} JavaScript hook${hookCount === 1 ? '' : 's'} when enabled (master switch in Plugins → Hooks).`}
              >
                <AlertTriangle size={9} />
                Runs JS
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{entry.description}</p>
          <p className="mt-0.5 text-[9px] text-slate-500">
            {entry.author ?? 'Unknown'}
            {entry.submittedBy && entry.submittedBy !== entry.author && (
              <span> · submitted by {entry.submittedBy}</span>
            )}
            {submittedAtLabel && <span> · added {submittedAtLabel}</span>}
            <span>
              {' '}
              · {entry.quickActions.length} action
              {entry.quickActions.length === 1 ? '' : 's'}
            </span>
            {entry.tags && entry.tags.length > 0 && (
              <span> · {entry.tags.slice(0, 3).join(', ')}</span>
            )}
            {safeRepoUrl && (
              <>
                {' · '}
                {/* window.open routes through the main BrowserWindow's
                    setWindowOpenHandler → shell.openExternal, so this lands
                    in the user's real browser, not inside the widget.
                    isSafeExternalUrl guards against javascript: / data: /
                    file: URLs a community submission could try to sneak
                    in — the validator already enforces http(s) at PR
                    time, but defence-in-depth at the call site too. */}
                <button
                  type="button"
                  onClick={() => window.open(safeRepoUrl, '_blank', 'noopener,noreferrer')}
                  className="inline-flex items-center gap-0.5 text-slate-400 underline-offset-2 transition hover:text-[var(--accent)] hover:underline"
                >
                  source
                  <ExternalLink size={8} />
                </button>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleInstall()}
          disabled={busy || installed}
          aria-label={installed ? 'Already installed' : `Install ${entry.name}`}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition disabled:cursor-not-allowed',
            installed
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-[var(--accent)] text-white hover:brightness-110 disabled:opacity-60'
          )}
        >
          {installed ? (
            <>
              <Check size={11} />
              Installed
            </>
          ) : busy ? (
            <>
              <RefreshCw size={11} className="animate-spin" />
              Installing…
            </>
          ) : (
            <>
              <Download size={11} />
              Install
            </>
          )}
        </button>
      </div>
    </div>
  )
}
