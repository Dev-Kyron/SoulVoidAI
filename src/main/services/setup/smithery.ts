/**
 * v1.11.0 — Smithery.ai registry adapter.
 *
 * Smithery is the de-facto community catalogue for MCP servers (~1000
 * entries, vs our ~20 curated picks). Their public registry exposes a
 * paginated JSON listing at registry.smithery.ai. We map each entry to
 * our McpRegistryEntry shape so the existing marketplace dialog can
 * render Smithery servers alongside our curated picks without any
 * source-specific UI branching beyond a small "Smithery" badge.
 *
 * Install path: for Smithery entries, the install command pattern is
 *   npx -y @smithery/cli@latest install <qualifiedName> --client voidsoul
 *
 * We DON'T auto-invoke that — we prefill it into the Add form so the
 * user can review what's about to be installed (every Smithery entry
 * runs arbitrary code under the user's account; informed consent
 * matters). For curated entries we keep the existing one-click flow.
 *
 * Failure handling: any error from Smithery (offline, schema change,
 * rate limit) returns an empty array. The marketplace already merges
 * results from multiple sources, so a Smithery outage just means the
 * user temporarily only sees our curated picks.
 */
import { log } from '../logger'
import type { McpRegistryEntry } from '@shared/types'

const SMITHERY_LIST_URL = 'https://registry.smithery.ai/servers'
/** Top-N most-used Smithery servers per fetch. Smithery caps pageSize
 *  at 100 (v1.11.1's 200 returned 400 Bad Request — beta caught it).
 *  100 is plenty: their catalogue includes a long tail of single-use
 *  community entries; the most-installed ones are what beginners want
 *  to see first, and 100 covers that comfortably. */
const SMITHERY_PAGE_SIZE = 100
const SMITHERY_TIMEOUT_MS = 8_000

/**
 * Raw Smithery list-endpoint shape — what we read off the wire. We only
 * type the fields we actually consume; Smithery may add more (icon URL,
 * verified flag, etc.) without breaking us.
 */
interface SmitheryListEntry {
  qualifiedName?: string
  displayName?: string
  description?: string
  homepage?: string
  useCount?: number
  remote?: boolean
  iconUrl?: string
}

interface SmitheryListResponse {
  servers?: SmitheryListEntry[]
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Fetch Smithery's catalogue and map to our registry shape. Returns
 * empty on any failure — caller treats an empty result as "Smithery is
 * unavailable right now, show only curated picks" rather than blowing
 * up the whole marketplace.
 */
export async function fetchSmitheryRegistry(): Promise<McpRegistryEntry[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SMITHERY_TIMEOUT_MS)
    const url = `${SMITHERY_LIST_URL}?pageSize=${SMITHERY_PAGE_SIZE}`
    // v1.11.1 — explicit User-Agent. Some catalogues reject default
    // Electron / undici UAs; identifying ourselves cleanly is the
    // polite + likely-to-succeed default.
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'VoidSoul-AI-Companion/1.x (+https://voidsoul.app)'
      },
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
    if (!response.ok) {
      // v1.11.1 — capture a snippet of the response body when available.
      // Helps distinguish 401 (auth required), 404 (endpoint moved),
      // 429 (rate-limited) without needing to attach a debugger.
      let bodyHint = ''
      try {
        bodyHint = (await response.text()).slice(0, 160)
      } catch {
        /* ignore */
      }
      log(
        'warn',
        'system',
        `Smithery registry returned ${response.status} ${response.statusText}; skipping Smithery this fetch.${bodyHint ? ` Body: ${bodyHint}` : ''}`
      )
      return []
    }
    const data = (await response.json()) as SmitheryListResponse
    const raw = Array.isArray(data.servers) ? data.servers : []
    const entries: McpRegistryEntry[] = []
    for (const item of raw) {
      const mapped = mapSmitheryEntry(item)
      if (mapped) entries.push(mapped)
    }
    log(
      'info',
      'system',
      `Smithery registry: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'} (raw count ${raw.length}).`
    )
    return entries
  } catch (err) {
    log(
      'warn',
      'system',
      'Smithery registry unreachable; skipping.',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

/**
 * Map one Smithery list entry to our McpRegistryEntry shape. Returns
 * null when required fields are missing — drop bad entries silently
 * rather than poisoning the merged list with broken cards.
 *
 * Install command: Smithery servers install via their own CLI helper,
 * `npx -y @smithery/cli@latest install <qualifiedName> --client voidsoul`.
 * The client flag tells Smithery what app to configure — they don't
 * actually know us yet, but the CLI falls back to printing the install
 * command for the user to handle. We surface this as the templated
 * args; user can also click through to homepage / docs.
 */
function mapSmitheryEntry(item: SmitheryListEntry): McpRegistryEntry | null {
  if (!isString(item.qualifiedName) || !isString(item.displayName)) return null

  // v1.11.3 — keep remote-hosted servers. Previous version dropped
  // every `remote: true` entry, which left only ~3 of the catalogue
  // showing (Smithery has heavily moved toward HTTP-transport hosting).
  // The Smithery CLI handles BOTH stdio AND remote on install — it
  // wires up the transport for us. The actual runtime connection from
  // VoidSoul's MCP client may not fully support remote yet, but the
  // browse + install experience works either way, and gating the
  // catalogue at browse time hides what's actually available.
  const tags: string[] = []
  if (item.remote === true) tags.push('remote')
  if (typeof item.useCount === 'number' && item.useCount > 100) tags.push('popular')

  const description = isString(item.description)
    ? item.description.slice(0, 300)
    : `MCP server from Smithery: ${item.displayName}.`

  return {
    // Prefix with smithery: so ids never collide with curated entries.
    id: `smithery:${item.qualifiedName}`,
    name: item.displayName,
    description,
    category: 'community',
    tags: tags.length > 0 ? tags : undefined,
    // Install via the Smithery CLI — same pattern Smithery's own docs
    // show. User reviews + accepts in our Add form.
    command: 'npx',
    args: ['-y', '@smithery/cli@latest', 'install', item.qualifiedName, '--client', 'voidsoul'],
    env: {},
    argPrompts: [],
    envPrompts: [],
    author: 'Smithery',
    docsUrl: item.homepage,
    source: 'smithery'
  }
}
