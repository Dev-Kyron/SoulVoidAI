/**
 * Mirrors the live MCP server statuses exposed by the main process. Each
 * mutator round-trips through the bridge so the on-disk config stays the
 * single source of truth.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { McpServerInput, McpServerStatus } from '@shared/types'

interface McpStore {
  servers: McpServerStatus[]
  loaded: boolean
  load: () => Promise<void>
  add: (input: McpServerInput) => Promise<McpServerStatus>
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
    set((s) => ({ servers: [...s.servers, created] }))
    return created
  },

  remove: async (id) => {
    const servers = await vs.mcp.remove(id)
    set({ servers })
  },

  setEnabled: async (id, enabled) => {
    const updated = await vs.mcp.setEnabled(id, enabled)
    if (!updated) return
    set((s) => ({ servers: s.servers.map((srv) => (srv.id === id ? updated : srv)) }))
  },

  reconnect: async (id) => {
    const updated = await vs.mcp.reconnect(id)
    if (!updated) return
    set((s) => ({ servers: s.servers.map((srv) => (srv.id === id ? updated : srv)) }))
  }
}))
