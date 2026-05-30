/**
 * Settings panel for the Vector-store browser (v2.0).
 *
 * File RAG used to be a black box — the user added a folder, the assistant
 * cited passages, the user never saw what was actually in the index. This
 * panel exposes the index three ways:
 *
 *   1. **Browse** — folder → file → chunk drill-down. See what's indexed,
 *      preview the actual chunk text, exclude noisy chunks.
 *   2. **Last query trace** — what did the chat layer just retrieve for the
 *      user's most recent question? Each chunk shown with its cosine score
 *      so the user can tell the assistant "use the third one, not the
 *      first" or exclude a chunk that keeps surfacing irrelevantly.
 *   3. **Query explorer** — type any query, see what would be retrieved
 *      (without injecting it anywhere). Lets the user probe the index
 *      before relying on it for a chat.
 *
 * All read-only against the existing SQLite embeddings table. Excluding a
 * chunk removes its row via the existing `removeByIds` path; re-indexing
 * the source file via Rescan brings it back, which is the right semantic
 * ("noise until the file changes").
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Boxes, Database, FileText, Loader2, Search, Trash2, X } from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { basename, cn } from '../../lib/utils'
import type {
  VectorStoreChunkRow,
  VectorStoreFileSummary,
  VectorStoreQueryTrace,
  VectorStoreStats
} from '@shared/types'

type Tab = 'browse' | 'trace' | 'explore'

/** Cap on rows rendered up-front. A UE5-class project can index 10k+ files
 *  with hundreds of chunks each; rendering them all on first open chokes
 *  the panel. The "show more" affordance lets power users page in batches
 *  without us reaching for react-window for what's basically a list. */
const INITIAL_RENDER_CAP = 100

/** Static — declared at module scope so React doesn't re-allocate on every
 *  ExploreTab render (replaces a useMemo whose deps were empty). */
const SOURCE_OPTIONS: ReadonlyArray<{
  id: 'all' | 'chat' | 'file'
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'file', label: 'Files' },
  { id: 'chat', label: 'Chat' }
]

export function VectorStoreSettings(): JSX.Element {
  const [tab, setTab] = useState<Tab>('browse')
  const [stats, setStats] = useState<VectorStoreStats | null>(null)

  // Load once on mount; mutations (exclude / clear) re-fetch via the
  // refreshStats callback passed to each tab. Previously this fired on
  // every tab switch, which paid for two GROUP BYs the user wasn't
  // asking for. Tab switches don't change index contents.
  const refreshStats = useCallback(() => {
    void vs.vectorStore.stats().then(setStats)
  }, [])
  useEffect(() => {
    refreshStats()
  }, [refreshStats])

  return (
    <CollapsibleSection
      title="Vector Store"
      hint="Inspect what's actually indexed, see what the assistant retrieved for the last question, and prune noisy chunks."
    >
      <div className="space-y-2">
        <StatsChip stats={stats} />
        <TabBar tab={tab} setTab={setTab} />
        {tab === 'browse' && <BrowseTab onMutate={refreshStats} />}
        {tab === 'trace' && <TraceTab onMutate={refreshStats} />}
        {tab === 'explore' && <ExploreTab />}
      </div>
    </CollapsibleSection>
  )
}

/* --------------------------------- shell --------------------------------- */

function StatsChip({ stats }: { stats: VectorStoreStats | null }): JSX.Element {
  if (!stats) {
    return (
      <div className="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[10px] text-slate-500">
        <Loader2 size={11} className="animate-spin" />
        Loading index stats…
      </div>
    )
  }
  return (
    <div className="glass-soft flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5 text-[10px] text-slate-300">
      <span className="flex items-center gap-1">
        <Database size={11} className="text-[var(--accent)]" />
        <strong className="font-mono text-slate-100">
          {stats.totalChunks.toLocaleString()}
        </strong>{' '}
        chunk{stats.totalChunks === 1 ? '' : 's'}
      </span>
      <span className="text-slate-500">·</span>
      <span>
        <strong className="font-mono text-slate-100">{stats.fileChunks.toLocaleString()}</strong>{' '}
        file
      </span>
      <span>
        <strong className="font-mono text-slate-100">{stats.chatChunks.toLocaleString()}</strong>{' '}
        chat
      </span>
      {stats.activeModel && (
        <>
          <span className="text-slate-500">·</span>
          <span className="font-mono text-slate-400" title="Active embedding model">
            {stats.activeModel}
          </span>
        </>
      )}
      {stats.modelCount > 1 && (
        <span
          className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 text-[9px] text-amber-200"
          title={`${stats.modelCount} embedding models present — older rows from a previous provider are unreachable to search. Clear them via the AI tab's "Embedding engine" picker.`}
        >
          <AlertTriangle size={9} />
          {stats.modelCount} models
        </span>
      )}
    </div>
  )
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }): JSX.Element {
  const tabs: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'browse', label: 'Browse', icon: <Boxes size={11} /> },
    { id: 'trace', label: 'Last query', icon: <Search size={11} /> },
    { id: 'explore', label: 'Explore', icon: <Search size={11} /> }
  ]
  return (
    <div className="flex gap-1">
      {tabs.map((t) => {
        const active = tab === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition',
              active
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
            )}
          >
            {t.icon}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------- browse --------------------------------- */

function BrowseTab({ onMutate }: { onMutate: () => void }): JSX.Element {
  const [files, setFiles] = useState<VectorStoreFileSummary[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // How many file rows to render. Starts at the cap; a "show all" button
  // pages the rest in for power users with large indexes.
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_CAP)

  useEffect(() => {
    let cancelled = false
    void vs.vectorStore
      .listFiles()
      .then((result) => {
        if (!cancelled) setFiles(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[11px] text-rose-200">
        Couldn&apos;t load indexed files: {error}
      </div>
    )
  }
  if (files === null) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-slate-500">
        <Loader2 size={11} className="animate-spin" />
        Loading…
      </div>
    )
  }
  if (files.length === 0) {
    return (
      <p className="px-2.5 py-1.5 text-[11px] text-slate-500">
        No file chunks indexed yet. Add a folder under <strong>File Knowledge</strong> above.
      </p>
    )
  }

  const visible = files.slice(0, renderLimit)
  const hiddenCount = files.length - visible.length

  return (
    <div className="space-y-1">
      {visible.map((file) => (
        <FileRow
          key={file.filePath}
          file={file}
          isOpen={expanded === file.filePath}
          onToggle={() => setExpanded(expanded === file.filePath ? null : file.filePath)}
          onMutate={() => {
            // Re-fetch the file list since chunk-count may have changed.
            void vs.vectorStore.listFiles().then(setFiles)
            onMutate()
          }}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setRenderLimit((n) => n + INITIAL_RENDER_CAP)}
          className="w-full rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          Show {Math.min(hiddenCount, INITIAL_RENDER_CAP)} more
          {hiddenCount > INITIAL_RENDER_CAP && ` (${hiddenCount} hidden)`}
        </button>
      )}
    </div>
  )
}

function FileRow({
  file,
  isOpen,
  onToggle,
  onMutate
}: {
  file: VectorStoreFileSummary
  isOpen: boolean
  onToggle: () => void
  onMutate: () => void
}): JSX.Element {
  const [chunks, setChunks] = useState<VectorStoreChunkRow[] | null>(null)
  const [loadingChunks, setLoadingChunks] = useState(false)
  const [chunkRenderLimit, setChunkRenderLimit] = useState(INITIAL_RENDER_CAP)

  useEffect(() => {
    if (!isOpen || chunks !== null) return
    setLoadingChunks(true)
    void vs.vectorStore
      .listChunks(file.filePath)
      .then((result) => {
        setChunks(result)
      })
      .finally(() => setLoadingChunks(false))
  }, [isOpen, file.filePath, chunks])

  const visibleChunks = chunks?.slice(0, chunkRenderLimit) ?? null
  const hiddenChunkCount = chunks ? chunks.length - (visibleChunks?.length ?? 0) : 0

  return (
    <div className="glass-soft rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition hover:bg-white/5"
      >
        <FileText size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-slate-100" title={file.filePath}>
            {basename(file.filePath)}
          </p>
          <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500" title={file.filePath}>
            {file.filePath}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[9px] font-mono text-slate-300">
          {file.chunkCount}
        </span>
      </button>
      {isOpen && (
        <div className="border-t border-white/5 px-2.5 pb-2 pt-1.5">
          {loadingChunks ? (
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <Loader2 size={11} className="animate-spin" />
              Loading {file.chunkCount} chunks…
            </div>
          ) : visibleChunks && visibleChunks.length > 0 ? (
            <div className="space-y-1">
              {visibleChunks.map((chunk) => (
                <ChunkRow
                  key={chunk.id}
                  chunk={chunk}
                  onExcluded={() => {
                    setChunks((prev) => prev?.filter((c) => c.id !== chunk.id) ?? null)
                    onMutate()
                  }}
                />
              ))}
              {hiddenChunkCount > 0 && (
                <button
                  type="button"
                  onClick={() => setChunkRenderLimit((n) => n + INITIAL_RENDER_CAP)}
                  className="w-full rounded border border-white/10 px-2 py-0.5 text-[9px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
                >
                  Show {Math.min(hiddenChunkCount, INITIAL_RENDER_CAP)} more
                  {hiddenChunkCount > INITIAL_RENDER_CAP && ` (${hiddenChunkCount} hidden)`}
                </button>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-slate-500">No chunks (file may have been removed).</p>
          )}
        </div>
      )}
    </div>
  )
}

function ChunkRow({
  chunk,
  onExcluded
}: {
  chunk: VectorStoreChunkRow
  onExcluded: () => void
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  const handleExclude = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.vectorStore.exclude([chunk.id])
      pushToast(
        'info',
        chunk.filePath
          ? `Excluded chunk ${chunk.chunkIndex ?? ''} from ${basename(chunk.filePath)}. Rescan the file to bring it back.`
          : 'Chunk excluded.'
      )
      onExcluded()
    } catch (err) {
      pushToast('error', `Couldn't exclude: ${err instanceof Error ? err.message : String(err)}`)
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-md bg-black/20 px-2 py-1.5">
      <span className="mt-0.5 shrink-0 rounded bg-white/10 px-1 font-mono text-[9px] text-slate-400">
        #{chunk.chunkIndex ?? '?'}
      </span>
      <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-slate-300">{chunk.preview}</p>
      {typeof chunk.score === 'number' && (
        <span
          className="shrink-0 self-center rounded-full bg-[var(--accent-soft)] px-1.5 text-[9px] font-mono text-[var(--accent)]"
          title="Cosine similarity to the query"
        >
          {chunk.score.toFixed(2)}
        </span>
      )}
      <button
        type="button"
        onClick={() => void handleExclude()}
        disabled={busy}
        title="Exclude this chunk from retrieval (re-add by rescanning the file)"
        aria-label="Exclude this chunk from retrieval"
        aria-busy={busy || undefined}
        className="shrink-0 rounded-md p-0.5 text-slate-500 transition hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40"
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
      </button>
    </div>
  )
}

/* --------------------------------- trace --------------------------------- */

function TraceTab({ onMutate }: { onMutate: () => void }): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [trace, setTrace] = useState<VectorStoreQueryTrace | null | undefined>(undefined)

  // Stable across renders so the Clear button + the post-exclude refresh
  // both call the same instance. Plain useCallback would also work but a
  // tiny one-line helper reads cleaner here.
  const refresh = useCallback(() => {
    void vs.vectorStore.queryTrace().then(setTrace)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (trace === undefined) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-slate-500">
        <Loader2 size={11} className="animate-spin" />
        Loading…
      </div>
    )
  }
  if (trace === null) {
    return (
      <p className="px-2.5 py-1.5 text-[11px] text-slate-500">
        No retrievals yet this session. Ask the assistant a question that uses RAG, then come back
        here to see what it grabbed.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="glass-soft rounded-lg px-2.5 py-1.5 text-[10px]">
        <p className="text-slate-400">Query · {new Date(trace.ranAt).toLocaleString()}</p>
        <p className="mt-0.5 text-[11px] text-slate-100">{trace.query}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-slate-500">
          {trace.hits.length} chunk{trace.hits.length === 1 ? '' : 's'} retrieved
        </span>
        <button
          type="button"
          onClick={() => {
            void vs.vectorStore.clearTrace().then(() => {
              setTrace(null)
              pushToast('info', 'Trace cleared.')
            })
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          <Trash2 size={10} />
          Clear
        </button>
      </div>
      {trace.hits.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[10px] text-slate-500">
          The query returned no matches above the relevance threshold.
        </p>
      ) : (
        <div className="space-y-1">
          {trace.hits.map((chunk) => (
            <ChunkRow
              key={chunk.id}
              chunk={chunk}
              onExcluded={() => {
                // Strip from the local view; the trace itself is server-
                // authoritative so re-fetch keeps things honest.
                refresh()
                onMutate()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------- explore -------------------------------- */

function ExploreTab(): JSX.Element {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'chat' | 'file'>('all')
  const [results, setResults] = useState<VectorStoreChunkRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRun = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const hits = await vs.vectorStore.explain(trimmed, {
        limit: 10,
        source: source === 'all' ? undefined : source
      })
      setResults(hits)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500">
        Type a query to see what the assistant would retrieve. Doesn&apos;t send anything to the AI
        — just runs the same similarity search the chat layer uses.
      </p>
      <div className="flex gap-1">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleRun()
            }
          }}
          placeholder="What's in my notes about… ?"
          aria-label="Retrieval-trace query"
          className="flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
        />
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={busy || !query.trim()}
          className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
          Search
        </button>
      </div>
      <div className="flex gap-1">
        {SOURCE_OPTIONS.map((opt) => {
          const active = source === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSource(opt.id)}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[9px] font-medium transition',
                active
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      {results !== null && (
        <div className="space-y-1">
          {results.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[10px] text-slate-500">
              No matches above the relevance threshold.
            </p>
          ) : (
            results.map((chunk) => (
              <ChunkRow
                key={chunk.id}
                chunk={chunk}
                onExcluded={() => {
                  // Re-run so subsequent results drop the excluded id.
                  void handleRun()
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
