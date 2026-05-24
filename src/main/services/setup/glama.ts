/**
 * v1.11.1 — Glama.ai MCP registry adapter.
 *
 * Glama runs a public catalogue of MCP servers at glama.ai/mcp/servers.
 * Their JSON API exposes the same listing programmatically. We map their
 * shape to our McpRegistryEntry so the marketplace can mix Glama results
 * in with Curated + Smithery alongside source-badged cards.
 *
 * Same defensive design as smithery.ts: any failure returns [] and the
 * marketplace gracefully falls back to whatever other sources are alive.
 * The catalogue is browse-only — install commands come from each entry's
 * `command` / `args` so we don't depend on a Glama-specific CLI.
 *
 * If Glama's schema doesn't match what we expect on the first fetch, the
 * adapter logs the raw count vs valid count so a future patch knows
 * which fields to adjust.
 */
import { log } from '../logger'
import type { McpRegistryEntry } from '@shared/types'

/** Best-known public list endpoint. If Glama moves it, the adapter
 *  returns [] gracefully and the marketplace continues with the other
 *  sources — no user-visible failure. */
const GLAMA_LIST_URL = 'https://glama.ai/api/mcp/v1/servers'
const GLAMA_TIMEOUT_MS = 8_000
const GLAMA_PAGE_SIZE = 200

/**
 * Raw Glama list-endpoint shape — confirmed by diagnostic capture in
 * v1.11.3. The list endpoint returns rich metadata but NO install
 * command (those live on a per-entry detail page we'd need an extra
 * HTTP round-trip per item to fetch). v1.11.4 treats Glama entries as
 * discovery-only — we surface them with "View on Glama ↗" cards so
 * users can browse + click through to install instructions.
 */
interface GlamaListEntry {
  id?: string
  name?: string
  namespace?: string
  slug?: string
  description?: string
  /** Glama uses a flat string-attribute system, e.g.
   *  ["author:official", "hosting:remote-capable"]. */
  attributes?: string[]
  repository?: { url?: string }
  /** First entry's `url` points at the Glama detail page for the
   *  server — where install info actually lives. */
  tools?: Array<{ url?: string }>
  environmentVariablesJsonSchema?: unknown
}

interface GlamaListResponse {
  servers?: GlamaListEntry[]
  data?: GlamaListEntry[]
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export async function fetchGlamaRegistry(): Promise<McpRegistryEntry[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GLAMA_TIMEOUT_MS)
    const url = `${GLAMA_LIST_URL}?pageSize=${GLAMA_PAGE_SIZE}`
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'VoidSoul-AI-Companion/1.x (+https://voidsoul.app)'
      },
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
    if (!response.ok) {
      let bodyHint = ''
      try {
        bodyHint = (await response.text()).slice(0, 160)
      } catch {
        /* ignore */
      }
      log(
        'warn',
        'system',
        `Glama registry returned ${response.status} ${response.statusText}; skipping Glama this fetch.${bodyHint ? ` Body: ${bodyHint}` : ''}`
      )
      return []
    }
    const data = (await response.json()) as GlamaListResponse
    // Glama's response shape has varied historically — accept either
    // `servers` or `data` as the array key.
    const raw = Array.isArray(data.servers)
      ? data.servers
      : Array.isArray(data.data)
        ? data.data
        : []
    const entries: McpRegistryEntry[] = []
    for (const item of raw) {
      const mapped = mapGlamaEntry(item)
      if (mapped) entries.push(mapped)
    }
    log(
      'info',
      'system',
      `Glama registry: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'} (raw count ${raw.length}).`
    )
    // v1.11.4 — the diagnostic-sample log path is gone now that the
    // mapper handles Glama\'s real shape. If we see a future schema
    // regression (validation rate drops back to zero), the existing
    // raw-vs-valid count log line above is enough to flag it — at
    // which point we re-add the sample snippet to diagnose.
    return entries
  } catch (err) {
    log(
      'warn',
      'system',
      'Glama registry unreachable; skipping.',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

/**
 * Map one Glama entry to a discovery-only McpRegistryEntry. Returns null
 * when we can\'t even get a name + a link to read more (without those
 * the card would be a dead placeholder).
 *
 * v1.11.4 — discovery-only. Glama\'s list endpoint omits install
 * commands; we surface entries as "View on Glama ↗" cards that open
 * the per-server detail page in the browser. User reads install info
 * there and pastes into VoidSoul\'s Add MCP form.
 *
 * Surfacing tags from `attributes` lets users filter ("popular",
 * "official") inside the marketplace. We strip the `prefix:` portion
 * so the tag chip reads "official" instead of "author:official".
 */
function mapGlamaEntry(item: GlamaListEntry): McpRegistryEntry | null {
  const id = isString(item.id) ? item.id : isString(item.slug) ? item.slug : null
  if (!id || !isString(item.name)) return null

  // Pick the best "view this server" link we have, in priority order:
  // Glama detail page → repository URL → null. Without any, the card
  // would have nowhere to send the user — drop those rare entries.
  const detailUrl =
    (Array.isArray(item.tools) && isString(item.tools[0]?.url) ? item.tools[0]!.url : null) ||
    (isString(item.namespace) && isString(item.slug)
      ? `https://glama.ai/mcp/servers/${item.namespace}/${item.slug}`
      : null) ||
    (isString(item.repository?.url) ? item.repository!.url : null)
  if (!detailUrl) return null

  // Glama tags look like "author:official", "hosting:remote-capable".
  // Strip the prefix so the chip in the UI is a clean word. Cap at 4
  // tags so a verbose entry doesn\'t crowd the card.
  const tags: string[] = []
  if (Array.isArray(item.attributes)) {
    for (const raw of item.attributes) {
      if (!isString(raw)) continue
      const stripped = raw.includes(':') ? raw.split(':')[1] : raw
      if (stripped && !tags.includes(stripped)) tags.push(stripped)
      if (tags.length >= 4) break
    }
  }

  const description = isString(item.description)
    ? item.description.slice(0, 300)
    : `MCP server from Glama: ${item.name}.`

  // Author label — `author:official` → "Glama (official)", else
  // "Glama community". Lets users scan for vetted entries at a glance.
  const isOfficial = (item.attributes ?? []).some(
    (a) => isString(a) && a.toLowerCase() === 'author:official'
  )

  return {
    id: `glama:${id}`,
    name: item.name,
    description,
    category: 'community',
    tags: tags.length > 0 ? tags : undefined,
    // Empty command/args — never invoked. The card renders a "View on
    // Glama ↗" button instead of "Install" because discoveryOnly: true.
    command: '',
    args: [],
    env: {},
    argPrompts: [],
    envPrompts: [],
    author: isOfficial ? 'Glama (official)' : 'Glama community',
    docsUrl: detailUrl,
    source: 'glama',
    discoveryOnly: true
  }
}
