/**
 * Project / Collection service. A Project is a named grouping of threads
 * with shared `instructions` that get appended to the global system prompt
 * for any thread in the project. Closes the Claude-Projects feature gap.
 *
 * The schema is intentionally minimal — id, name, optional description,
 * optional instructions, timestamps. Threads link via `threads.project_id`
 * (nullable; NULL = unfiled). Deletes use `ON DELETE SET NULL` on the FK
 * so deleting a project doesn't take its threads with it.
 *
 * Why a separate module from history.ts? The thread-level functions are
 * already substantial; keeping projects separate makes the abstraction
 * boundary obvious and lets future "file context per project" additions
 * land in one place without growing the history.ts surface further.
 */
import { randomUUID } from 'node:crypto'
import { db } from './db'
import type { Project } from '@shared/types'

interface ProjectRow {
  id: string
  name: string
  description: string | null
  instructions: string | null
  created_at: string
  updated_at: string
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** All projects, newest first. */
export function listProjects(): Project[] {
  const rows = db().prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as ProjectRow[]
  return rows.map(rowToProject)
}

/** Single project by id, or null if not found. */
export function getProject(id: string): Project | null {
  const row = db().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

export interface NewProjectInput {
  name: string
  description?: string | null
  instructions?: string | null
}

/** Creates a project, returning the persisted record. */
export function createProject(input: NewProjectInput): Project {
  const id = randomUUID()
  const now = new Date().toISOString()
  const name = input.name.trim() || 'New project'
  db()
    .prepare(
      `INSERT INTO projects (id, name, description, instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, name, input.description ?? null, input.instructions ?? null, now, now)
  return {
    id,
    name,
    description: input.description ?? null,
    instructions: input.instructions ?? null,
    createdAt: now,
    updatedAt: now
  }
}

export interface UpdateProjectPatch {
  name?: string
  description?: string | null
  instructions?: string | null
}

/** Partial update — only the supplied fields move. Bumps `updated_at`. */
export function updateProject(id: string, patch: UpdateProjectPatch): Project | null {
  const existing = getProject(id)
  if (!existing) return null
  const next: Project = {
    ...existing,
    name: patch.name?.trim() || existing.name,
    description: patch.description !== undefined ? patch.description : existing.description,
    instructions: patch.instructions !== undefined ? patch.instructions : existing.instructions,
    updatedAt: new Date().toISOString()
  }
  db()
    .prepare(
      `UPDATE projects
     SET name = ?, description = ?, instructions = ?, updated_at = ?
     WHERE id = ?`
    )
    .run(next.name, next.description, next.instructions, next.updatedAt, id)
  return next
}

/**
 * Deletes a project. The thread.project_id FK has `ON DELETE SET NULL`, so
 * the project's threads survive as unfiled — losing a project doesn't
 * lose the user's conversations.
 */
export function deleteProject(id: string): void {
  db().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
}

/**
 * Assigns a thread to a project (or detaches it with NULL). Bumps the
 * thread's updated_at so sidebar sort order reflects the move.
 */
export function setThreadProject(threadId: string, projectId: string | null): void {
  db()
    .prepare(`UPDATE threads SET project_id = ?, updated_at = ? WHERE id = ?`)
    .run(projectId, new Date().toISOString(), threadId)
}
