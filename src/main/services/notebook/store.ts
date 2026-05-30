/**
 * SQLite-backed notebook store. Each notebook is one row whose `cells` column
 * is a JSON array; the cell list is treated atomically since notebooks rarely
 * have more than a few dozen cells and we always read/write whole files in
 * the renderer's editor anyway.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../storage/db'
import type { Notebook, NotebookCell, NotebookSummary } from '@shared/types'

interface NotebookRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  cells: string
}

function rowToNotebook(row: NotebookRow): Notebook {
  let cells: NotebookCell[] = []
  try {
    const parsed = JSON.parse(row.cells) as unknown
    if (Array.isArray(parsed)) cells = parsed as NotebookCell[]
  } catch {
    // Corrupt JSON shouldn't bury the notebook — surface as empty so the
    // user can rebuild rather than losing the whole row.
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cells
  }
}

function rowToSummary(row: NotebookRow): NotebookSummary {
  let count = 0
  try {
    const parsed = JSON.parse(row.cells) as unknown
    if (Array.isArray(parsed)) count = parsed.length
  } catch {
    /* count stays 0 — same defensive posture as rowToNotebook */
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cellCount: count
  }
}

/* ----------------------------- queries ------------------------------ */

export function listNotebooks(): NotebookSummary[] {
  const rows = db()
    .prepare(`SELECT * FROM notebooks ORDER BY updated_at DESC`)
    .all() as NotebookRow[]
  return rows.map(rowToSummary)
}

export function getNotebook(id: string): Notebook | null {
  const row = db().prepare(`SELECT * FROM notebooks WHERE id = ?`).get(id) as
    | NotebookRow
    | undefined
  return row ? rowToNotebook(row) : null
}

/* ----------------------------- mutations ---------------------------- */

export function createNotebook(title?: string): Notebook {
  const id = randomUUID()
  const now = new Date().toISOString()
  const cells: NotebookCell[] = [
    {
      id: randomUUID(),
      kind: 'markdown',
      input:
        '## New notebook\n\nWrite, run, chain cells. Reference earlier outputs with `{{cell-1}}`.',
      output: '',
      status: 'idle'
    }
  ]
  db()
    .prepare(
      `INSERT INTO notebooks (id, title, created_at, updated_at, cells)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, title?.trim() || 'New notebook', now, now, JSON.stringify(cells))
  return {
    id,
    title: title?.trim() || 'New notebook',
    createdAt: now,
    updatedAt: now,
    cells
  }
}

/** Persists an entire notebook (cells included). Returns the updated row. */
export function saveNotebook(notebook: Notebook): Notebook {
  const now = new Date().toISOString()
  db()
    .prepare(
      `UPDATE notebooks
       SET title = ?, updated_at = ?, cells = ?
       WHERE id = ?`
    )
    .run(notebook.title || 'Untitled', now, JSON.stringify(notebook.cells), notebook.id)
  return { ...notebook, updatedAt: now }
}

export function renameNotebook(id: string, title: string): NotebookSummary | null {
  const info = db()
    .prepare(`UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || 'Untitled', new Date().toISOString(), id)
  if (info.changes === 0) return null
  const row = db().prepare(`SELECT * FROM notebooks WHERE id = ?`).get(id) as NotebookRow
  return rowToSummary(row)
}

export function deleteNotebook(id: string): NotebookSummary[] {
  db().prepare(`DELETE FROM notebooks WHERE id = ?`).run(id)
  return listNotebooks()
}
