/**
 * Mirrors the assistant's local memory — recent projects, favourite apps and
 * reusable custom prompts. Every mutator round-trips through the main process.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { CustomActionKind, MemoryState as MemoryData, ModeId } from '@shared/types'

interface MemoryStore {
  data: MemoryData | null
  loaded: boolean
  load: () => Promise<void>
  rememberProject: (path: string) => Promise<void>
  forgetProject: (path: string) => Promise<void>
  addFavorite: (label: string, target: string) => Promise<void>
  removeFavorite: (id: string) => Promise<void>
  /** Imports taskbar-pinned apps into favourites; resolves with the count added. */
  importTaskbar: () => Promise<number>
  addPrompt: (label: string, prompt: string) => Promise<void>
  removePrompt: (id: string) => Promise<void>
  addAction: (label: string, kind: CustomActionKind, target: string) => Promise<void>
  removeAction: (id: string) => Promise<void>
  /** Long-term facts about the user — injected into the assistant's system prompt. */
  addFact: (text: string, modes?: ModeId[]) => Promise<void>
  updateFact: (id: string, text: string) => Promise<void>
  /** Re-scopes a fact. Pass an empty array to make it global (all modes). */
  setFactModes: (id: string, modes: ModeId[]) => Promise<void>
  removeFact: (id: string) => Promise<void>
  clearFacts: () => Promise<void>
  /** v2.0 — passive biographical profile. Per-entry delete + bulk clear
   *  for the Settings UI. Merge is invoked by the extractor (not the
   *  store) so the extractor owns the dedup + confidence semantics. */
  removeBiographical: (id: string) => Promise<void>
  clearBiographical: () => Promise<void>
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  data: null,
  loaded: false,

  load: async () => {
    set({ data: await vs.memory.get(), loaded: true })
  },

  rememberProject: async (path) => {
    const recentProjects = await vs.memory.rememberProject(path)
    const data = get().data
    if (data) set({ data: { ...data, recentProjects } })
  },

  forgetProject: async (path) => {
    const recentProjects = await vs.memory.forgetProject(path)
    const data = get().data
    if (data) set({ data: { ...data, recentProjects } })
  },

  addFavorite: async (label, target) => {
    const favoriteApps = await vs.memory.addFavorite(label, target)
    const data = get().data
    if (data) set({ data: { ...data, favoriteApps } })
  },

  removeFavorite: async (id) => {
    const favoriteApps = await vs.memory.removeFavorite(id)
    const data = get().data
    if (data) set({ data: { ...data, favoriteApps } })
  },

  importTaskbar: async () => {
    const before = get().data?.favoriteApps.length ?? 0
    const favoriteApps = await vs.memory.importTaskbar()
    const data = get().data
    if (data) set({ data: { ...data, favoriteApps } })
    return favoriteApps.length - before
  },

  addPrompt: async (label, prompt) => {
    const customPrompts = await vs.memory.addPrompt(label, prompt)
    const data = get().data
    if (data) set({ data: { ...data, customPrompts } })
  },

  removePrompt: async (id) => {
    const customPrompts = await vs.memory.removePrompt(id)
    const data = get().data
    if (data) set({ data: { ...data, customPrompts } })
  },

  addAction: async (label, kind, target) => {
    const customActions = await vs.memory.addAction(label, kind, target)
    const data = get().data
    if (data) set({ data: { ...data, customActions } })
  },

  removeAction: async (id) => {
    const customActions = await vs.memory.removeAction(id)
    const data = get().data
    if (data) set({ data: { ...data, customActions } })
  },

  addFact: async (text, modes) => {
    const facts = await vs.memory.addFact(text, modes)
    const data = get().data
    if (data) set({ data: { ...data, facts } })
  },

  updateFact: async (id, text) => {
    const facts = await vs.memory.updateFact(id, text)
    const data = get().data
    if (data) set({ data: { ...data, facts } })
  },

  setFactModes: async (id, modes) => {
    const facts = await vs.memory.setFactModes(id, modes)
    const data = get().data
    if (data) set({ data: { ...data, facts } })
  },

  removeFact: async (id) => {
    const facts = await vs.memory.removeFact(id)
    const data = get().data
    if (data) set({ data: { ...data, facts } })
  },

  clearFacts: async () => {
    const facts = await vs.memory.clearFacts()
    const data = get().data
    if (data) set({ data: { ...data, facts } })
  },

  removeBiographical: async (id) => {
    const biographical = await vs.memory.bioRemove(id)
    const data = get().data
    if (data) set({ data: { ...data, biographical } })
  },

  clearBiographical: async () => {
    const biographical = await vs.memory.bioClear()
    const data = get().data
    if (data) set({ data: { ...data, biographical } })
  }
}))
