/**
 * v1.11.5 — PulseMCP registry adapter.
 *
 * PulseMCP runs a well-documented REST API at api.pulsemcp.com that
 * catalogues 500+ MCP servers with package metadata — npm package name,
 * pypi package name, GitHub URL, download counts, etc. The key win
 * vs Cline/Glama: their list entries INCLUDE enough info to derive a
 * runnable install command without a follow-up detail fetch.
 *
 * For each entry:
 *  · package_registry === 'npm' → install as `npx -y <package_name>`
 *  · package_registry === 'pypi' → install as `uvx <package_name>`
 *    (with the `requires: 'uv'` badge so users know the prereq)
 *  · neither → discovery-only "View on PulseMCP ↗" card
 *
 * Same defensive design as the other adapters — any failure returns [].
 */
import { log } from '../logger'
import type { McpRegistryEntry } from '@shared/types'

/** PulseMCP\'s public REST endpoint. v0beta is documented as the
 *  current stable version as of this writing; their docs explicitly
 *  call out that v0beta will be promoted to v1 once it stabilises. */
const PULSEMCP_LIST_URL = 'https://api.pulsemcp.com/v0beta/servers'
const PULSEMCP_TIMEOUT_MS = 10_000
const PULSEMCP_PAGE_SIZE = 200

interface PulseMcpListEntry {
  name?: string
  url?: string
  external_url?: string
  short_description?: string
  source_code_url?: string
  package_registry?: string
  package_name?: string
  package_download_count?: number
  github_stars?: number
  EXPERIMENTAL_ai_generated_description?: string
}

interface PulseMcpListResponse {
  servers?: PulseMcpListEntry[]
  total_count?: number
  next?: string | null
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export async function fetchPulseMcpRegistry(): Promise<McpRegistryEntry[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PULSEMCP_TIMEOUT_MS)
    const url = `${PULSEMCP_LIST_URL}?count_per_page=${PULSEMCP_PAGE_SIZE}`
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
        `PulseMCP registry returned ${response.status} ${response.statusText}; skipping PulseMCP this fetch.${bodyHint ? ` Body: ${bodyHint}` : ''}`
      )
      return []
    }
    const data = (await response.json()) as PulseMcpListResponse
    const raw = Array.isArray(data.servers) ? data.servers : []
    const entries: McpRegistryEntry[] = []
    for (const item of raw) {
      const mapped = mapPulseMcpEntry(item)
      if (mapped) entries.push(mapped)
    }
    log(
      'info',
      'system',
      `PulseMCP registry: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'} (raw count ${raw.length}).`
    )
    return entries
  } catch (err) {
    log(
      'warn',
      'system',
      'PulseMCP registry unreachable; skipping.',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

/**
 * Map one PulseMCP entry to McpRegistryEntry. Tries to produce an
 * installable entry when we have package info; falls back to discovery-
 * only when the entry references a custom install method we can\'t
 * synthesise (rare).
 */
function mapPulseMcpEntry(item: PulseMcpListEntry): McpRegistryEntry | null {
  const name = isString(item.name) ? item.name : null
  if (!name) return null

  const detailUrl =
    (isString(item.url) ? item.url : null) ||
    (isString(item.external_url) ? item.external_url : null) ||
    (isString(item.source_code_url) ? item.source_code_url : null)
  if (!detailUrl) return null

  const description = isString(item.short_description)
    ? item.short_description.slice(0, 300)
    : isString(item.EXPERIMENTAL_ai_generated_description)
      ? item.EXPERIMENTAL_ai_generated_description.slice(0, 300)
      : `MCP server from PulseMCP: ${name}.`

  // Stable, namespaced id. Use package name when available (most
  // distinctive), fall back to a URL slug otherwise.
  const idSlug = isString(item.package_name)
    ? item.package_name
    : detailUrl.replace(/[^a-z0-9]+/gi, '-').slice(-48)
  const id = `pulsemcp:${idSlug}`

  // Tags: popularity signal + registry source so users can filter
  // "popular" servers or filter by stack (npm vs python).
  const tags: string[] = []
  if (typeof item.package_download_count === 'number' && item.package_download_count > 10_000) {
    tags.push('popular')
  }
  if (typeof item.github_stars === 'number' && item.github_stars > 500) {
    tags.push('starred')
  }
  if (isString(item.package_registry)) tags.push(item.package_registry.toLowerCase())

  // Derive install command from package info. npm → npx, pypi → uvx.
  // Any other registry (or missing package) falls back to discovery.
  const registry = isString(item.package_registry) ? item.package_registry.toLowerCase() : null
  const packageName = isString(item.package_name) ? item.package_name : null

  let command = ''
  let args: string[] = []
  let requires: string | undefined
  let discoveryOnly = false
  if (registry === 'npm' && packageName) {
    command = 'npx'
    args = ['-y', packageName]
  } else if (registry === 'pypi' && packageName) {
    command = 'uvx'
    args = [packageName]
    requires = 'uv'
  } else {
    // No recognised install pattern — render as discovery-only.
    discoveryOnly = true
  }

  return {
    id,
    name,
    description,
    category: 'community',
    tags: tags.length > 0 ? tags.slice(0, 6) : undefined,
    command,
    args,
    env: {},
    argPrompts: [],
    envPrompts: [],
    requires,
    author: 'PulseMCP',
    docsUrl: detailUrl,
    source: 'pulsemcp',
    discoveryOnly: discoveryOnly || undefined
  }
}
