/**
 * Notebook tab — Jupyter-style cells. Sidebar of notebooks on the left, the
 * active notebook's cell list on the right. Each cell has an input editor,
 * an output region, and Run / Move / Delete controls. Cells reference each
 * other's output via `{{cell-id}}` placeholders (UI surfaces this as a
 * "ref" badge).
 *
 * Heavy lifting lives in `useNotebookStore` + the main-process runner.
 */
import { useEffect, useState } from 'react'
import {
  Plus,
  Play,
  Trash2,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Code,
  Sparkles,
  Search,
  FileText,
  Loader2,
  Copy,
  Check
} from 'lucide-react'
import { useNotebookStore } from '../../store/useNotebookStore'
import { useUiStore } from '../../store/useUiStore'
import { cn, formatTime, relativeTime } from '../../lib/utils'
import type { NotebookCell, NotebookCellKind } from '@shared/types'

const CELL_KINDS: Array<{
  id: NotebookCellKind
  label: string
  icon: typeof Code
  blurb: string
}> = [
  { id: 'prompt', label: 'Prompt', icon: Sparkles, blurb: 'LLM call via active provider' },
  { id: 'python', label: 'Python', icon: Code, blurb: 'Sandboxed run_python execution' },
  { id: 'search', label: 'Search', icon: Search, blurb: 'Live web_search (Tavily)' },
  { id: 'markdown', label: 'Note', icon: FileText, blurb: 'Markdown / narrative only' }
]

function iconFor(kind: NotebookCellKind): typeof Code {
  return CELL_KINDS.find((k) => k.id === kind)?.icon ?? FileText
}

function placeholderFor(kind: NotebookCellKind): string {
  switch (kind) {
    case 'prompt':
      return 'Ask the model. Reference earlier output with {{cell-<id>}}.'
    case 'python':
      return '# Python — stdout/stderr captured.\nprint("hello")'
    case 'search':
      return 'web search query…'
    default:
      return 'Notes for yourself — never executed.'
  }
}

function CellHeader({
  cell,
  index,
  onMoveUp,
  onMoveDown,
  onRun,
  onDelete,
  running
}: {
  cell: NotebookCell
  index: number
  onMoveUp: () => void
  onMoveDown: () => void
  onRun: () => void
  onDelete: () => void
  running: boolean
}): JSX.Element {
  const Icon = iconFor(cell.kind)
  const statusColor =
    cell.status === 'running'
      ? 'bg-amber-400'
      : cell.status === 'ok'
        ? 'bg-emerald-400'
        : cell.status === 'error'
          ? 'bg-rose-400'
          : 'bg-slate-600'
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', statusColor)} />
      <Icon size={12} className="shrink-0 text-[var(--accent)]" />
      <span className="text-[10px] uppercase tracking-wide text-slate-400">
        {cell.kind} · #{index + 1}
      </span>
      {cell.durationMs !== undefined && cell.status === 'ok' && (
        <span className="text-[9px] text-slate-500">{cell.durationMs}ms</span>
      )}
      <span className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          title="Move up"
          className="rounded p-0.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronUp size={11} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          title="Move down"
          className="rounded p-0.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronDown size={11} />
        </button>
        {cell.kind !== 'markdown' && (
          <button
            type="button"
            onClick={onRun}
            disabled={running}
            title="Run this cell"
            className="ml-1 flex items-center gap-1 rounded-md bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {running ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
            Run
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete cell"
          className="ml-1 rounded p-0.5 text-slate-500 transition hover:bg-rose-500/20 hover:text-rose-300"
        >
          <Trash2 size={11} />
        </button>
      </span>
    </div>
  )
}

function CellOutput({ cell }: { cell: NotebookCell }): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  if (cell.status === 'idle') return null
  if (cell.status === 'error') {
    return (
      <div className="border-t border-rose-400/20 bg-rose-500/5 px-2.5 py-1.5 text-[11px] text-rose-200">
        <p className="font-semibold">Failed</p>
        <pre className="scrollbar-void mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-rose-300">
          {cell.error}
        </pre>
      </div>
    )
  }
  if (!cell.output) {
    return (
      <div className="border-t border-white/5 px-2.5 py-1.5 text-[10px] text-slate-500">
        (no output)
      </div>
    )
  }
  return (
    <div className="border-t border-white/5 bg-black/20">
      <div className="flex items-center justify-between px-2.5 pt-1.5 text-[9px] uppercase tracking-wide text-slate-500">
        <span>Output {cell.ranAt ? `· ${formatTime(cell.ranAt)}` : ''}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(cell.output)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }}
          className="flex items-center gap-1 text-slate-500 transition hover:text-slate-200"
        >
          {copied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="scrollbar-void m-0 max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-slate-200">
        {cell.output}
      </pre>
    </div>
  )
}

function CellCard({ cell, index }: { cell: NotebookCell; index: number }): JSX.Element {
  const updateCell = useNotebookStore((s) => s.updateCell)
  const runCell = useNotebookStore((s) => s.runCell)
  const removeCell = useNotebookStore((s) => s.removeCell)
  const moveCell = useNotebookStore((s) => s.moveCell)
  const running = useNotebookStore((s) => s.running.has(cell.id))

  return (
    <div className="glass-soft overflow-hidden rounded-lg border border-white/5">
      <CellHeader
        cell={cell}
        index={index}
        onMoveUp={() => moveCell(cell.id, -1)}
        onMoveDown={() => moveCell(cell.id, 1)}
        onRun={() => void runCell(cell.id)}
        onDelete={() => removeCell(cell.id)}
        running={running}
      />
      <textarea
        value={cell.input}
        onChange={(e) => updateCell(cell.id, { input: e.target.value })}
        placeholder={placeholderFor(cell.kind)}
        rows={Math.min(10, Math.max(2, cell.input.split('\n').length))}
        spellCheck={cell.kind !== 'python' && cell.kind !== 'search'}
        className={cn(
          'scrollbar-void block w-full resize-none border-t border-white/5 bg-black/30 px-2.5 py-1.5 text-[12px] leading-relaxed text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600',
          (cell.kind === 'python' || cell.kind === 'search') && 'font-mono text-[11.5px]'
        )}
      />
      <CellOutput cell={cell} />
    </div>
  )
}

function NotebookSidebar(): JSX.Element {
  const notebooks = useNotebookStore((s) => s.notebooks)
  const active = useNotebookStore((s) => s.active)
  const switchTo = useNotebookStore((s) => s.switchTo)
  const create = useNotebookStore((s) => s.create)
  const remove = useNotebookStore((s) => s.remove)
  const pushToast = useUiStore((s) => s.pushToast)
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-white/5 bg-black/20">
      <button
        type="button"
        onClick={() => void create()}
        className="m-2 flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
      >
        <Plus size={12} />
        New notebook
      </button>
      <div className="scrollbar-void min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {notebooks.length === 0 ? (
          <p className="px-2 py-2 text-[10px] text-slate-500">
            No notebooks yet. Notebooks chain LLM, Python and search cells with shared state.
          </p>
        ) : (
          notebooks.map((nb) => {
            const isActive = active?.id === nb.id
            return (
              <div
                key={nb.id}
                className={cn(
                  'group relative mb-0.5 rounded-md',
                  isActive ? 'bg-[var(--accent-soft)]' : 'hover:bg-white/5'
                )}
              >
                <button
                  type="button"
                  onClick={() => void switchTo(nb.id)}
                  className="w-full px-2 py-1.5 text-left"
                >
                  <p
                    className={cn(
                      'truncate text-[11px] font-medium',
                      isActive ? 'text-[var(--accent)]' : 'text-slate-200'
                    )}
                    title={nb.title}
                  >
                    {nb.title}
                  </p>
                  <p className="text-[9px] text-slate-500">
                    {nb.cellCount} cell{nb.cellCount === 1 ? '' : 's'} ·{' '}
                    {relativeTime(nb.updatedAt)}
                  </p>
                </button>
                {confirming === nb.id ? (
                  <div className="flex gap-1 px-2 pb-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(null)
                        void remove(nb.id).then(() => pushToast('info', `Removed "${nb.title}".`))
                      }}
                      className="flex-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-rose-200 transition hover:bg-rose-500/30"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded px-1.5 py-0.5 text-[9px] text-slate-400 transition hover:bg-white/5"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(nb.id)}
                    title="Delete notebook"
                    className="absolute right-1 top-1 rounded p-0.5 text-slate-500 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-300 group-hover:opacity-100"
                  >
                    <Trash2 size={10} />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}

function AddCellRow({ afterId }: { afterId?: string }): JSX.Element {
  const addCell = useNotebookStore((s) => s.addCell)
  return (
    <div className="flex flex-wrap gap-1 py-1.5">
      {CELL_KINDS.map((kind) => {
        const Icon = kind.icon
        return (
          <button
            key={kind.id}
            type="button"
            onClick={() => addCell(kind.id, afterId)}
            title={kind.blurb}
            className="flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
          >
            <Icon size={10} />
            {kind.label}
          </button>
        )
      })}
    </div>
  )
}

function ActiveNotebook(): JSX.Element {
  const active = useNotebookStore((s) => s.active)
  const rename = useNotebookStore((s) => s.rename)
  const runAll = useNotebookStore((s) => s.runAll)
  const runningAll = useNotebookStore((s) => s.runningAll)
  const [titleDraft, setTitleDraft] = useState(active?.title ?? '')
  const [editingTitle, setEditingTitle] = useState(false)

  useEffect(() => {
    setTitleDraft(active?.title ?? '')
  }, [active?.id, active?.title])

  if (!active) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-slate-500">
        Pick a notebook or create one. Each cell — prompt, Python, search, note — chains by
        referencing prior outputs with <code className="font-mono">{'{{cell-id}}'}</code>.
      </div>
    )
  }

  const cellCount = active.cells.length

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <BookOpen size={14} className="shrink-0 text-[var(--accent)]" />
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              setEditingTitle(false)
              if (titleDraft.trim() && titleDraft.trim() !== active.title) {
                void rename(active.id, titleDraft.trim())
              } else {
                setTitleDraft(active.title)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') {
                setTitleDraft(active.title)
                setEditingTitle(false)
              }
            }}
            className="flex-1 rounded border border-[var(--accent-ring)] bg-black/30 px-1.5 py-0.5 text-[12px] font-semibold text-white outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            className="flex-1 truncate text-left text-[12px] font-semibold text-white transition hover:text-[var(--accent)]"
            title="Click to rename"
          >
            {active.title}
          </button>
        )}
        <span className="text-[9px] text-slate-500">
          {cellCount} cell{cellCount === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={runningAll || cellCount === 0}
          className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          {runningAll ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
          Run all
        </button>
      </header>
      <div className="scrollbar-void min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {active.cells.map((cell, idx) => (
          <CellCard key={cell.id} cell={cell} index={idx} />
        ))}
        <AddCellRow afterId={active.cells[active.cells.length - 1]?.id} />
      </div>
    </div>
  )
}

export function NotebookView(): JSX.Element {
  const load = useNotebookStore((s) => s.load)
  const ready = useNotebookStore((s) => s.ready)
  useEffect(() => {
    void load()
  }, [load])
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
        <span className="animate-pulse">Loading notebooks…</span>
      </div>
    )
  }
  return (
    <div className="flex h-full">
      <NotebookSidebar />
      <ActiveNotebook />
    </div>
  )
}
