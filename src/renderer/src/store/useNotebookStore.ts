/**
 * Notebook state. Mirrors the SQLite-backed table: a sidebar of summaries
 * (cheap), plus the active notebook's full cell list (loaded on switch).
 *
 * Saves are debounced 800ms so cell edits don't hit the disk per keystroke,
 * but every run flushes synchronously because the runner persists the
 * cell's updated `output`/`status` itself.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { Notebook, NotebookCell, NotebookCellKind, NotebookSummary } from '@shared/types'

const SAVE_DEBOUNCE_MS = 800

let saveTimer: ReturnType<typeof setTimeout> | null = null

interface NotebookState {
  notebooks: NotebookSummary[]
  active: Notebook | null
  ready: boolean
  /** Set of cell ids currently mid-run (for spinner display). */
  running: Set<string>
  /** True while "Run all" is in flight. */
  runningAll: boolean

  load: () => Promise<void>
  switchTo: (id: string) => Promise<void>
  create: () => Promise<Notebook>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>

  patchActive: (patch: Partial<Notebook>) => void
  updateCell: (cellId: string, patch: Partial<NotebookCell>) => void
  addCell: (kind: NotebookCellKind, afterId?: string) => void
  removeCell: (cellId: string) => void
  moveCell: (cellId: string, direction: -1 | 1) => void

  runCell: (cellId: string) => Promise<void>
  runAll: () => Promise<void>
}

function newCell(kind: NotebookCellKind): NotebookCell {
  return {
    id: crypto.randomUUID(),
    kind,
    input: '',
    output: '',
    status: 'idle'
  }
}

function flushSave(): void {
  const state = useNotebookStore.getState()
  if (!state.active) return
  const payload = state.active
  void vs.notebook.save(payload).then((saved) => {
    // Reflect the persisted updatedAt without clobbering any in-flight edits.
    useNotebookStore.setState((s) => ({
      active: s.active?.id === saved.id ? { ...s.active, updatedAt: saved.updatedAt } : s.active,
      notebooks: s.notebooks.map((n) =>
        n.id === saved.id
          ? { ...n, title: saved.title, updatedAt: saved.updatedAt, cellCount: saved.cells.length }
          : n
      )
    }))
  })
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushSave()
  }, SAVE_DEBOUNCE_MS)
}

export const useNotebookStore = create<NotebookState>((set, get) => ({
  notebooks: [],
  active: null,
  ready: false,
  running: new Set(),
  runningAll: false,

  load: async () => {
    const notebooks = await vs.notebook.list()
    set({ notebooks, ready: true })
  },

  switchTo: async (id) => {
    // Flush any pending debounced save before navigating — otherwise the
    // active notebook's last 800ms of edits never reach disk.
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      flushSave()
    }
    const notebook = await vs.notebook.get(id)
    if (notebook) set({ active: notebook })
  },

  create: async () => {
    const notebook = await vs.notebook.create()
    set((s) => ({
      notebooks: [
        {
          id: notebook.id,
          title: notebook.title,
          createdAt: notebook.createdAt,
          updatedAt: notebook.updatedAt,
          cellCount: notebook.cells.length
        },
        ...s.notebooks
      ],
      active: notebook
    }))
    return notebook
  },

  rename: async (id, title) => {
    const summary = await vs.notebook.rename(id, title)
    if (!summary) return
    set((s) => ({
      notebooks: s.notebooks.map((n) => (n.id === id ? summary : n)),
      active: s.active?.id === id ? { ...s.active, title: summary.title } : s.active
    }))
  },

  remove: async (id) => {
    const next = await vs.notebook.delete(id)
    set((s) => ({
      notebooks: next,
      active: s.active?.id === id ? null : s.active
    }))
  },

  patchActive: (patch) => {
    set((s) => (s.active ? { active: { ...s.active, ...patch } } : s))
    scheduleSave()
  },

  updateCell: (cellId, patch) => {
    set((s) => {
      if (!s.active) return s
      return {
        active: {
          ...s.active,
          cells: s.active.cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c))
        }
      }
    })
    scheduleSave()
  },

  addCell: (kind, afterId) => {
    set((s) => {
      if (!s.active) return s
      const cell = newCell(kind)
      const cells = [...s.active.cells]
      if (afterId) {
        const idx = cells.findIndex((c) => c.id === afterId)
        cells.splice(idx + 1, 0, cell)
      } else {
        cells.push(cell)
      }
      return { active: { ...s.active, cells } }
    })
    scheduleSave()
  },

  removeCell: (cellId) => {
    set((s) =>
      s.active
        ? { active: { ...s.active, cells: s.active.cells.filter((c) => c.id !== cellId) } }
        : s
    )
    scheduleSave()
  },

  moveCell: (cellId, direction) => {
    set((s) => {
      if (!s.active) return s
      const cells = [...s.active.cells]
      const idx = cells.findIndex((c) => c.id === cellId)
      const target = idx + direction
      if (idx < 0 || target < 0 || target >= cells.length) return s
      ;[cells[idx], cells[target]] = [cells[target], cells[idx]]
      return { active: { ...s.active, cells } }
    })
    scheduleSave()
  },

  runCell: async (cellId) => {
    const { active } = get()
    if (!active) return
    // Flush any pending text edits so the runner sees the latest input.
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      flushSave()
    }
    set((s) => {
      const next = new Set(s.running)
      next.add(cellId)
      return {
        running: next,
        active: s.active
          ? {
              ...s.active,
              cells: s.active.cells.map((c) =>
                c.id === cellId ? { ...c, status: 'running', error: undefined } : c
              )
            }
          : s.active
      }
    })
    const updated = await vs.notebook.runCell(active.id, cellId)
    set((s) => {
      const next = new Set(s.running)
      next.delete(cellId)
      // Guard against a thread switch mid-run — only swap state in if the
      // user is still looking at the notebook this run was for.
      return {
        running: next,
        active: s.active?.id === active.id ? (updated ?? s.active) : s.active
      }
    })
  },

  runAll: async () => {
    const { active } = get()
    if (!active) return
    set({ runningAll: true })
    const updated = await vs.notebook.runAll(active.id)
    set({ runningAll: false, active: updated ?? get().active })
  }
}))
