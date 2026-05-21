#!/usr/bin/env node
/**
 * VoidSoul MCP server for Unreal Engine 5.
 *
 * Pairs with `voidsoul_bridge.py` (installed inside the UE5 project's
 * Content/Python/ folder). This process is spawned by VoidSoul's MCP client,
 * speaks stdio MCP to it, and forwards every tool call to the UE5 editor over
 * a localhost TCP socket.
 *
 * Tools exposed:
 *   - ping                — health check / engine version.
 *   - run_python          — execute arbitrary Python in the editor.
 *   - get_selected_actors — labels, paths and locations of selected actors.
 *   - list_assets         — list assets at a /Game path.
 *   - level_summary       — actor count + top class histogram of the level.
 *   - save_level          — save the currently open level.
 *
 * Add to VoidSoul → Settings → MCP Servers:
 *     Name:    UE5
 *     Command: node
 *     Args:    <abs path to this file>
 */
const net = require('node:net')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js')

const HOST = process.env.VOIDSOUL_UE5_HOST || '127.0.0.1'
const PORT = Number(process.env.VOIDSOUL_UE5_PORT || 30011)

/* -------------------------------------------------------------------------
 * Tiny client for the UE5 bridge — newline-delimited JSON over TCP.
 * One request → one response.
 * ----------------------------------------------------------------------- */
function callBridge(op, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port: PORT })
    let buf = ''
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      fn(value)
    }
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new Error(
            `UE5 bridge did not respond in ${timeoutMs}ms — is the editor running and the bridge started?`
          )
        ),
      timeoutMs
    )
    sock.on('connect', () => {
      sock.write(JSON.stringify({ op, ...params }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        const line = buf.slice(0, nl)
        try {
          clearTimeout(timer)
          finish(resolve, JSON.parse(line))
        } catch (err) {
          finish(reject, err)
        }
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      // Common case: bridge not listening yet (UE5 closed or script not started).
      const message =
        err.code === 'ECONNREFUSED'
          ? `Couldn't reach the UE5 bridge at ${HOST}:${PORT}. Open your UE5 project, then run \`import voidsoul_bridge\` in the Python console (or add it to Startup Scripts).`
          : err.message
      finish(reject, new Error(message))
    })
    sock.on('end', () => {
      clearTimeout(timer)
      if (!done) finish(reject, new Error('UE5 bridge closed the connection.'))
    })
  })
}

function asText(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ok(content) {
  return { content: [{ type: 'text', text: asText(content) }] }
}

function fail(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: asText(message) }]
  }
}

/* -------------------------------------------------------------------------
 * Tool catalogue.
 * ----------------------------------------------------------------------- */
const TOOLS = [
  {
    name: 'ping',
    description:
      'Health check. Returns "pong" + the running Unreal Engine version. Use this first to confirm the bridge is live before issuing other commands.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'run_python',
    description:
      'Execute arbitrary Python inside the Unreal Editor. The `unreal` module is already imported. Capture stdout via `print(...)`. If you set a top-level variable named `result`, its repr is returned alongside stdout. Use this for anything the convenience tools below don\'t cover — spawning actors, editing properties, calling EditorAssetLibrary, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source to execute. Multi-line is fine.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'get_selected_actors',
    description:
      'Return the actors currently selected in the editor viewport (label, path, class, world location).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_assets',
    description:
      'List assets under a content path (defaults to "/Game"). Useful for locating Blueprints, materials, textures, levels. Pagination is naive — pass a smaller `path` to narrow.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Content-browser path, e.g. "/Game/Characters". Defaults to "/Game".'
        },
        recursive: { type: 'boolean', description: 'Recurse into sub-folders. Default true.' },
        limit: { type: 'number', description: 'Max items to return. Default 200.' }
      }
    }
  },
  {
    name: 'level_summary',
    description:
      'Summarise the currently-loaded level — name, actor count, and the top 20 actor classes by count. Handy first-look at "what is on this map".',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'save_level',
    description: 'Save the currently-open level. Equivalent to Ctrl+S in the editor.',
    inputSchema: { type: 'object', properties: {} }
  }
]

/* -------------------------------------------------------------------------
 * MCP server.
 * ----------------------------------------------------------------------- */
const server = new Server(
  { name: 'voidsoul-ue5', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  try {
    const result = await callBridge(name, args)
    if (!result || result.ok === false) {
      return fail(result?.error ?? 'Unknown error from UE5 bridge.')
    }
    // Strip the `ok` flag from successful payloads to keep responses clean.
    const { ok: _ok, ...payload } = result
    return ok(payload)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
})

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('voidsoul-ue5 MCP server failed to start:', err)
  process.exit(1)
})
