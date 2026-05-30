/**
 * v2.0 Phase 4 — Hover-to-teach click store.
 *
 * The wound: even with v2.0's UIA-pick + Sonnet computer-use + vision
 * fallback, every click still costs a model call (200ms-3s + tokens).
 * Many users click the SAME N elements repeatedly — same Send button,
 * same close, same compose box. The model call to "find Send" is
 * lossless overhead.
 *
 * The fix: let the user teach Soul a click once. We capture the UIA
 * element they pointed at + the description they assign. Next time
 * the AI agent (or the user) says "click {description}", we look up
 * the taught entry, re-locate the element via UIA enumeration (the
 * window may have moved or scrolled — coords aren't stable enough to
 * cache, but name + controlType + inWindow usually are), and click
 * directly. Zero model calls, instant.
 *
 * Storage shape — a flat JsonStore. We keep entries to the bare
 * minimum needed to re-find the element:
 *   · normalized description (case-folded, whitespace-collapsed)
 *   · raw description as the user typed it (UI display)
 *   · UIA name + controlType + automationId
 *   · inWindow hint (matches the production click_on_screen arg)
 *   · timestamps + hitCount for "is this entry still useful" UX
 *
 * We intentionally DON'T cache screen coordinates: an entry captured
 * in a 1920×1080 layout breaks when the user moves to a 1366×768
 * laptop, and any window move invalidates them too. UIA names are
 * stable across all that.
 */
import { randomUUID } from 'node:crypto'
import { JsonStore } from '../storage/store'
import { enumerateClickableElements, findElementByAutomationId } from './uia'
import type { UiaElement } from './uia'

export interface TaughtClick {
  id: string
  /** Lowercase + whitespace-collapsed description for matching. */
  description: string
  /** Original capitalisation/punctuation as the user typed it — used
   *  for display in Settings only. */
  rawDescription: string
  /** UIA accessibility name of the element captured. */
  name: string
  /** UIA AutomationId (often empty for browser content). */
  automationId: string
  /** UIA ControlType in the canonical "ControlType.Button" form. */
  controlType: string
  /** Optional window hint — matches the click_on_screen `in_window`
   *  argument. Null when teach was global (no window filter). */
  inWindow: string | null
  /** ISO timestamp when the user taught this click. */
  capturedAt: string
  /** Bumped on every successful re-match. Lets the Settings UI sort
   *  by "most useful taught clicks first" and surface zero-hit
   *  entries the user might want to delete. */
  hitCount: number
  /** ISO timestamp of the most recent successful match, or null when
   *  the entry has never been used since it was taught. */
  lastUsedAt: string | null
}

interface TaughtClicksFile {
  entries: TaughtClick[]
}

let cached: JsonStore<TaughtClicksFile> | null = null
function store(): JsonStore<TaughtClicksFile> {
  if (!cached) cached = new JsonStore<TaughtClicksFile>('taught-clicks', { entries: [] })
  return cached
}

/** Normalised form used for matching. Same transform applied at teach
 *  time and at click time so "Send the message" and "send  the message"
 *  collapse to the same key. */
export function normalizeDescription(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** List all entries, most recently used first. Used by the Settings
 *  UI and as the canonical lookup source. */
export function listTaughtClicks(): TaughtClick[] {
  return [...store().get().entries].sort((a, b) => {
    // Recent usage > recent capture > id (deterministic tiebreak).
    const aTime = a.lastUsedAt ?? a.capturedAt
    const bTime = b.lastUsedAt ?? b.capturedAt
    if (aTime !== bTime) return bTime.localeCompare(aTime)
    return a.id.localeCompare(b.id)
  })
}

/** Save a new taught click. Idempotent on (normalized description +
 *  inWindow) — re-teaching the same description overwrites rather
 *  than accumulating dupes. */
export function saveTaughtClick(input: {
  rawDescription: string
  name: string
  automationId: string
  controlType: string
  inWindow: string | null
}): TaughtClick {
  const description = normalizeDescription(input.rawDescription)
  if (!description) throw new Error('Description is required to teach a click.')
  if (!input.name && !input.automationId) {
    throw new Error(
      "UIA didn't expose a Name or AutomationId for that element — re-teach a different element (try the button itself rather than its parent panel)."
    )
  }
  const now = new Date().toISOString()
  const existing = store().get().entries
  const dupeIdx = existing.findIndex(
    (e) => e.description === description && (e.inWindow ?? null) === (input.inWindow ?? null)
  )
  const entry: TaughtClick = {
    id: dupeIdx >= 0 ? existing[dupeIdx].id : `taught-${randomUUID()}`,
    description,
    rawDescription: input.rawDescription.trim(),
    name: input.name,
    automationId: input.automationId,
    controlType: input.controlType,
    inWindow: input.inWindow,
    capturedAt: dupeIdx >= 0 ? existing[dupeIdx].capturedAt : now,
    hitCount: dupeIdx >= 0 ? existing[dupeIdx].hitCount : 0,
    lastUsedAt: dupeIdx >= 0 ? existing[dupeIdx].lastUsedAt : null
  }
  const next =
    dupeIdx >= 0
      ? [...existing.slice(0, dupeIdx), entry, ...existing.slice(dupeIdx + 1)]
      : [...existing, entry]
  store().set({ entries: next })
  return entry
}

/** Delete by id. */
export function removeTaughtClick(id: string): void {
  const entries = store()
    .get()
    .entries.filter((e) => e.id !== id)
  store().set({ entries })
}

/** Look up a taught entry by description (normalized) AND inWindow
 *  scope. Returns null when no entry matches.
 *
 *  v2.0 polish — inWindow is part of the lookup key. Without it, a
 *  user who teaches "send in slack" with entry.inWindow="Slack" and
 *  later asks the AI to "click send in slack" (no in_window) or
 *  "click send in slack" while AI passes in_window="Discord" would
 *  silently get a click in the wrong app with confidence 1. The
 *  taught-click path's whole value is "no model uncertainty", so a
 *  silent cross-app misfire here would defeat the feature.
 *
 *  Match rules:
 *   - description must match (normalized)
 *   - if the lookup call supplies inWindow, the entry's inWindow
 *     must match (case-insensitive)
 *   - if the lookup call does NOT supply inWindow, only match
 *     entries that were also taught without a window scope
 *     (entry.inWindow === null)
 */
export function findTaughtByDescription(
  rawDescription: string,
  inWindow: string | null
): TaughtClick | null {
  const norm = normalizeDescription(rawDescription)
  if (!norm) return null
  const normWindow = inWindow ? inWindow.trim().toLowerCase() : null
  return (
    store()
      .get()
      .entries.find((e) => {
        if (e.description !== norm) return false
        const entryWindow = e.inWindow ? e.inWindow.trim().toLowerCase() : null
        return entryWindow === normWindow
      }) ?? null
  )
}

/** Increment hitCount + stamp lastUsedAt. Called after a successful
 *  taught-click match in the production pipeline. */
export function recordTaughtHit(id: string): void {
  const entries = store().get().entries
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return
  const updated: TaughtClick = {
    ...entries[idx],
    hitCount: entries[idx].hitCount + 1,
    lastUsedAt: new Date().toISOString()
  }
  store().set({
    entries: [...entries.slice(0, idx), updated, ...entries.slice(idx + 1)]
  })
}

/**
 * Resolve a taught entry to a live UIA element on the current screen
 * state. Returns null when:
 *  - the target window isn't open (when inWindow is set)
 *  - UIA returns no element matching the taught name + controlType
 *  - multiple elements match (ambiguous — fall through rather than
 *    risk clicking the wrong one)
 *
 * Caller is the production click pipeline. The bench harness mirrors
 * this exactly via the `taught-click` strategy.
 */
export async function resolveTaughtClick(
  entry: TaughtClick,
  targetWindowHwnd: number | null
): Promise<{ element: UiaElement; trail: string } | null> {
  // v2.0 polish — when the taught entry has a stable AutomationId
  // (common on UWP/WPF, less so on browser content), skip the full
  // tree walk and use UIA's native FindFirst with a PropertyCondition.
  // O(tree) work happens inside the .NET host instead of marshalling
  // every node back through PowerShell→JSON→TS. Cuts taught-click
  // resolution from ~300-1100ms to ~100-300ms (just the PowerShell
  // cold-start). Falls through to the legacy enumerate when:
  //  - no AutomationId on the entry (browser content typically)
  //  - FindFirst returned null (window scrolled, app rebuilt the
  //    sub-tree, or AutomationId was per-session)
  if (entry.automationId) {
    const direct = await findElementByAutomationId({
      hwnd: targetWindowHwnd,
      automationId: entry.automationId,
      controlType: entry.controlType
    })
    if (direct) {
      return {
        element: direct,
        trail: `taught entry "${entry.rawDescription}" matched live "${direct.name}" (${direct.controlType}) at (${direct.x}, ${direct.y}) via FindFirst(AutomationId)`
      }
    }
  }
  const elements = await enumerateClickableElements(undefined, undefined, targetWindowHwnd)
  if (elements.length === 0) {
    return null
  }
  const candidates = elements.filter((e) => {
    if (e.controlType !== entry.controlType) return false
    // Match on Name first (most stable). Fall back to AutomationId
    // when present — UWP apps tend to keep this stable across updates.
    if (entry.name && e.name === entry.name) return true
    if (entry.automationId && e.automationId === entry.automationId) return true
    return false
  })
  if (candidates.length === 0) {
    // Taught name + controlType combination not visible right now —
    // window was scrolled, app updated, or this entry is stale.
    // Fall through to the rest of the pipeline.
    return null
  }
  if (candidates.length > 1) {
    // Ambiguous — same name + controlType appears N times. Fall
    // through to the model so the user gets the safer pipeline.
    return null
  }
  return {
    element: candidates[0],
    trail: `taught entry "${entry.rawDescription}" matched live "${candidates[0].name}" (${candidates[0].controlType}) at (${candidates[0].x}, ${candidates[0].y})`
  }
}
