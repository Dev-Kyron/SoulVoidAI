/**
 * MCP server marketplace — fetches the curated registry from the repo's
 * `mcp-registry/registry.json` over the GitHub raw CDN, plus a one-click
 * install function that templates user-supplied values into the entry's
 * args / env and hands the result to the existing `addServer()` flow.
 *
 * Why a remote registry rather than a baked-in list:
 *  - New community-popular MCP servers appear weekly; users running a
 *    six-month-old VoidSoul build still see today's options without an
 *    app update.
 *  - PRs to the registry file are the contribution surface for adding
 *    new entries — no Electron code change required.
 *
 * Mirrors the same shape as `plugins/plugins.ts`'s `fetchRegistry()`:
 * GET → JSON parse → light validation → return. 200 KB size cap on the
 * response keeps a compromised raw host from streaming a runaway file
 * into our memory.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { addServer, listServers } from '../mcp/manager'
import { log } from '../logger'
import { fetchSmitheryRegistry } from './smithery'
import { fetchGlamaRegistry } from './glama'
import { fetchPulseMcpRegistry } from './pulsemcp'
import { verifyRegistrySignature } from './registry-signing'
import type {
  McpInstallValues,
  McpMarketplaceInstallResult,
  McpRegistryEntry
} from '@shared/types'

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Dev-Kyron/SoulVoidAI/main/mcp-registry/registry.json'

/** v1.12.0 — companion signature file for the curated registry. Same
 *  path conventions as REGISTRY_URL; both files are fetched in parallel
 *  and the signature verifies the SHA-256 of the registry bytes. */
const REGISTRY_SIGNATURE_URL =
  'https://raw.githubusercontent.com/Dev-Kyron/SoulVoidAI/main/mcp-registry/signature.json'

/** Refusing to parse anything larger than 200 KB — way past the headroom
 *  any realistic curated list of MCP servers needs. */
const MAX_REGISTRY_BYTES = 200_000

interface RegistryFile {
  version?: number
  servers?: unknown[]
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate a single registry row coming off the wire. Bad entries are
 * dropped silently — same philosophy as the plugin parser: one malformed
 * row in the registry shouldn't blank the whole browse view.
 */
function validateEntry(raw: unknown): McpRegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isString(r.id)) return null
  if (!isString(r.name)) return null
  if (!isString(r.description)) return null
  if (!isString(r.command)) return null
  if (!Array.isArray(r.args)) return null

  const args = r.args.filter(isString)
  const env = (r.env && typeof r.env === 'object' ? r.env : {}) as Record<string, string>

  // argPrompts / envPrompts default to empty arrays — the entry's still
  // installable as a one-click without prompts.
  const argPrompts = Array.isArray(r.argPrompts)
    ? r.argPrompts.filter((p) => p && typeof p === 'object').map((p) => p as McpRegistryEntry['argPrompts'][number])
    : []
  const envPrompts = Array.isArray(r.envPrompts)
    ? r.envPrompts.filter((p) => p && typeof p === 'object').map((p) => p as McpRegistryEntry['envPrompts'][number])
    : []

  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: isString(r.category) ? r.category : 'other',
    tags: Array.isArray(r.tags) ? r.tags.filter(isString) : undefined,
    command: r.command,
    args,
    env,
    argPrompts,
    envPrompts,
    requires: isString(r.requires) ? r.requires : undefined,
    author: isString(r.author) ? r.author : undefined,
    docsUrl: isString(r.docsUrl) ? r.docsUrl : undefined,
    source: 'curated'
  }
}

/** Path to a file in the bundled `mcp-registry/` directory (registry.json
 *  or its companion signature.json). Used as an offline fallback when the
 *  GitHub raw CDN is unreachable, and as the trusted ground-truth signed
 *  with our private key. */
function bundledMcpAssetPath(basename: 'registry.json' | 'signature.json'): string {
  return join(app.getAppPath(), 'mcp-registry', basename)
}

/**
 * Mark every entry in `entries` as cryptographically verified. Stamping
 * happens AFTER parsing so the parser doesn\'t need to know about
 * signatures — keeps that concern outside the per-row validator.
 */
function markVerified(entries: McpRegistryEntry[]): McpRegistryEntry[] {
  return entries.map((e) => ({ ...e, verified: true }))
}

/** Parse a registry text blob into validated entries. Shared between the
 *  remote and bundled-fallback paths so they emit the same log line and
 *  apply the same per-entry validation. */
function parseRegistryText(text: string, source: 'remote' | 'bundled'): McpRegistryEntry[] {
  if (text.length > MAX_REGISTRY_BYTES) {
    throw new Error('MCP registry is unexpectedly large; refusing to parse.')
  }
  let parsed: RegistryFile
  try {
    parsed = JSON.parse(text) as RegistryFile
  } catch {
    throw new Error('MCP registry is not valid JSON.')
  }
  const entries: McpRegistryEntry[] = []
  for (const raw of parsed.servers ?? []) {
    const entry = validateEntry(raw)
    if (entry) entries.push(entry)
  }
  log(
    'info',
    'system',
    `MCP registry (${source}): ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'}.`
  )
  return entries
}

/**
 * Fetch the curated MCP server registry.
 *
 * v1.11.2 — MERGE bundled + remote instead of remote-with-bundled-fallback.
 *
 * Old behaviour (v1.2.0–v1.11.1): try remote, fall back to bundled on
 * failure. Worked fine when bundled was the "default" and remote was
 * "the latest". Broke when we shipped v1.11.1 with 11 new entries in
 * bundled — the remote still served the old 10 (no push lag yet) so the
 * new entries silently never appeared.
 *
 * New behaviour: always start from bundled (the version we shipped with
 * this app), then merge in any remote entries we don't already have by
 * id. Result:
 *  · v1.11.1 users see all 21 shipped entries the moment they update,
 *    regardless of remote state.
 *  · Future entries added to the remote between releases STILL appear
 *    for existing users (they just join the bundled set).
 *  · A broken remote (404, network down, hostile mirror) can't remove
 *    or downgrade the bundled set — only add.
 */
async function fetchCuratedRegistry(): Promise<McpRegistryEntry[]> {
  // --- Always-on baseline: the bundled copy that ships in the asar.
  //     v1.12.0 — paired signature verification. If the bundled
  //     signature doesn't verify, we still surface the entries (the
  //     bundled JSON is part of the signed app binary, so a
  //     verification failure here is much more likely "we forgot to
  //     re-sign after editing" than "tampering happened") — but they
  //     drop the Verified badge so the UI stays honest.
  let bundled: McpRegistryEntry[] = []
  try {
    const registryText = readFileSync(bundledMcpAssetPath('registry.json'), 'utf-8')
    bundled = parseRegistryText(registryText, 'bundled')
    try {
      const signatureText = readFileSync(bundledMcpAssetPath('signature.json'), 'utf-8')
      if (verifyRegistrySignature(registryText, signatureText, 'bundled')) {
        bundled = markVerified(bundled)
      }
    } catch {
      log(
        'warn',
        'system',
        'Bundled MCP registry signature missing — entries will not show the Verified badge. Run `node scripts/sign-mcp-registry.mjs` to re-sign.'
      )
    }
  } catch (err) {
    log(
      'warn',
      'system',
      'Bundled MCP registry could not be read — relying on remote + community sources only.',
      err instanceof Error ? err.message : String(err)
    )
  }
  // --- Best-effort additions: any remote entries the bundled set doesn\'t cover.
  //     v1.12.0 — fetch registry.json + signature.json in parallel; if
  //     verification fails (network tampering / stale sig / etc.) we
  //     STILL parse and surface the entries but withhold the Verified
  //     badge. They\'ll still be installable; users just see they\'re
  //     unverified instead of verified.
  let remote: McpRegistryEntry[] = []
  try {
    const [registryResp, signatureResp] = await Promise.all([
      fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } }),
      fetch(REGISTRY_SIGNATURE_URL, { headers: { Accept: 'application/json' } }).catch(
        () => null
      )
    ])
    if (registryResp.ok) {
      const contentLength = Number(registryResp.headers.get('content-length') ?? '0')
      if (!contentLength || contentLength <= MAX_REGISTRY_BYTES) {
        const registryText = await registryResp.text()
        remote = parseRegistryText(registryText, 'remote')
        if (signatureResp && signatureResp.ok) {
          const signatureText = await signatureResp.text()
          if (verifyRegistrySignature(registryText, signatureText, 'remote')) {
            remote = markVerified(remote)
          }
        } else {
          log(
            'warn',
            'system',
            `MCP registry remote signature unavailable (status ${signatureResp?.status ?? 'fetch-failed'}); remote entries will not show the Verified badge.`
          )
        }
      } else {
        log('warn', 'system', 'MCP registry remote is unexpectedly large; using bundled only.')
      }
    } else {
      log(
        'warn',
        'system',
        `MCP registry remote returned ${registryResp.status}; using bundled only.`
      )
    }
  } catch (err) {
    log(
      'warn',
      'system',
      'MCP registry remote unreachable; using bundled only.',
      err instanceof Error ? err.message : String(err)
    )
  }
  // Merge by id — bundled wins on conflict (it\'s the version we
  // hand-tested against THIS app build). Remote-only entries get added.
  const byId = new Map<string, McpRegistryEntry>()
  for (const entry of bundled) byId.set(entry.id, entry)
  for (const entry of remote) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  return Array.from(byId.values())
}

/**
 * v1.11.0 — fetch all enabled registry sources in parallel and merge.
 * Curated entries always win on dedup (we trust our reviewed picks over
 * Smithery's broader catalogue). Dedup key is the install command line:
 * a curated `npx -y @modelcontextprotocol/server-filesystem` and a
 * Smithery `npx -y @smithery/cli install @mcp/filesystem` are different
 * commands so they coexist — but the same exact command-line from two
 * sources collapses to one card.
 *
 * Throws only when EVERY source returned empty AND no bundled fallback
 * was available — practically never (the bundled curated copy is part
 * of the app).
 *
 * v1.12.0 — in-flight dedup + short TTL cache. React 19 StrictMode
 * double-mounts the marketplace dialog in dev (and rapid open/close/open
 * cycles in prod do similar), which used to fan out 4× HTTPS requests
 * twice and log every source twice. Now: any second call while the first
 * is still resolving returns the same promise; results cached briefly so
 * a re-open right after close skips the network entirely.
 */
let inflightRegistryFetch: Promise<McpRegistryEntry[]> | null = null
let cachedRegistry: { value: McpRegistryEntry[]; expiresAt: number } | null = null
/** Short enough that "open dialog, see entries, close, change a setting,
 *  reopen" gives fresh data; long enough to swallow StrictMode double-mounts
 *  and accidental re-opens. */
const REGISTRY_CACHE_TTL_MS = 30_000

export async function fetchMcpRegistry(opts: {
  /** Bypass the TTL cache and force a fresh network fan-out. Wired to the
   *  in-dialog Refresh button so a user reacting to a network hiccup
   *  actually re-fetches instead of getting the same cached miss back. */
  force?: boolean
} = {}): Promise<McpRegistryEntry[]> {
  if (opts.force) {
    cachedRegistry = null
    // Note: an in-flight fetch from a normal (non-forced) caller can still
    // be reused — refresh kicks a new one ONLY when no fetch is already
    // running. Two simultaneous forces would otherwise burn 8 HTTPS calls.
  }
  const now = Date.now()
  if (cachedRegistry && cachedRegistry.expiresAt > now) return cachedRegistry.value
  if (inflightRegistryFetch) return inflightRegistryFetch
  inflightRegistryFetch = (async () => {
    try {
      const result = await fetchMcpRegistryUncached()
      cachedRegistry = { value: result, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS }
      return result
    } finally {
      inflightRegistryFetch = null
    }
  })()
  return inflightRegistryFetch
}

async function fetchMcpRegistryUncached(): Promise<McpRegistryEntry[]> {
  // v1.12.0 — fan out to 4 sources in parallel (Cline removed; their
  // marketplace JSON isn\'t exposed at a public path we could find).
  // Each source returns [] on any failure so a single broken catalogue
  // can never take down the marketplace view.
  const [curated, smithery, glama, pulsemcp] = await Promise.all([
    fetchCuratedRegistry(),
    fetchSmitheryRegistry(),
    fetchGlamaRegistry(),
    fetchPulseMcpRegistry()
  ])
  const total = curated.length + smithery.length + glama.length + pulsemcp.length
  if (total === 0) {
    throw new Error(
      'MCP marketplace has no entries available from any source right now. ' +
        'Check your network connection or try again later.'
    )
  }

  // Dedup by command-line. Order = trust-priority: Curated (hand-reviewed
  // + cryptographically signed) > PulseMCP (best metadata + install info)
  // > Smithery (large catalogue) > Glama (discovery only). Earlier-listed
  // sources win on conflict, so identical install commands keep our
  // hand-written descriptions over auto-generated ones.
  //
  // Discovery-only entries get keyed by their unique id instead of by
  // command, because they all share an empty command and would otherwise
  // collapse into a single card. Ids are source-namespaced ("glama:xyz",
  // "pulsemcp:pkg") so they can\'t collide with installable entries\'
  // command keys.
  const seen = new Map<string, McpRegistryEntry>()
  const keyFor = (e: McpRegistryEntry): string =>
    e.discoveryOnly ? e.id : `${e.command} ${e.args.join(' ')}`.trim()
  for (const entry of [...curated, ...pulsemcp, ...smithery, ...glama]) {
    const key = keyFor(entry)
    if (!seen.has(key)) seen.set(key, entry)
  }
  return Array.from(seen.values())
}

/**
 * Templates `{KEY}` tokens in an args array with user-supplied values.
 * Unknown tokens are left intact — usually a sign the registry entry is
 * inconsistent with the prompts list, and worth surfacing rather than
 * silently producing a malformed command line.
 */
function templateArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{([A-Z0-9_]+)\}/g, (_, key) => values[key] ?? `{${key}}`)
  )
}

export interface InstallRegistryServerInput {
  entry: McpRegistryEntry
  values: McpInstallValues
}

/**
 * Install a registry entry. Validates that every prompted value is filled
 * in (the dialog should already enforce this; the main-side check guards
 * against a renderer skipping it), templates the args, merges env, then
 * calls the existing `addServer()` so the install inherits every guarantee
 * a hand-typed add does.
 *
 * Skips installation if a server with the same name already exists — the
 * UI can read that response back as "Already installed" and surface a
 * neutral message rather than failing the action. Same shape as the
 * bridge type so the renderer can render it without translation.
 */
export async function installRegistryServer({
  entry,
  values
}: InstallRegistryServerInput): Promise<McpMarketplaceInstallResult> {
  // Validate prompts — every prompt key must have a non-empty value.
  for (const prompt of entry.argPrompts) {
    const value = values.args[prompt.key]
    if (!value || !value.trim()) {
      return { ok: false, error: `Missing required value: ${prompt.label}` }
    }
  }
  for (const prompt of entry.envPrompts) {
    const value = values.env[prompt.key]
    if (!value || !value.trim()) {
      return { ok: false, error: `Missing required env var: ${prompt.label}` }
    }
  }

  // Already installed by name? Surface as a soft "ok with skip" rather
  // than an error — re-clicking Install on an already-installed card
  // shouldn't read as a failure to the user. The `skipped: true` flag
  // lets the dialog show "Already installed" instead of the misleading
  // "X connected · N tools" toast that suggests a fresh install happened.
  const existing = listServers().find((s) => s.name === entry.name)
  if (existing) {
    return { ok: true, skipped: true, status: existing }
  }

  // Template the args. Trim values before templating so a user pasting
  // a value with trailing whitespace doesn't end up with a path like
  // `/Users/x/code `.
  const trimmedArgValues: Record<string, string> = {}
  for (const [k, v] of Object.entries(values.args)) trimmedArgValues[k] = v.trim()
  const finalArgs = templateArgs(entry.args, trimmedArgValues)

  // Env: merge defaults from the entry with user-supplied values. User
  // values win on key collision (the entry shouldn't define a value AND
  // a prompt for the same key, but if it does, treat the prompt as
  // authoritative — that's what the user actually filled in).
  const finalEnv: Record<string, string> = { ...entry.env }
  for (const [k, v] of Object.entries(values.env)) finalEnv[k] = v.trim()

  try {
    const status = await addServer({
      name: entry.name,
      command: entry.command,
      args: finalArgs,
      env: finalEnv
    })
    log('info', 'system', `MCP marketplace: installed "${entry.name}".`)
    return { ok: true, status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
