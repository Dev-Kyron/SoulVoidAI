#!/usr/bin/env node
/* eslint-disable */
/**
 * VoidSoul native-messaging host bridge.
 *
 * Chrome (and Edge / Arc / any Chromium browser using the Chrome
 * native-messaging API) spawns this script when the extension calls
 * `chrome.runtime.connectNative('dev.kyron.voidsoul')`. Chrome talks to
 * the script over stdin/stdout using a length-prefixed JSON protocol:
 *
 *   stdin:  [4-byte little-endian uint32 length] [UTF-8 JSON payload]
 *   stdout: [4-byte little-endian uint32 length] [UTF-8 JSON payload]
 *
 * Our job is to bridge that to the running VoidSoul desktop app, which
 * listens on a per-OS local socket (Unix domain socket on Mac/Linux,
 * Windows named pipe). Each line of newline-delimited JSON on the socket
 * is one message; we translate freely between framings.
 *
 * Failure modes we surface back to the extension as `chat-done` errors:
 *
 *   - "VoidSoul desktop app isn't running" — socket unreachable. Most
 *     common case; the user opened the popup before launching the app.
 *   - "Connection lost" — socket dropped mid-stream (desktop quit).
 *
 * This file is plain CommonJS Node — no transpile step. It runs against
 * the system Node the user has on PATH (Chrome doesn't ship Node), so
 * we deliberately avoid ESM imports, top-level await, or any syntax
 * past Node 16. The host manifest installer verifies a `node` binary
 * is on PATH and bails with a helpful message if not.
 */
'use strict'

const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

/**
 * v2.0 polish — bound the NDJSON receive buffer. Mirrors the cap in
 * src/main/services/extension-bridge/server.ts; a runaway desktop
 * write without `\n` would otherwise grow this string forever and
 * eventually OOM the bridge process. 1 MB is two orders of magnitude
 * over any legitimate chat chunk.
 */
const MAX_NDJSON_BUFFER_BYTES = 1_048_576

/* ----------------------------- socket path ----------------------------- */

/**
 * Must match `socketPath()` in src/main/services/extension-bridge/server.ts
 * byte-for-byte — both processes read from the same place, so any drift
 * silently breaks the bridge. Kept in lockstep by code review (no shared
 * config file because this script runs in a different Node process under
 * Chrome's PATH, not Electron's).
 */
function socketPath() {
  if (process.platform === 'win32') {
    const data = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'VoidSoul AI Companion'
    )
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0
    }
    return '\\\\.\\pipe\\voidsoul-ext-' + (hash >>> 0).toString(36)
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library/Application Support/VoidSoul AI Companion/voidsoul-extension.sock'
    )
  }
  // Linux + others fall back to XDG_CONFIG_HOME / ~/.config
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(cfg, 'VoidSoul AI Companion/voidsoul-extension.sock')
}

/* ----------------------- Chrome ↔ host framing ------------------------- */

/** Read one length-prefixed JSON message from stdin. Yields null on EOF. */
function readChromeMessages(onMessage) {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    // Loop in case a single data event packed multiple messages.
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) return
      const payload = buffer.slice(4, 4 + length).toString('utf8')
      buffer = buffer.slice(4 + length)
      try {
        onMessage(JSON.parse(payload))
      } catch (err) {
        // Malformed JSON from Chrome shouldn't happen in practice; log
        // through stderr (Chrome captures it) and drop the message.
        process.stderr.write(
          'voidsoul native host: invalid JSON from Chrome: ' + String(err) + '\n'
        )
      }
    }
  })
  process.stdin.on('end', () => onMessage(null))
}

/** Frame + send one JSON message back to Chrome via stdout. */
function writeChromeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  process.stdout.write(Buffer.concat([header, payload]))
}

/* ----------------------------- socket loop ----------------------------- */

/**
 * Connect to the desktop app's local IPC socket. Returns a function
 * that sends one NDJSON message to the server. Drops to a graceful
 * error broadcast back to Chrome if the connection drops or never
 * succeeds.
 */
function connectToDesktop(onServerMessage, onDisconnect) {
  const socket = net.createConnection(socketPath())
  let serverBuffer = ''
  let connected = false

  socket.setEncoding('utf8')

  // v2.0 polish — outbound queue. The desktop socket connect is async,
  // but Chrome can deliver a `chat` message the instant the host
  // spawns. Without a queue, `send()` would write to a not-yet-
  // connected socket; Node buffers internally but a connect-error
  // before the buffer drains silently loses the message. Holding our
  // own queue lets us flush deterministically on `connect` and drop
  // (with a chat-done error) on a pre-connect failure.
  const preConnectQueue = []

  socket.on('connect', () => {
    connected = true
    for (const queued of preConnectQueue) {
      try {
        socket.write(queued)
      } catch (err) {
        process.stderr.write(
          'voidsoul native host: queued write failed: ' + String(err) + '\n'
        )
      }
    }
    preConnectQueue.length = 0
  })

  socket.on('data', (chunk) => {
    serverBuffer += chunk
    // v2.0 polish — bound the buffer. A misbehaving desktop write that
    // never emits a newline would otherwise grow this forever. Past the
    // cap we drop the connection and surface a disconnect; the desktop
    // server has a matching guard so misbehaviour is symmetric.
    if (serverBuffer.length > MAX_NDJSON_BUFFER_BYTES) {
      process.stderr.write(
        'voidsoul native host: desktop exceeded NDJSON buffer cap without newline; closing.\n'
      )
      serverBuffer = ''
      onDisconnect('connection-error', 'Desktop sent oversized framed message.')
      socket.destroy()
      return
    }
    let idx
    while ((idx = serverBuffer.indexOf('\n')) !== -1) {
      const line = serverBuffer.slice(0, idx).trim()
      serverBuffer = serverBuffer.slice(idx + 1)
      if (!line) continue
      try {
        onServerMessage(JSON.parse(line))
      } catch (err) {
        process.stderr.write(
          'voidsoul native host: invalid NDJSON from desktop: ' + String(err) + '\n'
        )
      }
    }
  })

  socket.on('error', (err) => {
    if (!connected) {
      // Couldn't even open the connection — desktop app isn't running
      // (or the user has it disabled). Surface a single friendly error.
      onDisconnect('desktop-not-running', err.message)
    } else {
      onDisconnect('connection-error', err.message)
    }
  })

  socket.on('close', () => {
    if (connected) onDisconnect('disconnected', 'Desktop app closed the connection.')
  })

  return {
    send(msg) {
      if (socket.destroyed) return
      const framed = JSON.stringify(msg) + '\n'
      // Pre-connect: hold the frame in the local queue so a `chat` that
      // raced ahead of the socket handshake doesn't get silently lost
      // if the connect ultimately errors.
      if (!connected) {
        preConnectQueue.push(framed)
        return
      }
      try {
        socket.write(framed)
      } catch (err) {
        process.stderr.write(
          'voidsoul native host: socket write failed: ' + String(err) + '\n'
        )
      }
    },
    /**
     * Drain the socket gracefully. Callers pass a callback that fires
     * AFTER the socket FIN is flushed — we use this to delay
     * process.exit until the desktop has actually seen our close, so
     * any in-flight abort messages we just queued have a chance to
     * land before the kernel reaps stdout.
     */
    close(onClosed) {
      try {
        socket.end(onClosed)
      } catch {
        if (onClosed) onClosed()
      }
    }
  }
}

/* ------------------------------- main ---------------------------------- */

function main() {
  // Track in-flight chat ids so we can surface a clean error for each
  // when the desktop disconnects mid-stream.
  const inFlight = new Set()
  let desktop = null
  let disconnected = false

  function reportDisconnect(reason, detail) {
    if (disconnected) return
    disconnected = true
    const friendly =
      reason === 'desktop-not-running'
        ? "VoidSoul desktop app isn't running. Launch it and try again."
        : 'Lost the connection to VoidSoul (' + (detail || 'unknown') + ').'
    // Send a chat-done error for every in-flight chat so the extension
    // doesn't sit forever with a "..." indicator.
    for (const id of inFlight) {
      writeChromeMessage({ type: 'chat-done', id, error: friendly })
    }
    inFlight.clear()
    // If Chrome started the port specifically to ping, also surface a
    // pong-with-error so the popup's "Connected" indicator goes red.
    writeChromeMessage({ type: 'desktop-status', connected: false, error: friendly })
  }

  desktop = connectToDesktop(
    (serverMsg) => {
      // Pass everything from desktop to Chrome verbatim — the message
      // shape is the same, the bridge is a pipe.
      if (serverMsg && (serverMsg.type === 'chat-done' || serverMsg.type === 'chat-chunk')) {
        if (serverMsg.type === 'chat-done') inFlight.delete(serverMsg.id)
      }
      writeChromeMessage(serverMsg)
    },
    (reason, detail) => reportDisconnect(reason, detail)
  )

  // On a clean boot the desktop is up and the very first thing we
  // forward is the ping the extension sends — no need for our own ping
  // here. But signal the popup that we got far enough to spawn:
  writeChromeMessage({ type: 'host-ready', host: 'dev.kyron.voidsoul', pid: process.pid })

  readChromeMessages((msg) => {
    if (msg === null) {
      // Chrome closed the port — extension was uninstalled, the tab
      // navigated away, or MV3 reaped the service worker. Tear down
      // the desktop connection so the server can release this client
      // slot. We send explicit abort frames for every in-flight chat
      // FIRST (so the desktop stops streaming + billing tokens for a
      // dead Chrome listener), then wait for the socket FIN to flush
      // before exiting. Without the callback, process.exit raced the
      // socket teardown and the desktop kept running its completion.
      if (desktop) {
        for (const id of inFlight) desktop.send({ type: 'abort', id })
        inFlight.clear()
        desktop.close(() => process.exit(0))
        // Hard ceiling so a desktop that wedges its socket can't keep
        // the host process around indefinitely.
        setTimeout(() => process.exit(0), 500).unref?.()
        return
      }
      process.exit(0)
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'chat' && typeof msg.id === 'string') {
      inFlight.add(msg.id)
    }
    if (msg.type === 'abort' && typeof msg.id === 'string') {
      inFlight.delete(msg.id)
    }
    if (desktop) desktop.send(msg)
  })

  // Belt-and-suspenders: if anything throws past our handlers, surface
  // it as a desktop-status error and bail. Chrome will respawn on the
  // next port open.
  process.on('uncaughtException', (err) => {
    process.stderr.write('voidsoul native host: uncaught: ' + String(err) + '\n')
    reportDisconnect('connection-error', err.message)
    process.exit(1)
  })
}

main()
