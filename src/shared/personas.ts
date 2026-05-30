/**
 * Persona templates (v2.0) — saveable, sharable bundles of {system prompt
 * + recommended model + sample prompts}. NOT a new permanent mode; these
 * are presets users apply to a thread (or share via JSON file).
 *
 * The mental model:
 *   · The 6 built-in MODES are workflow profiles — permissions + quick
 *     actions + system-prompt fragment. They live in code; users pick
 *     one as their "global" workflow.
 *   · Persona templates are starting points for a chat thread. A user
 *     can build "Game Designer Mode for UE5" (or import one a friend
 *     shared) and APPLY it to a thread — that sets the thread's pinned
 *     system prompt + optionally pinned mode + surfaces sample prompts.
 *     Doesn't touch the global activeMode.
 *
 * Type definitions live in `./types` (to keep ClientConfig
 * self-contained without a circular import); this module owns the
 * helpers — validators, projection to/from the bundle shape, file-name
 * generation. Bundle format is versioned so future fields can land
 * without breaking older imports.
 */
import type { AccentColor, ModeId, PersonaBundle, PersonaTemplate } from './types'

export type { PersonaBundle, PersonaTemplate }

/** Validates that a parsed JSON object is shaped like a PersonaBundle. */
export function isPersonaBundle(input: unknown): input is PersonaBundle {
  if (!input || typeof input !== 'object') return false
  const b = input as Record<string, unknown>
  if (b.kind !== 'voidsoul-persona') return false
  if (b.version !== 1) return false
  if (typeof b.name !== 'string' || !b.name.trim()) return false
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return false
  // Optional fields just need to be the right type if present.
  if (b.tagline !== undefined && typeof b.tagline !== 'string') return false
  if (b.recommendedModel !== undefined && typeof b.recommendedModel !== 'string') return false
  if (b.samplePrompts !== undefined) {
    if (!Array.isArray(b.samplePrompts)) return false
    if (b.samplePrompts.some((p) => typeof p !== 'string')) return false
  }
  return true
}

/**
 * Project a runtime PersonaTemplate to a sharable bundle. Strips the
 * runtime-only `id` (the importer mints a fresh one) and ensures every
 * optional field that's present is preserved.
 */
export function toPersonaBundle(template: PersonaTemplate): PersonaBundle {
  const bundle: PersonaBundle = {
    kind: 'voidsoul-persona',
    version: 1,
    name: template.name,
    prompt: template.prompt,
    createdAt: template.createdAt
  }
  if (template.tagline) bundle.tagline = template.tagline
  if (template.accent) bundle.accent = template.accent
  if (template.recommendedProvider) bundle.recommendedProvider = template.recommendedProvider
  if (template.recommendedModel) bundle.recommendedModel = template.recommendedModel
  if (template.samplePrompts && template.samplePrompts.length > 0) {
    bundle.samplePrompts = template.samplePrompts
  }
  if (template.baseMode) bundle.baseMode = template.baseMode
  if (template.createdBy) bundle.createdBy = template.createdBy
  return bundle
}

/**
 * Project a built-in ModeDef to a bundle so users can export "Researcher"
 * or "Indie Dev" as a starting point and edit the JSON. Quick actions /
 * permissions intentionally omitted — they're tightly coupled to internal
 * ActionType + permission ids that a future build might rename, and the
 * value of a shared persona is the prompt + model recommendation anyway.
 */
export function builtInModeToBundle(mode: {
  id: ModeId
  name: string
  tagline: string
  prompt: string
  accent: AccentColor
}): PersonaBundle {
  return {
    kind: 'voidsoul-persona',
    version: 1,
    name: mode.name,
    tagline: mode.tagline,
    accent: mode.accent,
    prompt: mode.prompt,
    baseMode: mode.id,
    createdBy: 'VoidSoul (built-in)',
    createdAt: new Date().toISOString()
  }
}

/**
 * Lowercase + alphanumeric-hyphen slug used as both the file-name
 * stem on export AND the id stem on import. Shared so a future tweak
 * (handle emoji, allow unicode letters, raise the length cap) lands
 * in one place. Returns empty string for names with no alphanumerics
 * — callers decide their own fallback (`bundleFilename` uses
 * 'persona', `bundleToTemplate` uses the same plus a timestamp).
 */
function slugifyPersonaName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Builds a runtime PersonaTemplate from a validated bundle. The id is
 * synthesised here so concurrent imports of the same bundle each land
 * as distinct entries (the storage layer dedupes on collision separately).
 *
 * The id mixes a millisecond timestamp with a 4-char base36 random
 * suffix — two imports of the same bundle inside the same millisecond
 * (rare but possible during a multi-import batch) would otherwise collide
 * and the storage upsert would overwrite the first.
 */
export function bundleToTemplate(bundle: PersonaBundle): PersonaTemplate {
  const slug = slugifyPersonaName(bundle.name) || 'persona'
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  const id = `persona-${slug}-${Date.now().toString(36)}-${rand}`
  const template: PersonaTemplate = {
    id,
    name: bundle.name,
    prompt: bundle.prompt,
    createdAt: bundle.createdAt ?? new Date().toISOString()
  }
  if (bundle.tagline) template.tagline = bundle.tagline
  if (bundle.accent) template.accent = bundle.accent
  if (bundle.recommendedProvider) template.recommendedProvider = bundle.recommendedProvider
  if (bundle.recommendedModel) template.recommendedModel = bundle.recommendedModel
  if (bundle.samplePrompts && bundle.samplePrompts.length > 0) {
    // Trim each + drop empties — a bundle authored with a trailing
    // blank prompt shouldn't render an empty chip in the panel.
    template.samplePrompts = bundle.samplePrompts.map((p) => p.trim()).filter((p) => p.length > 0)
  }
  if (bundle.baseMode) template.baseMode = bundle.baseMode
  if (bundle.createdBy) template.createdBy = bundle.createdBy
  return template
}

/** Default filename suggestion when exporting. Slugified persona name. */
export function bundleFilename(bundle: PersonaBundle): string {
  return `${slugifyPersonaName(bundle.name) || 'persona'}.voidsoul-persona.json`
}
