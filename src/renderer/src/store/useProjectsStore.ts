/**
 * Projects store. Mirrors `vs.projects.*` IPC into a Zustand store the
 * sidebar and overrides dialog subscribe to.
 *
 * Why a separate store from `useChatStore`? Projects have their own
 * lifecycle (create / rename / delete) that doesn't touch threads at all
 * most of the time. Keeping them separate avoids re-rendering every chat
 * surface when a project's instructions change.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import { useChatStore } from './useChatStore'
import type { Project } from '@shared/types'

interface ProjectsState {
  projects: Project[]
  loaded: boolean

  load: () => Promise<void>
  create: (input: {
    name: string
    description?: string | null
    instructions?: string | null
  }) => Promise<Project>
  update: (
    id: string,
    patch: { name?: string; description?: string | null; instructions?: string | null }
  ) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Move a thread into a project (or null to unfile it). Refreshes the
   *  thread's summary in the chat store so the sidebar reflects the move. */
  setThreadProject: (threadId: string, projectId: string | null) => Promise<void>
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  loaded: false,

  load: async () => {
    const projects = await vs.projects.list()
    set({ projects, loaded: true })
  },

  create: async (input) => {
    const project = await vs.projects.create(input)
    set((s) => ({ projects: [project, ...s.projects] }))
    return project
  },

  update: async (id, patch) => {
    const updated = await vs.projects.update(id, patch)
    if (!updated) return
    set((s) => ({
      projects: s.projects
        .map((p) => (p.id === id ? updated : p))
        // Re-sort so the just-edited project floats to the top, matching
        // the SQL `ORDER BY updated_at DESC`.
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    }))
  },

  remove: async (id) => {
    const next = await vs.projects.delete(id)
    set({ projects: next })
    // Threads in this project had their project_id set to NULL by the FK
    // cascade — refresh the chat store so the sidebar reflects that.
    void useChatStore.getState().load(true)
  },

  setThreadProject: async (threadId, projectId) => {
    const updatedSummary = await vs.projects.setThreadProject(threadId, projectId)
    if (!updatedSummary) return
    // Patch the thread in the chat store so the drawer re-groups it without
    // needing a full reload.
    useChatStore.setState((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? updatedSummary : t))
    }))
  }
}))
