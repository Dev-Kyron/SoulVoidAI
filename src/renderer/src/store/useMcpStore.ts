/**
 * Mirrors the live MCP server statuses exposed by the main process. Each
 * mutator round-trips through the bridge so the on-disk config stays the
 * single source of truth.
 *
 * v1.11.0 — every mutation reloads the FULL server list rather than
 * splicing a single row. Reason: the new duplicateTools field on each
 * status depends on the cross-server picture (whether THIS server's
 * tools collide with ANOTHER server's). A single-row update from
 * `addServer` / `updateServer` returns only that server's snapshot,
 * which can't include collisions caused by other servers. Reloading
 * the whole list after each mutation keeps every row's duplicate flag
 * in sync. The list IPC is cheap (synchronous read of in-memory
 * connection state), so the extra round-trip is invisible.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { McpServerInput, McpServerStatus } from '@shared/types'

interface McpStore {
  servers: McpServerStatus[]
  loaded: boolean
  load: () => Promise<void>
  add: (input: McpServerInput) => Promise<McpServerStatus>
  update: (id: string, input: McpServerInput) => Promise<McpServerStatus | null>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  reconnect: (id: string) => Promise<void>
}

export const useMcpStore = create<McpStore>((set) => ({
  servers: [],
  loaded: false,

  load: async () => {
    const servers = await vs.mcp.list()
    set({ servers, loaded: true })
  },

  add: async (input) => {
    const created = await vs.mcp.add(input)
    // Reload so duplicateTools flags on every row reflect the new
    // server's contribution to the cross-server tool namespace.
    const servers = await vs.mcp.list()
    set({ servers })
    return created
  },

  update: async (id, input) => {
    const updated = await vs.mcp.update(id, input)
    if (!updated) return null
    const servers = await vs.mcp.list()
    set({ servers })
    return updated
  },

  remove: async (id) => {
    const servers = await vs.mcp.remove(id)
    set({ servers })
  },

  setEnabled: async (id, enabled) => {
    const updated = await vs.mcp.setEnabled(id, enabled)
    if (!updated) return
    // Reload — disabling a server REMOVES its tools from the namespace,
    // which can resolve a duplicate flag on OTHER servers.
    const servers = await vs.mcp.list()
    set({ servers })
  },

  reconnect: async (id) => {
    const updated = await vs.mcp.reconnect(id)
    if (!updated) return
    const servers = await vs.mcp.list()
    set({ servers })
  }
}))
