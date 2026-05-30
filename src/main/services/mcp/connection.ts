/**
 * One MCP server connection. Wraps the SDK Client + StdioClientTransport so
 * the manager can treat each server as a simple { connect, disconnect,
 * callTool } object — and surface tools / errors to the UI uniformly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { log } from '../logger'
import type { McpServerConfig, McpToolInfo } from '@shared/types'

const APP_INFO = { name: 'voidsoul', version: '1.0.0' }

/** Environment keys forwarded to MCP child processes. */
const FORWARDED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  // Windows essentials — without these many Node servers (and OpenSSL-backed
  // packages) fail to start.
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  // POSIX shells.
  'SHELL',
  'LANG',
  'LC_ALL'
]

/** Cap on how long a single connect+handshake gets before we bail out.
 *  v1.12.0 — bumped 20s → 60s. Several legitimate MCP servers (Cloudflare's
 *  `init` flow, mcp-remote with OAuth, anything that opens a browser tab
 *  for first-run auth) need a human in the loop. 20s killed the process
 *  before the user could finish the login. 60s gives a realistic budget
 *  for a quick OAuth dance while still failing fast on genuinely broken
 *  servers (the previous "feels broken" threshold was ~30s of staring,
 *  so users notice and click reconnect well before the new cap fires). */
const CONNECT_TIMEOUT_MS = 60_000

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(id)
        resolve(value)
      },
      (err) => {
        clearTimeout(id)
        reject(err)
      }
    )
  })
}

/** Sanitises a server name for use inside a tool name (~16 lowercase chars). */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16)
  return slug || 'srv'
}

/** Pulls `{type:'text', text:'…'}` blocks out of a CallToolResult into plain text. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const part = c as { type?: string; text?: string }
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      return `[${part.type ?? 'item'}]`
    })
    .join('\n')
}

export class McpConnection {
  private client: Client | null = null
  tools: McpToolInfo[] = []
  error: string | null = null
  connected = false

  constructor(public readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.connected) return
    this.error = null
    // Build the env once so both the success and the failure path can reason
    // about it (helpful in logs when the server can't find a tool on PATH).
    const env: Record<string, string> = {}
    for (const key of FORWARDED_ENV_KEYS) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    for (const [k, v] of Object.entries(this.config.env)) {
      if (typeof v === 'string') env[k] = v
    }

    let transport: StdioClientTransport | null = null
    let client: Client | null = null
    try {
      transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env,
        stderr: 'pipe'
      })
      // Surface the server's stderr to the activity log so a misbehaving MCP
      // process doesn't fail silently — and so the OS pipe buffer can't fill
      // (small on Windows) and block the child on stderr writes.
      transport.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim()
        if (text) {
          log('warn', 'mcp', `[${this.config.name}] ${text.slice(0, 400)}`)
        }
      })
      // When the child process exits (crash, OOM kill, SIGPIPE), flip our
      // connected flag so subsequent callTool calls fail fast instead of
      // hanging on a dead pipe. The manager's reconnect flow can then
      // bring it back up. Without this, a zombie McpConnection kept
      // accepting calls that never returned.
      transport.onclose = (): void => {
        if (this.connected) {
          this.connected = false
          this.tools = []
          this.error = 'MCP server process exited'
          log('warn', 'mcp', `MCP server "${this.config.name}" exited unexpectedly`)
        }
      }
      client = new Client(APP_INFO, { capabilities: {} })
      // v1.12.4 — share a single deadline across connect + listTools.
      // Previously each step got its own CONNECT_TIMEOUT_MS budget, so
      // a slow server could legitimately hang for 2× the documented cap
      // (60s + 60s = 120s worst case) before we surfaced the failure.
      // Now: if connect ate most of the budget, listTools fails fast
      // with the remainder, and the user sees one honest "60s" timeout
      // instead of "60s? 120s? who knows" surprise.
      const deadline = Date.now() + CONNECT_TIMEOUT_MS
      await withTimeout(
        client.connect(transport),
        Math.max(1, deadline - Date.now()),
        `MCP "${this.config.name}" connect`
      )
      this.client = client

      const listResult = await withTimeout(
        client.listTools(),
        Math.max(1, deadline - Date.now()),
        `MCP "${this.config.name}" listTools`
      )
      const prefix = slugify(this.config.name)
      this.tools = (listResult.tools ?? []).map((t) => ({
        name: `mcp_${prefix}_${t.name}`.slice(0, 64),
        originalName: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
          required: []
        },
        serverId: this.config.id,
        serverName: this.config.name
      }))
      this.connected = true
      log(
        'success',
        'mcp',
        `MCP server "${this.config.name}" connected · ${this.tools.length} tool${
          this.tools.length === 1 ? '' : 's'
        }`
      )
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      this.tools = []
      this.connected = false
      log('warn', 'mcp', `MCP server "${this.config.name}" failed to start`, this.error)
      // Reclaim the child process so a failed handshake doesn't leak it.
      if (client) {
        try {
          await client.close()
        } catch {
          /* best-effort */
        }
      } else if (transport) {
        try {
          await transport.close()
        } catch {
          /* best-effort */
        }
      }
      this.client = null
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close()
    } catch (err) {
      log(
        'warn',
        'mcp',
        `MCP server "${this.config.name}" close failed`,
        err instanceof Error ? err.message : String(err)
      )
    }
    this.client = null
    this.tools = []
    this.connected = false
    this.error = null
  }

  async callTool(
    originalName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; text: string }> {
    if (!this.client || !this.connected) {
      return { ok: false, text: 'MCP server is not connected.' }
    }
    try {
      // v2.0 round-4 security polish — wrap in withTimeout. Without this, a
      // malicious or stuck MCP server that never responds to tools/call
      // hangs the agent step indefinitely (the SDK's promise has no ceiling,
      // and the outer dispatch's AbortSignal doesn't reach inside the
      // transport's in-flight request). 90s is the same ceiling we use for
      // connect / listTools — generous for legitimate long-running tools
      // but short enough that a broken server doesn't freeze the chat.
      const result = await withTimeout(
        this.client.callTool({ name: originalName, arguments: args }),
        90_000,
        `MCP tool "${originalName}" on "${this.config.name}"`
      )
      const text = flattenContent(result.content) || '(empty)'
      const ok = !result.isError
      if (!ok) {
        // Audit log every server-side tool failure — MCP is one of the most
        // privileged paths the agent has, "tool reported error" should never
        // be silent.
        log(
          'warn',
          'mcp',
          `Tool "${originalName}" on "${this.config.name}" reported error`,
          text.slice(0, 400)
        )
      }
      return { ok, text }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      log('warn', 'mcp', `Tool "${originalName}" on "${this.config.name}" threw`, text)
      return { ok: false, text }
    }
  }
}
