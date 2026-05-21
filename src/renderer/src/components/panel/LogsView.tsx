/**
 * The Logs tab: a live, persisted activity feed. Every AI call, automation
 * action and permission change is recorded here for full transparency.
 * Filterable by level and category, searchable by free text.
 */
import { useEffect, useMemo, useState } from 'react'
import { Trash2, ScrollText, Search, X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { EmptyState } from '../common/ui'
import { cn, formatTime } from '../../lib/utils'
import type { LogCategory, LogEntry, LogLevel } from '@shared/types'

const LEVEL_DOT: Record<LogLevel, string> = {
  info: 'bg-slate-400',
  success: 'bg-emerald-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400'
}

const LEVEL_OPTIONS: LogLevel[] = ['info', 'success', 'warn', 'error']
const CATEGORY_OPTIONS: LogCategory[] = [
  'ai',
  'automation',
  'permission',
  'screen',
  'system',
  'rag',
  'files-rag',
  'memory',
  'summarizer',
  'mcp'
]

function FilterChip<T extends string>({
  label,
  active,
  onClick,
  dotClass
}: {
  label: T
  active: boolean
  onClick: () => void
  dotClass?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide transition',
        active
          ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-white/10 text-slate-500 hover:border-white/25 hover:text-slate-300'
      )}
    >
      {dotClass && <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />}
      {label}
    </button>
  )
}

export function LogsView(): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set())
  const [categories, setCategories] = useState<Set<LogCategory>>(new Set())

  useEffect(() => {
    void vs.logs.get().then(setLogs)
    const offNew = vs.events.onLog((entry) => setLogs((prev) => [entry, ...prev].slice(0, 500)))
    const offClear = vs.events.onLogCleared(() => setLogs([]))
    return () => {
      offNew()
      offClear()
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((entry) => {
      if (levels.size > 0 && !levels.has(entry.level)) return false
      if (categories.size > 0 && !categories.has(entry.category)) return false
      if (q) {
        const hay = `${entry.message} ${entry.detail ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [logs, query, levels, categories])

  const toggleLevel = (level: LogLevel): void =>
    setLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })

  const toggleCategory = (category: LogCategory): void =>
    setCategories((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })

  const hasFilter = query.trim() !== '' || levels.size > 0 || categories.size > 0
  const clearFilters = (): void => {
    setQuery('')
    setLevels(new Set())
    setCategories(new Set())
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Activity · {hasFilter ? `${filtered.length}/${logs.length}` : logs.length}
        </span>
        <button
          type="button"
          onClick={() => void vs.logs.clear()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>

      <div className="space-y-1.5 border-y border-white/5 bg-black/15 px-3 py-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2 py-1">
          <Search size={12} className="shrink-0 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter activity…"
            className="flex-1 bg-transparent text-[11px] text-slate-100 outline-none placeholder:text-slate-500"
          />
          {hasFilter && (
            <button
              type="button"
              onClick={clearFilters}
              title="Clear all filters"
              className="text-slate-500 transition hover:text-white"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {LEVEL_OPTIONS.map((l) => (
            <FilterChip
              key={l}
              label={l}
              active={levels.has(l)}
              onClick={() => toggleLevel(l)}
              dotClass={LEVEL_DOT[l]}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {CATEGORY_OPTIONS.map((c) => (
            <FilterChip key={c} label={c} active={categories.has(c)} onClick={() => toggleCategory(c)} />
          ))}
        </div>
      </div>

      <div className="scrollbar-void flex-1 overflow-y-auto px-3 py-2">
        {logs.length === 0 ? (
          <EmptyState icon={<ScrollText size={28} />} text="No activity recorded yet." />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<ScrollText size={28} />} text="No activity matches those filters." />
        ) : (
          <ul className="space-y-1">
            {filtered.map((entry) => (
              <li
                key={entry.id}
                className="flex gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[11px]"
              >
                <span
                  className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', LEVEL_DOT[entry.level])}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-slate-200">{entry.message}</p>
                  {entry.detail && (
                    <p className="mt-0.5 break-words font-mono text-[10px] text-slate-500">
                      {entry.detail}
                    </p>
                  )}
                  <p className="mt-0.5 text-[9px] uppercase tracking-wide text-slate-500">
                    {entry.category} · {formatTime(entry.ts)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
