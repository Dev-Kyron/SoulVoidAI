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
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    connected: conn?.connected ?? false,
    error: conn?.error ?? null,
    tools: conn?.tools ?? []
  }
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

/** Routes a prefixed tool call (e.g. mcp_fs_read_file) to its server. */
export async function callTool(
  prefixedName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; text: string }> {
  for (const conn of connections.values()) {
    const tool = conn.tools.find((t) => t.name === prefixedName)
    if (tool) return conn.callTool(tool.originalName, args)
  }
  return { ok: false, text: `Unknown MCP tool: ${prefixedName}` }
}

/** Tears down every connection — call on app quit. `allSettled` so one slow
 *  disconnect can't block the shutdown budget waiting on others. */
export async function disposeMcp(): Promise<void> {
  await Promise.allSettled([...connections.values()].map((c) => c.disconnect()))
  connections.clear()
}
