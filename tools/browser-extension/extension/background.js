/**
 * VoidSoul extension background service worker.
 *
 * Owns the single long-lived native-messaging port to the desktop app's
 * native host. Content scripts and the popup connect to THIS worker via
 * `chrome.runtime.connect()`; we fan messages between them and the
 * native port. Centralising the port here means:
 *
 *   - We don't pay the host-spawn cost on every selection (each port
 *     spawns a fresh Node process — keeping one warm is meaningfully
 *     snappier than spawn-per-request).
 *   - The popup's connection-status indicator stays in sync with what
 *     the content script sees.
 *   - Aborting a chat from the popup reaches the same port the content
 *     script is streaming through.
 *
 * Service workers can be torn down by Chrome under memory pressure; we
 * lazily reopen the port on the next message rather than try to keep
 * the worker pinned. Each port has a unique `chatId` per request so
 * the worker can reassemble streams across short port lifetimes.
 */

const NATIVE_HOST = 'dev.kyron.voidsoul'

let nativePort = null
let desktopConnected = false
let lastError = null
// Map<chatId, Set<runtime.Port>> — which content-script / popup ports
// are waiting on each in-flight chat. We fan chunks to every listener
// in the set so the popup can mirror what the page overlay shows.
const chatListeners = new Map()

/** (Re-)open the native port. Returns the port or null on failure. */
function ensureNativePort() {
  if (nativePort) return nativePort
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST)
    nativePort = port
    desktopConnected = false
    lastError = null

    port.onMessage.addListener((msg) => {
      handleNativeMessage(msg)
    })
    port.onDisconnect.addListener(() => {
      const err =
        chrome.runtime.lastError?.message ||
        'Native host disconnected. Make sure the VoidSoul desktop app is running.'
      lastError = err
      desktopConnected = false
      nativePort = null
      // Surface a "chat-done with error" to every in-flight listener
      // so overlays don't sit forever with the typing indicator.
      for (const [chatId, set] of chatListeners) {
        for (const p of set) {
          safePost(p, { type: 'chat-done', id: chatId, error: err })
        }
      }
      chatListeners.clear()
      broadcastStatus()
    })
    return port
  } catch (err) {
    lastError = err?.message || String(err)
    desktopConnected = false
    nativePort = null
    broadcastStatus()
    return null
  }
}

function handleNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'host-ready') {
    desktopConnected = true
    lastError = null
    broadcastStatus()
    return
  }

  if (msg.type === 'desktop-status') {
    desktopConnected = Boolean(msg.connected)
    if (msg.error) lastError = msg.error
    broadcastStatus()
    return
  }

  if (msg.type === 'pong') {
    desktopConnected = true
    broadcastStatus()
    return
  }

  if (msg.type === 'chat-chunk' || msg.type === 'chat-done') {
    const listeners = chatListeners.get(msg.id)
    if (!listeners) return
    for (const p of listeners) safePost(p, msg)
    if (msg.type === 'chat-done') chatListeners.delete(msg.id)
  }
}

/**
 * A renderer port (content script, popup, options page) connects to us.
 * We attach our message handlers and tear them down on disconnect so
 * we don't leak references to closed pages.
 */
chrome.runtime.onConnect.addListener((port) => {
  // Every renderer connects with a distinct name so we can log which
  // surface (content / popup / options) sent a given message during
  // debugging, but the routing logic doesn't actually branch on it.
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return
    handleRendererMessage(port, msg)
  })
  port.onDisconnect.addListener(() => {
    // Drop the port from every chat's listener set so we stop posting
    // to a closed tab.
    for (const set of chatListeners.values()) set.delete(port)
  })
  // Send the current desktop status on connect so the UI doesn't have
  // to round-trip a ping just to render its "connected" indicator.
  safePost(port, { type: 'status', connected: desktopConnected, error: lastError })
})

function handleRendererMessage(port, msg) {
  if (msg.type === 'request-status') {
    safePost(port, { type: 'status', connected: desktopConnected, error: lastError })
    // Also opportunistically ping the native host so a stale "connected
    // = false" cached state can refresh.
    const native = ensureNativePort()
    if (native) {
      try {
        native.postMessage({ type: 'ping', id: 'status-check' })
      } catch {
        /* ignore — onDisconnect will fire and clean up */
      }
    }
    return
  }

  if (msg.type === 'chat') {
    const native = ensureNativePort()
    if (!native) {
      safePost(port, {
        type: 'chat-done',
        id: msg.id,
        error: lastError || "VoidSoul desktop app isn't running. Launch it and try again."
      })
      return
    }
    const listeners = chatListeners.get(msg.id) || new Set()
    listeners.add(port)
    chatListeners.set(msg.id, listeners)
    try {
      native.postMessage(msg)
    } catch (err) {
      safePost(port, {
        type: 'chat-done',
        id: msg.id,
        error: err?.message || String(err)
      })
      listeners.delete(port)
    }
    return
  }

  if (msg.type === 'abort') {
    const native = ensureNativePort()
    if (native) {
      try {
        native.postMessage(msg)
      } catch {
        /* ignore */
      }
    }
    // Best-effort tell the local listener set we're done.
    const listeners = chatListeners.get(msg.id)
    if (listeners) {
      for (const p of listeners) safePost(p, { type: 'chat-done', id: msg.id, error: 'aborted' })
      chatListeners.delete(msg.id)
    }
    return
  }
}

/* ------------------------------- helpers ------------------------------- */

function safePost(port, msg) {
  try {
    port.postMessage(msg)
  } catch {
    // Port already disconnected — silent drop.
  }
}

function broadcastStatus() {
  // Stash the latest status so popup/options pages can read it on open
  // without round-tripping a port message.
  chrome.storage.session
    ?.set({ desktopConnected, lastError })
    .catch(() => {
      /* session storage may not exist in older Chromium — non-fatal */
    })
}

/* ------------------------- toolbar / hotkey wiring ---------------------- */

// Hotkey defined in manifest.commands["ask-voidsoul"]. Fires regardless
// of which page is focused (as long as the extension has permission for
// that page — content.js will register its own per-page Alt+Shift+J too
// so users on chrome:// pages still get the popup fallback).
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'ask-voidsoul' || !tab?.id) return
  chrome.tabs
    .sendMessage(tab.id, { type: 'voidsoul:open-overlay' })
    .catch(() => {
      // Content script not injected on this URL (chrome://, file://, etc.).
      // Open the popup as a fallback so the user can still type a prompt.
      chrome.action?.openPopup?.()
    })
})

/* ------------------------- right-click context menu --------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.create({
    id: 'voidsoul-ask-selection',
    title: 'Ask VoidSoul about "%s"',
    contexts: ['selection']
  })
})

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'voidsoul-ask-selection' || !tab?.id) return
  chrome.tabs
    .sendMessage(tab.id, {
      type: 'voidsoul:open-overlay',
      selection: info.selectionText || ''
    })
    .catch(() => {
      /* same fallback semantics as above */
    })
})
