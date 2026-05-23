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
import type {
  McpInstallValues,
  McpMarketplaceInstallResult,
  McpRegistryEntry
} from '@shared/types'

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Dev-Kyron/SoulVoidAI/main/mcp-registry/registry.json'

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
    docsUrl: isString(r.docsUrl) ? r.docsUrl : undefined
  }
}

/** Path to the registry copy bundled into the app's asar at build time —
 *  served as an offline fallback when the GitHub raw CDN is unreachable. */
function bundledMcpRegistryPath(): string {
  return join(app.getAppPath(), 'mcp-registry', 'registry.json')
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
 * Fetch the curated MCP server registry. Tries the live GitHub raw URL
 * first; on any failure (404 before v1.2.0 has shipped the registry, or
 * any network issue) falls back to the bundled copy committed to the
 * repo so the browse view always shows something. Throws only when both
 * paths fail.
 */
export async function fetchMcpRegistry(): Promise<McpRegistryEntry[]> {
  // --- Attempt 1: live registry on GitHub --------------------------------
  try {
    const response = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' } })
    if (response.ok) {
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength && contentLength > MAX_REGISTRY_BYTES) {
        throw new Error('MCP registry is unexpectedly large; refusing to download.')
      }
      return parseRegistryText(await response.text(), 'remote')
    }
    // Distinguish "file isn't on the server yet" (404 — expected before a
    // release lands) from "network is broken" (other status / thrown error).
    log(
      'warn',
      'system',
      `MCP registry remote returned ${response.status}; falling back to bundled copy.`
    )
  } catch (err) {
    log(
      'warn',
      'system',
      'MCP registry remote unreachable; falling back to bundled copy.',
      err instanceof Error ? err.message : String(err)
    )
  }

  // --- Attempt 2: bundled copy from the asar -----------------------------
  try {
    return parseRegistryText(readFileSync(bundledMcpRegistryPath(), 'utf-8'), 'bundled')
  } catch (err) {
    throw new Error(
      'MCP marketplace is offline and no bundled fallback is available. ' +
        (err instanceof Error ? err.message : String(err))
    )
  }
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
