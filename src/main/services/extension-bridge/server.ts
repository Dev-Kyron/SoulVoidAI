/**
 * v2.0 — Browser-extension local IPC server.
 *
 * Listens on a per-OS local socket (Unix domain socket on Mac/Linux,
 * Windows named pipe). The native-messaging host script that Chrome
 * spawns connects here, forwards messages from the extension, and
 * streams replies back over the same socket. Nothing crosses the
 * machine boundary — same privacy model as the desktop app itself.
 *
 * Protocol (newline-delimited JSON on the socket, one envelope per line):
 *
 *   client → server:
 *     { type: 'ping', id }
 *     { type: 'version' }
 *     { type: 'chat', id, prompt, selection?, pageTitle?, pageUrl? }
 *     { type: 'abort', id }
 *
 *   server → client:
 *     { type: 'pong', id, version }
 *     { type: 'chat-chunk', id, delta }
 *     { type: 'chat-done', id, error? }
 *
 * One TCP-style connection per native host (Chrome spawns one host per
 * port, and the popup typically opens one port). Multiple concurrent
 * chats on the same connection are tagged by `id` so the server can
 * route abort messages to the right AbortController.
 *
 * Lifecycle: started lazily when config flips `browserExtension.enabled`
 * to true, stopped on app quit + when the user disables it. Stale socket
 * files (left behind by an unclean exit) are cleared before re-binding.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { join } from 'node:path'
import { log } from '../logger'
import { runCompletion } from '../ai'
import { getConfig } from '../storage/config'
import { hasApiKey } from '../storage/keys'
import { broadcast } from '../../events'
import type { BrowserExtensionStatus, ChatRequest, ChatTurn, ProviderId } from '@shared/types'

/* ----------------------------- protocol types ----------------------------- */

interface ChatClientMessage {
  type: 'chat'
  id: string
  prompt: string
  selection?: string
  pageTitle?: string
  pageUrl?: string
}

interface PingClientMessage {
  type: 'ping'
  id: string
}

interface VersionClientMessage {
  type: 'version'
}

interface AbortClientMessage {
  type: 'abort'
  id: string
}

type ClientMessage =
  | ChatClientMessage
  | PingClientMessage
  | VersionClientMessage
  | AbortClientMessage

interface PongServerMessage {
  type: 'pong'
  id: string
  version: string
}

interface ChatChunkServerMessage {
  type: 'chat-chunk'
  id: string
  delta: string
}

interface ChatDoneServerMessage {
  type: 'chat-done'
  id: string
  error?: string
}

type ServerMessage = PongServerMessage | ChatChunkServerMessage | ChatDoneServerMessage

/* -------------------------------- paths --------------------------------- */

/**
 * Per-OS local-socket path. macOS sockets must be < 104 bytes total path,
 * which is why we put the socket in the user-data dir's root rather than
 * a nested subdir — the userData path on macOS is already long enough.
 *
 * Windows named pipes live in the `\\.\pipe\` namespace; the suffix is
 * unique per-user so two accounts running VoidSoul on the same machine
 * don't collide.
 */
export function socketPath(): string {
  if (process.platform === 'win32') {
    // Hash the userData path so the pipe name stays short + collision-free
    // for the rare case of multiple installs on one Windows account.
    const data = app.getPath('userData')
    let hash = 0
    for (let i = 0; i < data.length; i++) hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0
    return `\\\\.\\pipe\\voidsoul-ext-${(hash >>> 0).toString(36)}`
  }
  return join(app.getPath('userData'), 'voidsoul-extension.sock')
}

/* -------------------------------- state --------------------------------- */

interface Connection {
  socket: Socket
  buffer: string
  abortControllers: Map<string, AbortController>
}

/**
 * v2.0 polish — per-connection NDJSON buffer cap. The receive loop
 * accumulates bytes until a newline arrives; a misbehaving (or hostile)
 * client could stream forever without a `\n` and grow the buffer until
 * the process OOMs. 1 MB is two orders of magnitude above any legitimate
 * payload (chat prompts cap around 64 KB even with a full page
 * selection), so a buffer this large is unambiguous misuse — drop the
 * connection rather than try to recover.
 */
const MAX_NDJSON_BUFFER_BYTES = 1_048_576

let server: Server | null = null
const connections = new Set<Connection>()

export function isListening(): boolean {
  return server !== null && server.listening
}

export function connectedClientCount(): number {
  return connections.size
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Start the local IPC server. Idempotent — calling twice is a no-op. On
 * Unix we attempt to unlink a stale socket file first; an EADDRINUSE
 * after the unlink almost always means another VoidSoul instance is
 * running, which the single-instance lock in main/index.ts should have
 * caught earlier, so we log + bail.
 */
export async function startExtensionBridge(): Promise<void> {
  if (server) return
  const path = socketPath()

  if (process.platform !== 'win32' && existsSync(path)) {
    try {
      await rm(path, { force: true })
    } catch (err) {
      log(
        'warn',
        'extension',
        `Couldn't clear stale extension socket at ${path}; falling through`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  const next = createServer((socket) => handleConnection(socket))
  next.on('error', (err) => {
    log('error', 'extension', `Extension bridge server error: ${err.message}`)
  })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(path, () => {
      next.off('error', reject)
      resolve()
    })
  })

  // chmod 600 on Unix so other local users can't hijack the socket. Windows
  // named pipes default to the current user's ACL — equivalent semantics.
  if (process.platform !== 'win32') {
    try {
      // Node's fs.chmod through Electron — minimal import path.
      const { chmod } = await import('node:fs/promises')
      await chmod(path, 0o600)
    } catch {
      /* best-effort; chmod failure isn't fatal */
    }
  }

  server = next
  log('info', 'extension', `Extension bridge listening on ${path}`)
  broadcastStatus()
}

/**
 * Stop the server + close every open connection. Called when the user
 * toggles the master switch off, and on app quit.
 */
export async function stopExtensionBridge(): Promise<void> {
  if (!server) return
  const current = server
  server = null

  // Abort every in-flight chat so we don't leak listeners on
  // runCompletion's signal.
  for (const conn of connections) {
    for (const ctrl of conn.abortControllers.values()) {
      try {
        ctrl.abort()
      } catch {
        /* ignore */
      }
    }
    conn.abortControllers.clear()
    conn.socket.destroy()
  }
  connections.clear()

  await new Promise<void>((resolve) => current.close(() => resolve()))
  log('info', 'extension', 'Extension bridge stopped.')
  broadcastStatus()
}

export function extensionBridgeStatus(): BrowserExtensionStatus {
  const cfg = getConfig()
  return {
    enabled: cfg.browserExtension?.enabled ?? false,
    listening: isListening(),
    connectedClients: connectedClientCount(),
    socketPath: socketPath(),
    // v2.0 round-8 — `hostManifestPath` stays as Chrome for back-compat
    // with the existing renderer. `browserHostManifestPaths` is the new
    // shape the Settings panel reads for the per-browser picker.
    hostManifestPath: hostManifestPath('chrome'),
    browserHostManifestPaths: allBrowserHostManifestPaths(),
    bridgeScriptPath: bridgeScriptPath()
  }
}

/**
 * Per-OS Chrome native-messaging host manifest path. The manifest tells
 * Chrome where to find the bridge script + which extension ids may talk
 * to it. We surface the path in the Settings panel so the user can
 * either copy our generated manifest there manually OR (via the install
 * helper) write it there for them.
 *
 * On Mac/Linux the manifest is a JSON file at a well-known per-user
 * path; on Windows it's a registry key pointing at the JSON file.
 *
 * v2.0 round-8 — `browser` parameter added so the Settings panel can
 * surface paths for all four supported browsers (Chrome, Edge, Brave,
 * Arc). install.mjs already writes to all of them when present; the
 * in-app diagnostic used to mis-report by always returning Chrome.
 * Defaults to `'chrome'` for back-compat.
 */
export type BrowserId = 'chrome' | 'edge' | 'brave' | 'arc'

interface BrowserPathSpec {
  darwin: string
  linux: string
  windowsRegistry: string
}

/** Per-browser per-platform native-messaging host paths. Mac uses the
 *  browser's per-user Application Support dir; Linux uses ~/.config
 *  with the browser's package name; Windows uses an HKCU registry path
 *  rooted under the browser vendor's key. */
const BROWSER_PATHS: Record<BrowserId, BrowserPathSpec> = {
  chrome: {
    darwin:
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.kyron.voidsoul.json',
    linux: '.config/google-chrome/NativeMessagingHosts/dev.kyron.voidsoul.json',
    windowsRegistry: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.kyron.voidsoul'
  },
  edge: {
    darwin:
      'Library/Application Support/Microsoft Edge/NativeMessagingHosts/dev.kyron.voidsoul.json',
    linux: '.config/microsoft-edge/NativeMessagingHosts/dev.kyron.voidsoul.json',
    windowsRegistry: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\dev.kyron.voidsoul'
  },
  brave: {
    darwin:
      'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.kyron.voidsoul.json',
    linux: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.kyron.voidsoul.json',
    windowsRegistry:
      'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\dev.kyron.voidsoul'
  },
  arc: {
    darwin:
      'Library/Application Support/Arc/User Data/NativeMessagingHosts/dev.kyron.voidsoul.json',
    linux: '.config/arc/NativeMessagingHosts/dev.kyron.voidsoul.json',
    // Arc has no Windows release yet (as of 2026-05) — surface the
    // Chrome key as a best-guess fallback for forward-compat.
    windowsRegistry: 'HKCU\\Software\\Arc\\NativeMessagingHosts\\dev.kyron.voidsoul'
  }
}

export function hostManifestPath(browser: BrowserId = 'chrome'): string {
  const home = app.getPath('home')
  const spec = BROWSER_PATHS[browser] ?? BROWSER_PATHS.chrome
  if (process.platform === 'darwin') return join(home, spec.darwin)
  if (process.platform === 'linux') return join(home, spec.linux)
  return spec.windowsRegistry
}

/** Returns a map of every supported browser → its host-manifest path on
 *  the current platform. The Settings panel uses this to render a
 *  per-browser row so the user can pick the matching path to copy. */
export function allBrowserHostManifestPaths(): Record<BrowserId, string> {
  return {
    chrome: hostManifestPath('chrome'),
    edge: hostManifestPath('edge'),
    brave: hostManifestPath('brave'),
    arc: hostManifestPath('arc')
  }
}

/** Absolute path to the bridge.cjs script the host manifest must reference.
 *  In dev this points into `tools/browser-extension/native-host/`; in
 *  production it points into the asar-unpacked resources dir. */
export function bridgeScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'browser-extension/native-host/bridge.cjs')
  }
  return join(app.getAppPath(), 'tools/browser-extension/native-host/bridge.cjs')
}

/* ------------------------- connection handling -------------------------- */

function handleConnection(socket: Socket): void {
  const conn: Connection = {
    socket,
    buffer: '',
    abortControllers: new Map()
  }
  connections.add(conn)
  broadcastStatus()

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string | Buffer) => {
    conn.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // v2.0 polish — bound the buffer. A client that never sends a `\n`
    // (misbehaving or hostile) would otherwise grow this string forever
    // until the process OOMs. Past the cap, drop the connection — we
    // can't recover a partial message anyway, and a legitimate client
    // never gets close to this size.
    if (conn.buffer.length > MAX_NDJSON_BUFFER_BYTES) {
      log(
        'warn',
        'extension',
        `Native host exceeded ${MAX_NDJSON_BUFFER_BYTES}-byte NDJSON buffer without newline; dropping connection.`
      )
      conn.buffer = ''
      socket.destroy()
      return
    }
    // Newline-delimited JSON — handle multiple messages per data event.
    let idx: number
    while ((idx = conn.buffer.indexOf('\n')) !== -1) {
      const line = conn.buffer.slice(0, idx).trim()
      conn.buffer = conn.buffer.slice(idx + 1)
      if (!line) continue
      let msg: ClientMessage
      try {
        msg = JSON.parse(line) as ClientMessage
      } catch (err) {
        log(
          'warn',
          'extension',
          `Invalid NDJSON from native host`,
          err instanceof Error ? err.message : String(err)
        )
        continue
      }
      void dispatch(conn, msg)
    }
  })
  socket.on('close', () => {
    for (const ctrl of conn.abortControllers.values()) {
      try {
        ctrl.abort()
      } catch {
        /* ignore */
      }
    }
    conn.abortControllers.clear()
    connections.delete(conn)
    broadcastStatus()
  })
  socket.on('error', (err) => {
    // Connection-reset / pipe-broken errors are normal when Chrome
    // disconnects; log at warn level so we have a trail without
    // flooding the user-facing log.
    log('warn', 'extension', `Native host socket error: ${err.message}`)
  })
}

async function dispatch(conn: Connection, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'ping':
      sendTo(conn, { type: 'pong', id: msg.id, version: app.getVersion() })
      return
    case 'version':
      sendTo(conn, { type: 'pong', id: 'version', version: app.getVersion() })
      return
    case 'abort': {
      const ctrl = conn.abortControllers.get(msg.id)
      if (ctrl) {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
        conn.abortControllers.delete(msg.id)
      }
      return
    }
    case 'chat':
      await handleChat(conn, msg)
      return
  }
}

/* ----------------------------- chat handler ----------------------------- */

/**
 * Resolves a workable provider for an extension chat. Preference order:
 *   1. The active provider in config IF it has a key (or is a local
 *      provider that doesn't need one).
 *   2. The first configured provider that has a key.
 *   3. The active provider as-is (caller will receive a "no key
 *      configured" error from the AI gateway, which is the same
 *      message the desktop app surfaces — consistent UX).
 *
 * Kept narrow on purpose: extension chats are one-shot Quick-AI style,
 * not threaded conversations, so we deliberately don't apply the same
 * auto-router as the chat-store path. The user can still pick a
 * different provider in the extension popup (v1.1).
 */
function pickExtensionProvider(): { provider: ProviderId; model: string } {
  const cfg = getConfig()
  // `cfg.providers` is a per-id record in the persisted shape (not the
  // ProviderRuntime[] the renderer sees); look up by key, iterate by
  // Object.entries when we need to scan.
  const activeId = cfg.activeProvider
  const active = cfg.providers[activeId]
  if (active && (hasApiKey(activeId) || activeId === 'ollama' || activeId === 'lmstudio')) {
    return { provider: activeId, model: active.model }
  }
  for (const [id, settings] of Object.entries(cfg.providers) as Array<
    [ProviderId, { model: string }]
  >) {
    if (hasApiKey(id)) return { provider: id, model: settings.model }
  }
  // Fall through — let the AI gateway emit its own "configure a provider"
  // error so the extension doesn't have to know the message wording.
  return {
    provider: activeId,
    model: active?.model ?? ''
  }
}

/**
 * Build the system prompt + first turn from the page context. The selection
 * (if any) is fenced so the model can quote / refer to it. Page title + URL
 * are added as compact metadata — useful for "summarise this page" prompts
 * even when the user didn't highlight anything.
 */
function buildTurns(msg: ChatClientMessage): { system: string; messages: ChatTurn[] } {
  const cfg = getConfig()
  // Honour the global system prompt so the extension reply sounds like
  // the same assistant the desktop app does. Trim trailing whitespace
  // so we can append context cleanly.
  const base = (cfg.systemPrompt ?? '').trim()
  const contextLines: string[] = []
  if (msg.pageTitle) contextLines.push(`Page title: ${msg.pageTitle}`)
  if (msg.pageUrl) contextLines.push(`Page URL: ${msg.pageUrl}`)
  if (msg.selection?.trim()) {
    contextLines.push('Selected text from the page:')
    contextLines.push('```')
    contextLines.push(msg.selection.trim())
    contextLines.push('```')
  }
  const context = contextLines.join('\n')
  const userContent = context ? `${context}\n\n${msg.prompt}` : msg.prompt
  return {
    system: base,
    messages: [{ role: 'user', content: userContent }]
  }
}

async function handleChat(conn: Connection, msg: ChatClientMessage): Promise<void> {
  const { provider, model } = pickExtensionProvider()
  const { system, messages } = buildTurns(msg)
  const req: ChatRequest = {
    requestId: msg.id || randomUUID(),
    provider,
    model,
    system,
    messages
  }

  const controller = new AbortController()
  conn.abortControllers.set(req.requestId, controller)

  try {
    const result = await runCompletion(
      req,
      (delta) => {
        sendTo(conn, { type: 'chat-chunk', id: req.requestId, delta })
      },
      controller.signal
    )
    sendTo(conn, {
      type: 'chat-done',
      id: req.requestId,
      error: result.error
    })
  } catch (err) {
    sendTo(conn, {
      type: 'chat-done',
      id: req.requestId,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    conn.abortControllers.delete(req.requestId)
  }
}

/* ------------------------------- helpers -------------------------------- */

function sendTo(conn: Connection, message: ServerMessage): void {
  if (conn.socket.destroyed) return
  try {
    conn.socket.write(JSON.stringify(message) + '\n')
  } catch (err) {
    log(
      'warn',
      'extension',
      `Couldn't write to native host socket`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * Broadcast the current status to the renderer so the Settings panel's
 * chip stays live (listening / N connected clients) without polling.
 *
 * v2.0 polish — trailing-debounce so a flapping native host (rapid
 * connect/disconnect during MV3 service-worker reaps, or a buggy
 * client) doesn't fire a burst of IPC frames + renderer re-renders.
 * 100 ms is short enough that the user perceives the chip as live and
 * long enough that any flap collapses to one settled state per
 * settling-window. The pending state is always rebuilt at fire time so
 * we publish the LATEST snapshot, not a stale one captured at the
 * leading edge.
 */
let statusDebounceTimer: NodeJS.Timeout | null = null

function broadcastStatus(): void {
  if (statusDebounceTimer) return
  statusDebounceTimer = setTimeout(() => {
    statusDebounceTimer = null
    broadcast('extension:status', extensionBridgeStatus())
  }, 100)
  statusDebounceTimer.unref?.()
}
