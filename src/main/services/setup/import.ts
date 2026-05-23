/**
 * Setup-time importers. Take row(s) from the detection report and actually
 * write them into VoidSoul's storage layer — MCP servers via the existing
 * `addServer()` flow, API keys via `setApiKey()` (which encrypts them in
 * the OS keychain).
 *
 * Built deliberately on the SAME functions the in-Settings forms call, so
 * imports inherit every guarantee those flows already have: name trimming,
 * env-shape coercion, immediate `bringUp()`, keychain encryption.
 *
 * Result shape is uniform across imports — `{ imported, skipped, failures }`
 * — so the renderer can render the same "X imported, Y skipped, Z failed"
 * summary regardless of which import path the user ran.
 */
import { addServer, listServers } from '../mcp/manager'
import { setApiKey } from '../storage/keys'
import { log } from '../logger'
import { runSetupDetection } from './detect'
import { ENV_KEY_PROVIDERS } from './parse'
import type {
  DetectedMcpServer,
  ProviderId,
  SetupEnvKeyImportResult,
  SetupImportFailure,
  SetupImportResult
} from '@shared/types'

/* ---------------------------- MCP imports ---------------------------- */

/**
 * Selectively import MCP servers from a previously-detected source. Names
 * are matched against the freshly-rerun detection report — we re-detect
 * inside the function (cheap, <50 ms) so the data can never go stale
 * between when the user opened the panel and when they clicked import.
 *
 *  - Name collision in VoidSoul's existing config → skipped, NOT failed
 *    (running import twice is idempotent — second run shows 0 imported,
 *    N skipped, which is the right read for the UI).
 *  - Name not present in the source config → failure (caller passed a
 *    bogus name; tells them the source config was edited mid-flight).
 *  - `addServer()` throws → failure with the thrown message.
 *
 * The `source` parameter splits the report at the right key so the two
 * importers (Claude / Cursor) reuse the same body.
 */
async function importMcpFromSource(
  source: DetectedMcpServer['source'],
  names: string[]
): Promise<SetupImportResult> {
  const report = runSetupDetection()
  const detectedList = source === 'claude-desktop'
    ? report.claudeDesktop.mcpServers
    : report.cursor.mcpServers
  const detectedByName = new Map(detectedList.map((s) => [s.name, s]))

  const existingNames = new Set(listServers().map((s) => s.name))
  const wanted = new Set(names)

  const failures: SetupImportFailure[] = []
  let imported = 0
  let skipped = 0

  for (const name of wanted) {
    const server = detectedByName.get(name)
    if (!server) {
      failures.push({ name, reason: 'Not found in source config (was it removed?).' })
      continue
    }
    if (existingNames.has(server.name)) {
      // Idempotent skip — running import a second time after the user
      // adds more servers in Claude Desktop should pick up the new ones
      // without duplicating the already-imported ones.
      skipped++
      continue
    }
    try {
      await addServer({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env
      })
      imported++
      // After-import bookkeeping: remember the new name in our local set so
      // duplicate entries in the same import call (unlikely but possible)
      // skip the second occurrence instead of failing the addServer call.
      existingNames.add(server.name)
    } catch (err) {
      failures.push({
        name: server.name,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  log(
    'info',
    'system',
    `MCP import (${source}): ${imported} imported, ${skipped} skipped, ${failures.length} failed.`
  )
  return { imported, skipped, failures }
}

export function importClaudeDesktopServers(names: string[]): Promise<SetupImportResult> {
  return importMcpFromSource('claude-desktop', names)
}

export function importCursorServers(names: string[]): Promise<SetupImportResult> {
  return importMcpFromSource('cursor', names)
}

/* --------------------------- env-key import -------------------------- */

/**
 * Read an API key out of `process.env` (the secret never crossed IPC; the
 * renderer asked us to read it again here at import time) and persist it
 * to the OS keychain via the existing `setApiKey()` path.
 *
 * Looks up the first env-var alias for the requested provider — for Gemini
 * that's `GOOGLE_API_KEY` first, falling back to `GEMINI_API_KEY` and
 * `GOOGLE_GENAI_API_KEY` in order. Whichever is set wins; the rest are
 * ignored.
 *
 * Returns success/error rather than throwing so the renderer can render a
 * per-row outcome ("✓ Anthropic imported · ✗ Mistral key missing") in
 * the import dialog.
 */
export function importEnvKey(providerId: ProviderId): SetupEnvKeyImportResult {
  // Walk every alias that points at this provider, take the first one
  // that's actually populated in the live env.
  const aliases = Object.entries(ENV_KEY_PROVIDERS)
    .filter(([, p]) => p === providerId)
    .map(([varName]) => varName)

  if (aliases.length === 0) {
    return {
      providerId,
      success: false,
      error: `No env-var convention defined for provider "${providerId}".`
    }
  }

  for (const varName of aliases) {
    const value = process.env[varName]
    if (value && value.trim()) {
      try {
        setApiKey(providerId, value.trim())
        log('info', 'system', `Env-key import: stored ${providerId} key from ${varName}.`)
        return { providerId, success: true }
      } catch (err) {
        return {
          providerId,
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  }

  return {
    providerId,
    success: false,
    error: `No env var set for ${providerId} (tried ${aliases.join(', ')}).`
  }
}
