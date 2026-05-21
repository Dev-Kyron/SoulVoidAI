#!/usr/bin/env node
/**
 * VoidSoul MCP server for Discord — server-bootstrapping toolkit.
 *
 * Spawned by VoidSoul Assistant's MCP client, speaks stdio MCP to the
 * assistant, and translates each tool call into a Discord REST API call
 * authenticated with a bot token. Designed for one-shot server setup
 * (creating categories, channels, roles, posting welcome messages),
 * not for runtime chat operations.
 *
 * Tools exposed:
 *   - discord_get_server_info   server name + counts (health probe).
 *   - discord_list_channels     all channels with id, name, parent.
 *   - discord_list_roles        all roles with id, name, color, position.
 *   - discord_create_category   make a channel category.
 *   - discord_create_text_channel  make a text channel (optionally under a category).
 *   - discord_create_role       make a role with name + hex color.
 *   - discord_send_message      post to a channel (returns message id).
 *   - discord_pin_message       pin a message in a channel.
 *
 * Environment:
 *   DISCORD_BOT_TOKEN  required — the bot token from discord.com/developers.
 *   DISCORD_GUILD_ID   required — the server (guild) id the bot operates on.
 *
 * Add to VoidSoul → Settings → MCP Servers:
 *     Name:    Discord
 *     Command: node
 *     Args:    <abs path to this file>
 *     Env:     DISCORD_BOT_TOKEN=<token>, DISCORD_GUILD_ID=<id>
 *
 * The bot must be invited to the guild with the Administrator permission
 * (or at minimum: Manage Channels + Manage Roles + Send Messages +
 * Manage Messages for pinning).
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js')

const API = 'https://discord.com/api/v10'

/**
 * Config sources, in order of precedence:
 *   1. CLI args  (--token X --guild Y)  — used when the host's MCP form
 *      doesn't have an env field (VoidSoul's current shape).
 *   2. Env vars  (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID) — preferred when
 *      the host supports it (anything that follows the MCP env: {} spec).
 */
function parseArgs() {
  const out = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--token' && argv[i + 1]) {
      out.token = argv[++i]
    } else if (a === '--guild' && argv[i + 1]) {
      out.guild = argv[++i]
    }
  }
  return out
}

const cliArgs = parseArgs()
const TOKEN = cliArgs.token || process.env.DISCORD_BOT_TOKEN
const GUILD = cliArgs.guild || process.env.DISCORD_GUILD_ID

if (!TOKEN || !GUILD) {
  console.error(
    '[discord-mcp] Bot token + guild id required.\n' +
      '  Args form:  --token <BOT_TOKEN> --guild <GUILD_ID>\n' +
      '  Env form:   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID\n' +
      'See tools/discord-mcp/README.md.'
  )
  process.exit(1)
}

/* -------------------------------------------------------------------------
 * Tiny REST helper. Honours Discord's rate-limit headers by sleeping on 429s
 * — a bootstrap session usually does dozens of writes in a row and the per-
 * route bucket fills quickly. Fail-loud on any other 4xx/5xx so the agent
 * sees a real error.
 * ----------------------------------------------------------------------- */
async function api(method, path, body) {
  const url = `${API}${path}`
  const init = {
    method,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'Content-Type': 'application/json',
      // Required by Discord to identify the client; doesn't have to be unique.
      'User-Agent': 'VoidSoul-Discord-MCP (https://voidsoulstudio.com, 0.1.0)'
    },
    body: body ? JSON.stringify(body) : undefined
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, init)
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1')
      await new Promise((r) => setTimeout(r, Math.min(retry * 1000, 5000)))
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`)
    }
    return text ? JSON.parse(text) : null
  }
  throw new Error(`Discord ${method} ${path} → rate-limited 4× in a row, giving up`)
}

/* -------------------------------------------------------------------------
 * Helpers: shape the verbose Discord payloads into compact summaries the
 * agent can reason about without burning context on irrelevant fields.
 * ----------------------------------------------------------------------- */
function summariseChannel(c) {
  return {
    id: c.id,
    name: c.name,
    // Channel types we care about — 0=text, 2=voice, 4=category, 5=announcement,
    // 13=stage, 15=forum. Anything else is rare for a small server.
    type: c.type,
    parent_id: c.parent_id ?? null,
    position: c.position,
    topic: c.topic ?? undefined
  }
}

function summariseRole(r) {
  return {
    id: r.id,
    name: r.name,
    // Discord stores colors as decimal; surface as hex for human-readability.
    color: '#' + Number(r.color || 0).toString(16).padStart(6, '0'),
    hoist: r.hoist,
    position: r.position,
    permissions: r.permissions
  }
}

function hexToColorInt(hex) {
  if (!hex) return undefined
  const clean = hex.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return undefined
  return parseInt(clean, 16)
}

/* -------------------------------------------------------------------------
 * MCP server boilerplate. Every tool gets its own JSON-Schema input
 * declaration so the agent sees the parameter shape upfront.
 * ----------------------------------------------------------------------- */
const server = new Server(
  { name: 'voidsoul-discord-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

const TOOLS = [
  {
    name: 'discord_get_server_info',
    description:
      'Probe the configured Discord server. Returns name, member count, channel count, role count. Use first to confirm the bot has access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'discord_list_channels',
    description:
      'List every channel in the server with id, name, type, parent category, and position. Call before creating to avoid duplicates.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'discord_list_roles',
    description:
      'List every role in the server with id, name, color (hex), and position.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'discord_create_category',
    description:
      'Create a channel category (group header). Returns the new category id, which you pass as parent_id when creating its child channels.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Category name shown in the sidebar.' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'discord_create_text_channel',
    description:
      'Create a text channel. Optionally place under a category. Returns the new channel id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Channel slug (lowercase, hyphens, no spaces — Discord normalises this).'
        },
        parent_id: {
          type: 'string',
          description: 'Category id (from discord_create_category). Omit for top-level.'
        },
        topic: {
          type: 'string',
          description: 'Optional channel topic (the small description shown in the header).'
        }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'discord_create_role',
    description:
      'Create a role with a name + optional hex color (e.g. "#7c3aed"). Use hoist=true to display members with this role separately in the sidebar.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: {
          type: 'string',
          description: '6-digit hex like #7c3aed. Omit for the default grey.'
        },
        hoist: {
          type: 'boolean',
          description: 'Display members with this role separately in the sidebar. Default false.'
        }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'discord_send_message',
    description:
      'Post a plain-text or markdown message to a channel. Returns the new message id (use it with discord_pin_message).',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        content: {
          type: 'string',
          description: 'Message body. Discord markdown supported (bold, headings, lists, etc.).'
        }
      },
      required: ['channel_id', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'discord_pin_message',
    description: 'Pin an existing message in a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        message_id: { type: 'string' }
      },
      required: ['channel_id', 'message_id'],
      additionalProperties: false
    }
  }
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params

  // Wrap each handler in a uniform try/catch so a thrown error becomes a
  // structured tool error the agent can read, rather than crashing the
  // MCP transport.
  try {
    const result = await dispatch(name, args)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text', text: `discord-mcp error: ${msg}` }]
    }
  }
})

async function dispatch(name, args) {
  switch (name) {
    case 'discord_get_server_info': {
      const guild = await api('GET', `/guilds/${GUILD}?with_counts=true`)
      const channels = await api('GET', `/guilds/${GUILD}/channels`)
      const roles = await api('GET', `/guilds/${GUILD}/roles`)
      return {
        name: guild.name,
        id: guild.id,
        approximate_member_count: guild.approximate_member_count,
        channel_count: channels.length,
        role_count: roles.length,
        description: guild.description ?? null
      }
    }

    case 'discord_list_channels': {
      const channels = await api('GET', `/guilds/${GUILD}/channels`)
      // Sort by category then position so the agent sees a logical order.
      channels.sort((a, b) => (a.parent_id ?? '').localeCompare(b.parent_id ?? '') || a.position - b.position)
      return channels.map(summariseChannel)
    }

    case 'discord_list_roles': {
      const roles = await api('GET', `/guilds/${GUILD}/roles`)
      roles.sort((a, b) => b.position - a.position)
      return roles.map(summariseRole)
    }

    case 'discord_create_category': {
      const created = await api('POST', `/guilds/${GUILD}/channels`, {
        name: args.name,
        type: 4
      })
      return { id: created.id, name: created.name }
    }

    case 'discord_create_text_channel': {
      const created = await api('POST', `/guilds/${GUILD}/channels`, {
        name: args.name,
        type: 0,
        parent_id: args.parent_id || undefined,
        topic: args.topic || undefined
      })
      return { id: created.id, name: created.name, parent_id: created.parent_id ?? null }
    }

    case 'discord_create_role': {
      const created = await api('POST', `/guilds/${GUILD}/roles`, {
        name: args.name,
        color: hexToColorInt(args.color),
        hoist: Boolean(args.hoist)
      })
      return summariseRole(created)
    }

    case 'discord_send_message': {
      const created = await api('POST', `/channels/${args.channel_id}/messages`, {
        content: args.content
      })
      return { id: created.id, channel_id: created.channel_id }
    }

    case 'discord_pin_message': {
      await api('PUT', `/channels/${args.channel_id}/pins/${args.message_id}`)
      return { ok: true }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  console.error('[discord-mcp] failed to start:', err)
  process.exit(1)
})
