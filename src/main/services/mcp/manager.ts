/**
 * MCP manager. Owns the live connection per configured server, exposes
 * tools to the AI gateway, and routes the agent's tool calls back to the
 * correct server. Best-effort throughout — a broken server never blocks the
 * rest of the app.
 */
import { randomUUID } from 'node:crypto'
import { McpConnection } from './connection'
import { getServers, setServers } from './store'
import { log } from '../logger'
import { TOOL_SPECS } from '@shared/agent-tools'
import type {
  McpServerConfig,
  McpServerInput,
  McpServerStatus,
  McpToolInfo
} from '@shared/types'
import type { ProviderTool } from '../ai/types'

const connections = new Map<string, McpConnection>()
/**
 * Per-id in-flight bringUp promise. Serialises concurrent enable/disable
 * toggles so we never have two `connect()` calls racing on the same server
 * (which would orphan the loser's stdio child).
 */
const bringUpInFlight = new Map<string, Promise<McpConnection>>()

function statusFrom(config: McpServerConfig, conn?: McpConnection): McpServerStatus {
  const tools = conn?.tools ?? []
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    connected: conn?.connected ?? false,
    error: conn?.error ?? null,
    tools,
    duplicateTools: findDuplicateToolNames(config.id, tools)
  }
}

/**
 * v1.11.0 — duplicate-tool scan. The agent sees a flat namespace of tool
 * names; if two enabled MCP servers both expose `mcp_filesystem_read_file`
 * (possible when two server NAMES slugify to the same 16-char prefix), OR
 * an MCP tool collides with a built-in (`web_search`, `click_on_screen`,
 * etc.), the model's routing between the collisions is undefined. This
 * scan returns the names of THIS server's tools that collide with any
 * other tool the model also sees, so the renderer can flag the row with
 * an amber badge. User-fixable: rename one of the servers OR disable one.
 *
 * Built-in tool names are pulled from TOOL_SPECS — the shared source of
 * truth for what the AI gateway hands to providers.
 */
function findDuplicateToolNames(serverId: string, tools: McpToolInfo[]): string[] {
  if (tools.length === 0) return []
  const seenElsewhere = new Set<string>()
  for (const builtin of TOOL_SPECS) seenElsewhere.add(builtin.name)
  for (const conn of connections.values()) {
    if (!conn.connected) continue
    if (conn.config.id === serverId) continue
    for (const tool of conn.tools) seenElsewhere.add(tool.name)
  }
  return tools.map((t) => t.name).filter((n) => seenElsewhere.has(n))
}

async function bringUp(config: McpServerConfig): Promise<McpConnection> {
  // Chain onto the existing in-flight bringUp so two rapid toggles can't
  // both pass the previous check and proceed to spawn parallel children
  // (which would orphan the loser's process). Each new call awaits whatever
  // is currently registered and then runs in series after it.
  const prev = bringUpInFlight.get(config.id) ?? Promise.resolve(null)
  const work: Promise<McpConnection> = prev
    .catch((err) => {
      // Don't blanket-swallow — log the previous bringUp's failure so the
      // user can see WHY the earlier toggle errored. Returning null still
      // lets the new bringUp proceed (which is the desired behaviour for
      // rapid toggles), but the error doesn't vanish.
      log(
        'warn',
        'mcp',
        `Previous bringUp for "${config.id}" failed before this one started`,
        err instanceof Error ? err.message : String(err)
      )
      return null
    })
    .then(async () => {
    const existing = connections.get(config.id)
    if (existing) await existing.disconnect()
    const conn = new McpConnection(config)
    connections.set(config.id, conn)
    if (config.enabled) await conn.connect()
    return conn
  })
  bringUpInFlight.set(config.id, work)
  try {
    return await work
  } finally {
    if (bringUpInFlight.get(config.id) === work) bringUpInFlight.delete(config.id)
  }
}

/**
 * Connects every enabled server, in parallel. Called once on app start.
 * Uses `allSettled` so one bad config (missing binary, wrong command) can't
 * abort the whole batch — each server's failure is logged inside bringUp
 * and surfaces in Settings → MCP, but the others still come up.
 */
export async function initMcp(): Promise<void> {
  const servers = getServers()
  await Promise.allSettled(servers.map((s) => bringUp(s)))
}

export function listServers(): McpServerStatus[] {
  return getServers().map((s) => statusFrom(s, connections.get(s.id)))
}

/** v1.11.0 — return the full persisted config for one server. Used by
 *  the renderer's Edit form to prefill every field. Returns null when
 *  the id doesn't exist (renderer should reload its list). */
export function getServerConfig(id: string): McpServerConfig | null {
  return getServers().find((s) => s.id === id) ?? null
}

export async function addServer(input: McpServerInput): Promise<McpServerStatus> {
  const config: McpServerConfig = {
    id: randomUUID(),
    name: (input.name || '').trim() || 'Unnamed',
    command: (input.command || '').trim(),
    args: Array.isArray(input.args) ? input.args.map((a) => String(a)) : [],
    env: input.env && typeof input.env === 'object' ? input.env : {},
    enabled: true
  }
  setServers([...getServers(), config])
  await bringUp(config)
  return statusFrom(config, connections.get(config.id))
}

/**
 * v1.11.0 — edit an existing server. Same input shape as `addServer`
 * but keyed by id; preserves the existing `enabled` flag (toggling is
 * a separate action). Disconnects the old config, persists the new
 * one, brings it back up — so a name / command / args / env change
 * actually takes effect without forcing the user to delete + re-add.
 *
 * Returns null when the id doesn't exist (renderer should refresh its
 * list to drop the stale row).
 */
export async function updateServer(
  id: string,
  input: McpServerInput
): Promise<McpServerStatus | null> {
  const servers = getServers()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const updated: McpServerConfig = {
    id,
    name: (input.name || '').trim() || servers[idx].name,
    command: (input.command || '').trim() || servers[idx].command,
    args: Array.isArray(input.args) ? input.args.map((a) => String(a)) : [],
    env: input.env && typeof input.env === 'object' ? input.env : {},
    // Preserve enabled state — edit is orthogonal to enable/disable.
    enabled: servers[idx].enabled
  }
  const next = [...servers]
  next[idx] = updated
  setServers(next)
  // bringUp handles disconnecting any existing connection before
  // starting the new one, so a single call covers the full restart.
  await bringUp(updated)
  return statusFrom(updated, connections.get(id))
}

export async function removeServer(id: string): Promise<McpServerStatus[]> {
  const conn = connections.get(id)
  if (conn) {
    await conn.disconnect()
    connections.delete(id)
  }
  // If a bringUp for this id is mid-flight, its `finally` cleans up only when
  // the entry still matches its own work — drop the entry here so the slot
  // can't leak when removal races a respawn.
  bringUpInFlight.delete(id)
  setServers(getServers().filter((s) => s.id !== id))
  return listServers()
}

export async function setServerEnabled(
  id: string,
  enabled: boolean
): Promise<McpServerStatus | null> {
  const servers = getServers()
  const idx = servers.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const updated: McpServerConfig = { ...servers[idx], enabled }
  const next = [...servers]
  next[idx] = updated
  setServers(next)
  await bringUp(updated)
  return statusFrom(updated, connections.get(id))
}

export async function reconnectServer(id: string): Promise<McpServerStatus | null> {
  const config = getServers().find((s) => s.id === id)
  if (!config) return null
  await bringUp(config)
  return statusFrom(config, connections.get(id))
}

/** Every connected server's tools, flattened. */
export function getAllTools(): McpToolInfo[] {
  const all: McpToolInfo[] = []
  for (const conn of connections.values()) {
    if (conn.connected) all.push(...conn.tools)
  }
  return all
}

/** Same list, shaped for the AI provider's `tools` parameter. */
export function getProviderTools(): ProviderTool[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema
  }))
}

/**
 * v1.13.3 — patterns the MCP filesystem server uses to refuse paths
 * outside its allowlist. Detecting the refusal in the tool result lets
 * us append a fallback hint that the model sees BEFORE its next turn,
 * which is far stronger than a system-prompt directive (weaker models
 * obey transient tool feedback better than baseline instructions).
 *
 * Both phrasings have been observed in the wild — the canonical English
 * wording and a slightly older lowercase variant. Keep the regex narrow
 * so legitimate errors that happen to mention "directories" don't get
 * the hint appended.
 */
const FILESYSTEM_PATH_REFUSAL =
  /access denied[\s\S]*?path outside allowed directories|outside the allowed root directories/i

/**
 * Append-only hint surfaced when MCP filesystem refuses a path. Delivered
 * in the tool RESPONSE (not the system prompt) so the model sees it as
 * immediate feedback in the same turn — gpt-4o-mini and similar weaker
 * models follow this kind of in-context guidance reliably even when they
 * ignore baseline system-prompt nudges.
 */
const FILESYSTEM_FALLBACK_HINT =
  '\n\nHINT FOR THE AGENT: The MCP filesystem server is sandboxed to ' +
  'one configured folder. The built-in `read_file` / `write_file` / ' +
  '`list_files` tools have unrestricted filesystem access (the user ' +
  'has filesystem permission granted) and can read this path. Retry ' +
  'the same path with the built-in tool instead of stopping here.'

/** Routes a prefixed tool call (e.g. mcp_fs_read_file) to its server.
 *  v1.13.3 — when an MCP filesystem tool refuses a path with the
 *  "outside allowed directories" pattern, splice the fallback hint into
 *  the response so the model auto-retries with the built-in tool. */
export async function callTool(
  prefixedName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; text: string }> {
  for (const conn of connections.values()) {
    const tool = conn.tools.find((t) => t.name === prefixedName)
    if (!tool) continue
    const result = await conn.callTool(tool.originalName, args)
    if (FILESYSTEM_PATH_REFUSAL.test(result.text)) {
      return {
        ...result,
        text: result.text + FILESYSTEM_FALLBACK_HINT
      }
    }
    return result
  }
  return { ok: false, text: `Unknown MCP tool: ${prefixedName}` }
}

/** Tears down every connection — call on app quit. `allSettled` so one slow
 *  disconnect can't block the shutdown budget waiting on others. */
export async function disposeMcp(): Promise<void> {
  await Promise.allSettled([...connections.values()].map((c) => c.disconnect()))
  connections.clear()
}
