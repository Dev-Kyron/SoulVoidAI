/**
 * v1.12.0 — Quick Start profiles for the MCP marketplace.
 *
 * Why this exists: a first-time non-tech user opening the marketplace
 * sees 100+ entries and bounces. The marketplace is a power-user feature
 * pretending to be an onboarding flow. Quick Start collapses the choice
 * down to "pick a workflow" → bulk-install every zero-config server that
 * matches. They land with 5–8 working tools in one click.
 *
 * Eligibility rules for Quick Start (intentionally strict):
 *   1. Source must be `curated` — we hand-reviewed these entries.
 *      Community sources (PulseMCP, Smithery, Glama) aren't audited and
 *      we won't bulk-install something we haven't read.
 *   2. No argPrompts — needs no file paths.
 *   3. No envPrompts — needs no API keys or tokens.
 *   4. No `requires` system dep — `uv`/`docker`/etc would fail at first
 *      use without that binary on the user's machine. Reserving those
 *      for the individual-install path (where the badge warns about it).
 *   5. Not discoveryOnly — those have no install command at all.
 *
 * Adding new profiles: profile entryIds reference registry entry IDs by
 * string. Missing IDs are silently dropped at resolve-time so a profile
 * authored against a renamed entry doesn't error — it just installs
 * fewer servers than advertised. Re-author profiles when registry IDs
 * stabilise.
 */
import type { McpRegistryEntry } from '@shared/types'

export interface QuickStartProfile {
  id: string
  name: string
  tagline: string
  description: string
  /** Entry IDs to install. The string literal 'all-zero-config' means
   *  "every entry that passes the eligibility filter" — used by the
   *  "Everything" profile so it stays in sync as the registry grows. */
  entryIds: readonly string[] | 'all-zero-config'
  /**
   * v2.0 — install mode.
   *
   *   'bulk' (default) — every entry is zero-config and we install them in
   *     parallel via `vs.mcp.add`. The Quick Start dialog handles this end
   *     to end without prompting.
   *
   *   'guided' — entries need API keys, OAuth, or system deps. The dialog
   *     lists the recommended set + each entry's auth requirement and
   *     hands off to the existing per-entry marketplace install flow so
   *     the user can authorise each one. Used for the Productivity Pack
   *     (Notion, Slack, Gmail, Calendar, Drive) where "one click" is
   *     fundamentally not on the table.
   */
  mode?: 'bulk' | 'guided'
}

export const QUICK_START_PROFILES: readonly QuickStartProfile[] = [
  {
    id: 'essentials',
    name: 'Essentials',
    tagline: 'Universal helpers',
    description:
      'Memory and sequential reasoning. Every AI workflow benefits — give the model durable cross-session memory and an explicit thinking-step tool.',
    entryIds: ['memory', 'sequential-thinking']
  },
  {
    id: 'developer',
    name: 'Developer',
    tagline: 'Code + infrastructure',
    description:
      'Adds the reference agent-loop server and Cloudflare (one-time browser OAuth on first use) for Workers / KV / R2 / D1. Plus Essentials.',
    entryIds: ['memory', 'sequential-thinking', 'everything', 'cloudflare']
  },
  {
    id: 'researcher',
    name: 'Researcher',
    tagline: 'Web + content extraction',
    description:
      'Adds Puppeteer for headless browsing, YouTube transcript fetching, and Reddit search. Plus Essentials.',
    entryIds: ['memory', 'sequential-thinking', 'puppeteer', 'youtube', 'reddit']
  },
  {
    id: 'everything',
    name: 'Everything',
    tagline: 'All zero-config servers',
    description:
      'Install every curated server in the marketplace that needs no keys, no paths, and no system dependencies. Maximum tools, zero friction.',
    entryIds: 'all-zero-config'
  },
  {
    // v2.0 — productivity pack. Notion + Slack + Gmail + Calendar + Drive
    // all need auth (API tokens / OAuth credentials) so this is a guided
    // profile rather than a bulk-install. The dialog points the user at
    // the marketplace for per-entry setup; this profile exists primarily
    // so a non-tech user has a single named target ("Productivity Pack")
    // to recognise instead of hunting five separate entries.
    id: 'productivity',
    name: 'Productivity Pack',
    tagline: 'Notion, Slack, Gmail, Calendar, Drive',
    description:
      'Connect VoidSoul to your work tools — Notion docs, Slack channels, Gmail, Google Calendar, Google Drive. Each needs a one-time auth step (a token or browser OAuth) — the Marketplace walks you through each one.',
    entryIds: ['notion', 'slack', 'gmail', 'google-calendar', 'google-drive'],
    mode: 'guided'
  }
]

/** Eligibility filter — see file header for the rules and why each rule
 *  is strict. Exported so the marketplace UI can display the same count
 *  the Quick Start dialog will actually install. */
export function filterZeroConfigEntries(entries: McpRegistryEntry[]): McpRegistryEntry[] {
  return entries.filter(
    (e) =>
      e.source === 'curated' &&
      !e.discoveryOnly &&
      e.argPrompts.length === 0 &&
      e.envPrompts.length === 0 &&
      !e.requires
  )
}

/** Resolve a profile against the loaded marketplace entries. Missing IDs
 *  drop out.
 *
 *  Bulk profiles draw from the zero-config set only — anything that needs
 *  a key, path, or system dep would silently fail at install time
 *  otherwise. Guided profiles (v2.0+) draw from the full curated set so
 *  credentialed entries like Notion / Gmail / Slack can be surfaced; the
 *  dialog routes the user through the per-entry install flow rather than
 *  bulk-installing them.
 *
 *  Use this BEFORE rendering the confirmation list so the count matches
 *  what the user will see. */
export function resolveProfileEntries(
  profile: QuickStartProfile,
  loaded: McpRegistryEntry[]
): McpRegistryEntry[] {
  if (profile.entryIds === 'all-zero-config') return filterZeroConfigEntries(loaded)
  // Guided profiles still constrain to curated (we're not handing the
  // user a credentialed install for an unaudited PulseMCP/Smithery
  // entry) but they DON'T require zero-config.
  const candidatePool =
    profile.mode === 'guided'
      ? loaded.filter((e) => e.source === 'curated' && !e.discoveryOnly)
      : filterZeroConfigEntries(loaded)
  // Preserve the profile's intended ordering when listing entries,
  // so "Essentials" reads memory→sequential not in registry order.
  const byId = new Map(candidatePool.map((e) => [e.id, e] as const))
  const ordered: McpRegistryEntry[] = []
  for (const id of profile.entryIds) {
    const entry = byId.get(id)
    if (entry) ordered.push(entry)
  }
  return ordered
}
