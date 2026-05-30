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
  UserFact,
  BiographicalCategory,
  BiographicalEntry
} from '@shared/types'

const MAX_RECENT = 12
const MAX_NEXUS_ACTIONS = 8
const MAX_FACTS = 50
/**
 * v2.0 — biographical profile cap. 100 entries is comfortable for a
 * year+ of conversation history (rough budget: ~6 categories × ~15
 * stable entries each). Above the cap we evict lowest-(confidence ×
 * recency) entries so a one-off mention from months ago can't crowd
 * out a current project.
 */
const MAX_BIO_ENTRIES = 100
/** Initial confidence assigned on first observation (one mention seen).
 *  Stays below MIN_BIO_CONFIDENCE so a single mention sits in the store
 *  for later promotion but doesn't yet reach the system prompt. */
const INITIAL_BIO_CONFIDENCE = 0.5
/**
 * Per-observation confidence raise. With INITIAL = 0.5 and STEP = 0.125
 * the curve is:
 *   observations = 1 → 0.5    (first mention, hidden)
 *   observations = 2 → 0.625  (one re-confirmation, still hidden)
 *   observations = 3 → 0.75   (two re-confirmations, NOW visible — at
 *                              MIN_BIO_CONFIDENCE)
 *   observations = 7 → 1.0    (six re-confirmations, capped)
 * So "trusted" requires THREE distinct mentions: the initial sighting
 * plus two re-confirmations. Tuned so memorable recurring details
 * stabilise inside a typical week of conversation while one-off
 * quirks stay uncertain until the user actually repeats them.
 */
const BIO_CONFIDENCE_STEP = 0.125

const DEFAULT_MEMORY: MemoryState = {
  recentProjects: [],
  favoriteApps: [],
  customPrompts: [],
  customActions: [],
  facts: [],
  biographical: []
}

const ACTION_KIND: Record<
  CustomActionKind,
  {
    type: QuickAction['action']['type']
    param: string
    icon: string
    requires: QuickAction['requires']
  }
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

/** Replaces the entire memory state (used by backup import / sync). */
export function replaceMemory(state: MemoryState): MemoryState {
  return store().replace({
    recentProjects: state.recentProjects ?? [],
    favoriteApps: state.favoriteApps ?? [],
    customPrompts: state.customPrompts ?? [],
    customActions: state.customActions ?? [],
    facts: state.facts ?? [],
    // v2.0 — carry the passive biographical profile through backup
    // import / sync. Without this branch a restore wiped the entire
    // profile (the `replace()` payload literally omitted the field, so
    // the persisted memory file lost it) and cross-machine sync was
    // one-way-deleting on the receiving end. `?? []` covers pre-2.0
    // backup files that don't include this key.
    biographical: state.biographical ?? []
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
  const favoriteApps = [...store().get().favoriteApps, { id: randomUUID(), label, target }]
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
  const customPrompts = [...store().get().customPrompts, { id: randomUUID(), label, prompt }]
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
function widenScope(current?: ModeId[], incoming?: ModeId[]): ModeId[] | undefined {
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

/* ----------------------- biographical profile (v2.0) ------------------- */

/**
 * Payload the renderer-side extractor hands to `mergeBiographical`. We
 * deliberately don't accept full `BiographicalEntry` objects from the
 * renderer — the extractor only knows the SEMANTIC content (category +
 * text). Confidence + observation count + timestamps are storage-layer
 * concerns: the merge applies them so a malicious or buggy extractor
 * can't backdate or over-confidence an entry through the IPC surface.
 */
export interface BiographicalUpdate {
  category: BiographicalCategory
  text: string
}

/**
 * Merge a batch of newly-extracted observations into the stored profile.
 * Each update either:
 *   1. Matches an existing entry by `(category, normalisedText)` —
 *      raises confidence (capped at 1.0), increments observations,
 *      bumps lastSeenAt. Text stays as-stored so a slightly different
 *      phrasing on re-observation doesn't churn the entry.
 *   2. Is new — inserts at INITIAL_BIO_CONFIDENCE with observations=1.
 *
 * On overflow (post-merge size > MAX_BIO_ENTRIES), we evict by lowest
 * `confidence * recencyScore` so a high-confidence stale entry CAN be
 * pushed out by accumulating fresh ones, but a fresh one-mention guess
 * can't displace a long-running stable entry. Recency score decays
 * smoothly from 1.0 (today) to ~0.3 (a year old).
 *
 * Returns the post-merge entry list so the caller can update its store
 * snapshot without a second fetch.
 */
export function mergeBiographical(updates: BiographicalUpdate[]): BiographicalEntry[] {
  if (updates.length === 0) {
    return store().get().biographical ?? []
  }
  const now = new Date().toISOString()
  const existing = (store().get().biographical ?? []).slice()
  // Key on category + a normalised form of the text so casing /
  // punctuation / "the" prefixes don't double-count.
  const indexByKey = new Map<string, number>()
  for (let i = 0; i < existing.length; i++) {
    indexByKey.set(bioKey(existing[i].category, existing[i].text), i)
  }
  for (const update of updates) {
    const trimmed = update.text.trim()
    if (!trimmed || trimmed.length > 240) continue
    const key = bioKey(update.category, trimmed)
    const at = indexByKey.get(key)
    if (at !== undefined) {
      const prev = existing[at]
      existing[at] = {
        ...prev,
        confidence: Math.min(1, prev.confidence + BIO_CONFIDENCE_STEP),
        observations: prev.observations + 1,
        lastSeenAt: now
      }
    } else {
      const entry: BiographicalEntry = {
        id: randomUUID(),
        category: update.category,
        text: trimmed,
        confidence: INITIAL_BIO_CONFIDENCE,
        observations: 1,
        firstSeenAt: now,
        lastSeenAt: now
      }
      indexByKey.set(key, existing.length)
      existing.push(entry)
    }
  }
  // Evict lowest-score entries past the cap. Confidence × recency keeps
  // fresh-but-uncertain and stale-but-confident entries roughly equally
  // weighted, so neither category dominates the eviction queue.
  if (existing.length > MAX_BIO_ENTRIES) {
    const nowMs = Date.now()
    const scored = existing.map((entry) => ({
      entry,
      score: entry.confidence * recencyScore(entry.lastSeenAt, nowMs)
    }))
    scored.sort((a, b) => b.score - a.score)
    const trimmed = scored.slice(0, MAX_BIO_ENTRIES).map((s) => s.entry)
    store().set({ biographical: trimmed })
    return trimmed
  }
  store().set({ biographical: existing })
  return existing
}

/** Removes one entry by id. Returns the post-mutation list. */
export function removeBiographical(id: string): BiographicalEntry[] {
  const next = (store().get().biographical ?? []).filter((b) => b.id !== id)
  store().set({ biographical: next })
  return next
}

/** Drops every biographical entry — Settings "Clear profile" button. */
export function clearBiographical(): BiographicalEntry[] {
  store().set({ biographical: [] })
  return []
}

/**
 * Normalises text for the `(category, text)` dedup key.
 *
 * Covers: casing, whitespace collapse, leading articles (the / a / an),
 * trailing periods. So `"Working on VoidSoul."` and
 * `"working on voidsoul"` merge cleanly.
 *
 * Does NOT cover: phrasing variants where the same idea is rendered
 * with different content words. `"Working on VoidSoul"` and
 * `"Working on the VoidSoul project"` will be treated as two distinct
 * entries — both will then get confidence-promoted in parallel and
 * eventually both land in the system prompt. Accepted as a v1 limit;
 * a smarter dedup needs semantic matching (embedding similarity)
 * which is a follow-up.
 */
function bioKey(category: BiographicalCategory, text: string): string {
  const normalised = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .replace(/\.$/, '')
  return `${category}::${normalised}`
}

/** Smooth decay from 1.0 (today) to ~0.3 (a year old). Chosen so a
 *  high-confidence entry from yesterday outscores a low-confidence
 *  one from today, but year-old confident entries don't permanently
 *  block fresh observations. */
function recencyScore(lastSeenAt: string, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - Date.parse(lastSeenAt))
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  // Half-life ~120 days. Exponential decay.
  return 0.3 + 0.7 * Math.exp(-ageDays / 120)
}
