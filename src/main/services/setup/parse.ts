/**
 * Pure parsers for third-party AI tool config files.
 *
 * Split out from `detect.ts` so they can be unit-tested with fixture JSON
 * without touching the filesystem, env, or IPC — they take a parsed object
 * in, return validated rows out. Keeping the parsers pure also means any
 * future tool that ships with a `claude_desktop_config.json`-style schema
 * (Zed, Continue.dev, etc.) can be added with one new parser function and
 * a one-line call site in detect.ts.
 *
 * Validation philosophy: drop bad rows silently, never throw. A malformed
 * server entry in someone's Claude Desktop config shouldn't blow up the
 * whole import — we just skip that row and let the rest through.
 */
import type { DetectedMcpServer, ProviderId } from '@shared/types'

/**
 * Shape of an MCP server entry in `claude_desktop_config.json` /
 * `~/.cursor/mcp.json`. Both tools use the same convention:
 *
 *   { "mcpServers": { "<name>": { "command": "npx", "args": [...], "env": {...} } } }
 *
 * `args` and `env` are optional — Claude Desktop accepts entries with
 * just `command` (e.g., a launcher script that hard-codes its own args).
 */
interface RawMcpServer {
  command?: unknown
  args?: unknown
  env?: unknown
}

interface RawMcpRoot {
  mcpServers?: Record<string, RawMcpServer>
}

// Identifier-style names only — letters, digits, hyphen, underscore, dot.
// Deliberately excludes `/`, `:`, spaces, and path-traversal sequences so a
// rogue Claude Desktop config can't smuggle a name like '../../etc/passwd'
// or 'rm -rf /' through to the McpServer add-flow as a friendly label.
// Real configs in the wild use simple slugs ('filesystem', 'github',
// 'my-tool') — no realistic legitimate name fails this.
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * Parse the `mcpServers` block of a Claude Desktop / Cursor JSON config.
 * Pure — caller is responsible for reading the file and JSON.parse-ing it.
 *
 *  - Rejects entries whose name has shell-suspect characters (we use the
 *    name as the imported server's friendly label; a wonky name doesn't
 *    break anything but reads ugly in the picker).
 *  - Rejects entries with no `command` string.
 *  - Coerces `args` to a string[]; missing or non-array → empty.
 *  - Coerces `env` to a Record<string, string>; missing or non-object → {}.
 *  - Captures `missingEnv`: env keys present in the source but with an
 *    empty value, so the import dialog can warn "you'll need to paste a
 *    GITHUB_PERSONAL_ACCESS_TOKEN before this server will run".
 *
 * Returns the list in iteration order of the source object so the import
 * UI can render entries in a stable order matching the user's config file.
 */
export function parseMcpServersBlock(
  raw: unknown,
  source: DetectedMcpServer['source']
): DetectedMcpServer[] {
  if (!raw || typeof raw !== 'object') return []
  const root = raw as RawMcpRoot
  const servers = root.mcpServers
  if (!servers || typeof servers !== 'object') return []

  const out: DetectedMcpServer[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (!NAME_RE.test(name)) continue
    if (!value || typeof value !== 'object') continue
    const entry = value as RawMcpServer
    if (!isString(entry.command) || !entry.command.trim()) continue

    const args: string[] = Array.isArray(entry.args)
      ? entry.args.filter(isString)
      : []

    // env block — keep only string→string pairs. Track which ones are
    // empty so the import UI can flag them as needing user input.
    const env: Record<string, string> = {}
    const missingEnv: string[] = []
    if (entry.env && typeof entry.env === 'object') {
      for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
        if (!isString(v)) continue
        env[k] = v
        if (v.trim() === '') missingEnv.push(k)
      }
    }

    out.push({ name, command: entry.command, args, env, source, missingEnv })
  }
  return out
}

/* ------------------------------ env keys ------------------------------ */

/**
 * Map of env-var name → provider id we'd import the key into. Local
 * providers (Ollama, llama.cpp etc.) don't appear here — they don't
 * authenticate by API key. `custom` is intentionally omitted too —
 * there's no canonical env-var convention for it.
 *
 * For providers with multiple aliases (Google uses both GOOGLE_API_KEY
 * and GEMINI_API_KEY in the wild), each alias is its own row. The
 * import dialog dedups by provider so we don't import the same key
 * twice into the same slot.
 */
export const ENV_KEY_PROVIDERS: Record<string, ProviderId> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'gemini',
  GEMINI_API_KEY: 'gemini',
  GOOGLE_GENAI_API_KEY: 'gemini',
  GROQ_API_KEY: 'groq',
  XAI_API_KEY: 'xai',
  OPENROUTER_API_KEY: 'openrouter',
  DEEPSEEK_API_KEY: 'deepseek',
  MISTRAL_API_KEY: 'mistral'
}

/**
 * Build a redacted preview of an API key — first 8 chars + ellipsis + last
 * 4. Lets the user recognise their own key ("yep, that's the Anthropic
 * one I created last month") without us shipping the full secret across
 * the IPC boundary into the renderer.
 *
 * For very short strings (under 14 chars, which would mean the prefix and
 * tail overlap), we just emit ellipsis to avoid accidentally revealing
 * the whole key.
 */
export function keyPreview(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length < 14) return '••••••'
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`
}
