/**
 * The assistant's local memory: recent projects, favourite apps and reusable
 * custom prompts. Backed by the same atomic JSON store as configuration.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { JsonStore } from './store'
import type {
  CustomActionKind,
  CustomPrompt,
  FavoriteApp,
  MemoryState,
  ModeId,
  QuickAction,
  RecentProject,
  UserFact
} from '@shared/types'

const MAX_RECENT = 12
const MAX_NEXUS_ACTIONS = 8
const MAX_FACTS = 50

const DEFAULT_MEMORY: MemoryState = {
  recentProjects: [],
  favoriteApps: [],
  customPrompts: [],
  customActions: [],
  facts: []
}

const ACTION_KIND: Record<
  CustomActionKind,
  { type: QuickAction['action']['type']; param: string; icon: string; requires: QuickAction['requires'] }
> = {
  app: { type: 'open-app', param: 'app', icon: 'Box', requires: 'appControl' },
  url: { type: 'open-url', param: 'url', icon: 'Globe', requires: 'browser' },
  folder: { type: 'open-folder', param: 'dir', icon: 'Folder', requires: 'filesystem' }
}

let cached: JsonStore<MemoryState> | null = null
function store(): JsonStore<MemoryState> {
  if (!cached) cached = new JsonStore<MemoryState>('memory', DEFAULT_MEMORY)
  return cached
}

export function getMemory(): MemoryState {
  return store().get()
}

/** Replaces the entire memory state (used by backup import). */
export function replaceMemory(state: MemoryState): MemoryState {
  return store().replace({
    recentProjects: state.recentProjects ?? [],
    favoriteApps: state.favoriteApps ?? [],
    customPrompts: state.customPrompts ?? [],
    customActions: state.customActions ?? [],
    facts: state.facts ?? []
  })
}

export function rememberProject(path: string): RecentProject[] {
  const entry: RecentProject = {
    path,
    name: basename(path) || path,
    lastOpened: new Date().toISOString()
  }
  const recentProjects = [
    entry,
    ...store()
      .get()
      .recentProjects.filter((p) => p.path !== path)
  ].slice(0, MAX_RECENT)
  store().set({ recentProjects })
  return recentProjects
}

export function forgetProject(path: string): RecentProject[] {
  const recentProjects = store()
    .get()
    .recentProjects.filter((p) => p.path !== path)
  store().set({ recentProjects })
  return recentProjects
}

export function addFavoriteApp(label: string, target: string): FavoriteApp[] {
  const favoriteApps = [
    ...store().get().favoriteApps,
    { id: randomUUID(), label, target }
  ]
  store().set({ favoriteApps })
  return favoriteApps
}

export function removeFavoriteApp(id: string): FavoriteApp[] {
  const favoriteApps = store()
    .get()
    .favoriteApps.filter((a) => a.id !== id)
  store().set({ favoriteApps })
  return favoriteApps
}

/** Bulk-adds apps (e.g. imported from the taskbar), de-duplicating by target. */
export function importFavoriteApps(apps: Array<{ name: string; target: string }>): FavoriteApp[] {
  const existing = store().get().favoriteApps
  const seen = new Set(existing.map((a) => a.target.toLowerCase()))
  const additions: FavoriteApp[] = apps
    .filter((a) => a.target && !seen.has(a.target.toLowerCase()))
    .map((a) => ({ id: randomUUID(), label: a.name, target: a.target }))
  const favoriteApps = [...existing, ...additions]
  store().set({ favoriteApps })
  return favoriteApps
}

export function addCustomPrompt(label: string, prompt: string): CustomPrompt[] {
  const customPrompts = [
    ...store().get().customPrompts,
    { id: randomUUID(), label, prompt }
  ]
  store().set({ customPrompts })
  return customPrompts
}

export function removeCustomPrompt(id: string): CustomPrompt[] {
  const customPrompts = store()
    .get()
    .customPrompts.filter((p) => p.id !== id)
  store().set({ customPrompts })
  return customPrompts
}

/** Adds a custom Nexus quick action (capped at 8). */
export function addCustomAction(
  label: string,
  kind: CustomActionKind,
  target: string
): QuickAction[] {
  const meta = ACTION_KIND[kind]
  const action: QuickAction = {
    id: randomUUID(),
    label,
    icon: meta.icon,
    description: label,
    requires: meta.requires,
    action: { type: meta.type, params: { [meta.param]: target } }
  }
  const customActions = [...store().get().customActions, action].slice(0, MAX_NEXUS_ACTIONS)
  store().set({ customActions })
  return customActions
}

export function removeCustomAction(id: string): QuickAction[] {
  const customActions = store()
    .get()
    .customActions.filter((a) => a.id !== id)
  store().set({ customActions })
  return customActions
}

/** Strips punctuation and collapses whitespace for substring-aware comparison. */
function normaliseFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Sanitises a modes array — strips falsies and dedupes. Empty → undefined. */
function normaliseModes(modes?: ModeId[] | null): ModeId[] | undefined {
  if (!modes || modes.length === 0) return undefined
  const seen = new Set<ModeId>()
  for (const m of modes) if (m) seen.add(m)
  return seen.size > 0 ? Array.from(seen) : undefined
}

/**
 * Adds a fact to long-term memory with substring-aware dedup. Skips when an
 * existing fact already contains (or matches) the new one; replaces an
 * existing fact that is wholly subsumed by the new, more specific one. Caps
 * at MAX_FACTS, dropping the oldest when full.
 *
 * `modes` scopes the fact to specific workflow modes. Omit (or pass an empty
 * array) for a global fact surfaced in every mode.
 */
export function addFact(text: string, modes?: ModeId[]): UserFact[] {
  const trimmed = text.trim()
  const normNew = normaliseFact(trimmed)
  if (!trimmed || !normNew) return store().get().facts

  const existing = store().get().facts
  const tags = normaliseModes(modes)

  // Already known? Skip when any existing fact contains the new wording.
  // If the existing match is more narrowly scoped than the new fact, widen
  // its scope so the new context is preserved.
  for (const f of existing) {
    const e = normaliseFact(f.text)
    if (e === normNew || e.includes(normNew)) {
      // Widen existing fact's scope if the new fact is global or adds modes.
      const widened = widenScope(f.modes, tags)
      if (sameScope(widened, f.modes)) return existing
      const facts = existing.map((x) =>
        x.id === f.id ? { ...x, modes: widened, updatedAt: new Date().toISOString() } : x
      )
      store().set({ facts })
      return facts
    }
  }

  // The new fact may subsume one or more existing, shorter facts — drop those.
  const survivors = existing.filter((f) => !normNew.includes(normaliseFact(f.text)))

  const now = new Date().toISOString()
  const fact: UserFact = {
    id: randomUUID(),
    text: trimmed,
    createdAt: now,
    updatedAt: now,
    ...(tags ? { modes: tags } : {})
  }
  const facts = [...survivors, fact].slice(-MAX_FACTS)
  store().set({ facts })
  return facts
}

/** Replaces a fact's mode scope. Empty array → global (modes cleared). */
export function setFactModes(id: string, modes: ModeId[]): UserFact[] {
  const tags = normaliseModes(modes)
  const facts = store()
    .get()
    .facts.map((f) =>
      f.id === id
        ? {
            ...f,
            modes: tags,
            updatedAt: new Date().toISOString()
          }
        : f
    )
  store().set({ facts })
  return facts
}

/** Widens the scope from `current` to include `incoming`'s modes. */
function widenScope(
  current?: ModeId[],
  incoming?: ModeId[]
): ModeId[] | undefined {
  // Either side global → the result is global.
  if (!current || current.length === 0) return undefined
  if (!incoming || incoming.length === 0) return undefined
  return Array.from(new Set([...current, ...incoming]))
}

function sameScope(a?: ModeId[], b?: ModeId[]): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((m) => setA.has(m))
}

export function updateFact(id: string, text: string): UserFact[] {
  const trimmed = text.trim()
  if (!trimmed) return store().get().facts
  const facts = store()
    .get()
    .facts.map((f) =>
      f.id === id ? { ...f, text: trimmed, updatedAt: new Date().toISOString() } : f
    )
  store().set({ facts })
  return facts
}

export function removeFact(id: string): UserFact[] {
  const facts = store()
    .get()
    .facts.filter((f) => f.id !== id)
  store().set({ facts })
  return facts
}

export function clearFacts(): UserFact[] {
  store().set({ facts: [] })
  return []
}
