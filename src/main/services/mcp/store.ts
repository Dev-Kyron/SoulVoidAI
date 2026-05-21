/**
 * Persistent storage for MCP server configurations. One JSON file under the
 * app's data folder, keyed by the same atomic JsonStore the rest of the
 * configuration uses.
 */
import { JsonStore } from '../storage/store'
import type { McpServerConfig } from '@shared/types'

interface McpFile {
  servers: McpServerConfig[]
}

const DEFAULT: McpFile = { servers: [] }
let cached: JsonStore<McpFile> | null = null

function store(): JsonStore<McpFile> {
  if (!cached) cached = new JsonStore<McpFile>('mcp', DEFAULT)
  return cached
}

export function getServers(): McpServerConfig[] {
  return store().get().servers
}

export function setServers(servers: McpServerConfig[]): void {
  store().replace({ servers })
}
