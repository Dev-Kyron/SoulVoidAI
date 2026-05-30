/**
 * VoidSoul content script — injects the overlay into the page and routes
 * the user's selection + prompt to the background worker.
 *
 * Lifecycle:
 *   1. Inject a Shadow DOM root the first time the user invokes Quick AI
 *      on a page (Alt+Shift+J or right-click → Ask VoidSoul). Shadow DOM
 *      isolates our CSS from the page's styles — overlays on Reddit,
 *      Twitter, Wikipedia, dev docs all render the same.
 *   2. Capture the current selection at invocation time (NOT at script
 *      load) — the user typically selects, hits the hotkey, expects THAT
 *      text used. Reading selection at injection time would always be empty.
 *   3. Open a chrome.runtime port to the background worker, send `chat`,
 *      stream chunks back into the overlay's reply pane.
 *   4. Esc closes the overlay; Cmd/Ctrl-Enter resubmits with the current
 *      prompt; clicking outside the panel closes it.
 *
 * Why a fresh overlay per invocation instead of mounting once and
 * showing/hiding: the page may have torn out our DOM (single-page-app
 * navigation, framework re-mount) since we last attached. Recreating
 * is cheap and avoids "overlay invisible because the page deleted its
 * parent node" failure modes.
 */
;(() => {
  const HOTKEY_DESC = navigator.platform.includes('Mac') ? '⌥⇧J' : 'Alt+Shift+J'
  let currentHost = null
  let currentPort = null
  let currentChatId = null

  /* ------------------------------ hotkey ------------------------------ */

  document.addEventListener(
    'keydown',
    (event) => {
      // Alt+Shift+J — matches manifest.commands. We register here too so
      // the hotkey works even on chrome:// pages where chrome.commands
      // can't deliver to a content script, or when the user has typed
      // into an iframe that lives outside our content script.
      if (
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === 'KeyJ'
      ) {
        event.preventDefault()
        openOverlay(captureSelection())
      }
    },
    true
  )

  /* ----------------------- background → content ----------------------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'voidsoul:open-overlay') {
      openOverlay(msg.selection || captureSelection())
    }
  })

  /* ----------------------- DOM helpers ------------------------------- */

  function captureSelection() {
    const sel = window.getSelection?.()
    return sel ? sel.toString().trim() : ''
  }

  function pageContext() {
    return {
      pageTitle: document.title || '',
      pageUrl: location.href || ''
    }
  }

  function openOverlay(initialSelection) {
    // Tear down any previous instance so two rapid invocations don't
    // stack two overlays. The teardown path also cancels the running
    // chat so we don't keep streaming into a dead DOM.
    closeOverlay('reopen')

    const host = document.createElement('div')
    host.id = 'voidsoul-overlay-host'
    host.style.cssText =
      'position:fixed;top:0;left:0;z-index:2147483647;width:0;height:0;'
    document.documentElement.appendChild(host)
    currentHost = host

    const shadow = host.attachShadow({ mode: 'open' })

    // We deliberately don't load overlay.css through a <link> here —
    // Shadow DOM doesn't inherit from the document's stylesheets, and
    // Chrome's content_scripts CSS injection happens at the document
    // level (where it does NOT reach inside Shadow DOM). Inline a
    // minimal stylesheet here; the heavier overlay.css is used as a
    // fallback for sites that strip our shadow root for some reason.
    shadow.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="voidsoul-card" role="dialog" aria-modal="true" aria-label="VoidSoul Quick AI">
        <div class="voidsoul-header">
          <span class="voidsoul-brand">VoidSoul</span>
          <span class="voidsoul-hint">${HOTKEY_DESC}</span>
          <button type="button" class="voidsoul-close" aria-label="Close VoidSoul overlay">×</button>
        </div>
        <div class="voidsoul-status" data-state="ready">Local · ready</div>
        <textarea class="voidsoul-prompt" rows="2" placeholder="Ask anything about this page … (Enter to send, Shift+Enter for newline)" aria-label="VoidSoul prompt"></textarea>
        ${initialSelection ? `<div class="voidsoul-selection" title="Selected text from the page">${escapeHtml(initialSelection.slice(0, 600))}${initialSelection.length > 600 ? '…' : ''}</div>` : ''}
        <div class="voidsoul-reply" aria-live="polite" aria-atomic="false"></div>
        <div class="voidsoul-footer">
          <button type="button" class="voidsoul-send">Ask VoidSoul</button>
          <button type="button" class="voidsoul-stop" hidden>Stop</button>
        </div>
      </div>
    `

    const card = shadow.querySelector('.voidsoul-card')
    const promptEl = shadow.querySelector('.voidsoul-prompt')
    const replyEl = shadow.querySelector('.voidsoul-reply')
    const statusEl = shadow.querySelector('.voidsoul-status')
    const sendBtn = shadow.querySelector('.voidsoul-send')
    const stopBtn = shadow.querySelector('.voidsoul-stop')
    const closeBtn = shadow.querySelector('.voidsoul-close')

    promptEl.focus()

    closeBtn.addEventListener('click', () => closeOverlay('close-btn'))
    sendBtn.addEventListener('click', () => submit())
    stopBtn.addEventListener('click', () => abort())

    promptEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeOverlay('esc')
      }
    })

    // Click-outside-to-close. We listen on the SHADOW host so clicks
    // hit the host's stacking context first; if the target is the host
    // itself (i.e. outside the card) we dismiss.
    host.addEventListener('mousedown', (event) => {
      if (!card.contains(event.composedPath()[0])) {
        closeOverlay('outside-click')
      }
    })

    function submit() {
      const prompt = promptEl.value.trim()
      if (!prompt) return
      sendBtn.setAttribute('disabled', 'true')
      stopBtn.hidden = false
      statusEl.dataset.state = 'streaming'
      statusEl.textContent = 'Streaming …'
      replyEl.textContent = ''
      replyEl.setAttribute('aria-busy', 'true')

      const port = chrome.runtime.connect({ name: 'voidsoul-content' })
      currentPort = port
      currentChatId = randomId()
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'chat-chunk' && msg.id === currentChatId) {
          replyEl.textContent += msg.delta
          // Auto-scroll to the freshly-appended text.
          replyEl.scrollTop = replyEl.scrollHeight
        } else if (msg.type === 'chat-done' && msg.id === currentChatId) {
          finalize(msg.error)
        } else if (msg.type === 'status') {
          if (!msg.connected && msg.error) {
            finalize(msg.error)
          }
        }
      })
      port.onDisconnect.addListener(() => {
        if (currentChatId) finalize('Background worker disconnected. Try again.')
      })
      port.postMessage({
        type: 'chat',
        id: currentChatId,
        prompt,
        selection: initialSelection,
        ...pageContext()
      })
    }

    function abort() {
      if (currentPort && currentChatId) {
        try {
          currentPort.postMessage({ type: 'abort', id: currentChatId })
        } catch {
          /* ignore */
        }
      }
      finalize('aborted')
    }

    function finalize(error) {
      sendBtn.removeAttribute('disabled')
      stopBtn.hidden = true
      replyEl.removeAttribute('aria-busy')
      if (error && error !== 'aborted') {
        statusEl.dataset.state = 'error'
        statusEl.textContent = error
      } else if (error === 'aborted') {
        statusEl.dataset.state = 'idle'
        statusEl.textContent = 'Stopped.'
      } else {
        statusEl.dataset.state = 'done'
        statusEl.textContent = 'Done.'
      }
      currentChatId = null
      if (currentPort) {
        try {
          currentPort.disconnect()
        } catch {
          /* ignore */
        }
        currentPort = null
      }
    }
  }

  function closeOverlay(_reason) {
    if (currentPort && currentChatId) {
      try {
        currentPort.postMessage({ type: 'abort', id: currentChatId })
        currentPort.disconnect()
      } catch {
        /* ignore */
      }
    }
    currentPort = null
    currentChatId = null
    if (currentHost?.parentNode) {
      currentHost.parentNode.removeChild(currentHost)
    }
    currentHost = null
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function randomId() {
    // crypto.randomUUID() is available in modern Chromium; fall back to
    // Math.random for very old builds. The id only needs to be unique
    // within this content-script instance, not globally.
    return crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /* ----------------------- inline shadow CSS ------------------------- */

  const OVERLAY_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .voidsoul-card {
      position: fixed;
      top: 24px;
      right: 24px;
      width: min(420px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 14px 14px 12px;
      border-radius: 14px;
      background: rgba(12, 14, 31, 0.96);
      color: #e6e8f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
      border: 1px solid rgba(124, 58, 237, 0.4);
      pointer-events: auto;
    }
    .voidsoul-header { display: flex; align-items: center; gap: 8px; }
    .voidsoul-brand { font-weight: 600; color: #c4b5fd; }
    .voidsoul-hint { font-size: 10px; color: #64748b; margin-left: auto; }
    .voidsoul-close {
      background: transparent;
      color: #94a3b8;
      border: none;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 4px;
    }
    .voidsoul-close:hover { color: #e6e8f5; }
    .voidsoul-status {
      font-size: 10px;
      color: #94a3b8;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.04);
      align-self: flex-start;
    }
    .voidsoul-status[data-state="streaming"] { color: #67e8f9; }
    .voidsoul-status[data-state="error"] { color: #fb7185; background: rgba(251,113,133,0.08); }
    .voidsoul-status[data-state="done"] { color: #34d399; }
    .voidsoul-prompt {
      width: 100%;
      min-height: 44px;
      resize: vertical;
      background: rgba(0,0,0,0.32);
      color: #e6e8f5;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
    }
    .voidsoul-prompt:focus {
      outline: none;
      border-color: rgba(124, 58, 237, 0.7);
    }
    .voidsoul-selection {
      max-height: 90px;
      overflow: auto;
      padding: 6px 8px;
      font-size: 11px;
      color: #cbd0e2;
      background: rgba(124, 58, 237, 0.08);
      border-left: 2px solid rgba(124, 58, 237, 0.5);
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .voidsoul-reply {
      max-height: 280px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 0;
      min-height: 18px;
    }
    .voidsoul-footer { display: flex; gap: 8px; justify-content: flex-end; }
    .voidsoul-send, .voidsoul-stop {
      cursor: pointer;
      border: none;
      padding: 6px 12px;
      border-radius: 8px;
      font: inherit;
    }
    .voidsoul-send {
      background: #7c3aed;
      color: white;
      font-weight: 600;
    }
    .voidsoul-send:hover { background: #6d28d9; }
    .voidsoul-send[disabled] { opacity: 0.5; cursor: not-allowed; }
    .voidsoul-stop {
      background: rgba(251, 113, 133, 0.8);
      color: white;
    }
    .voidsoul-stop:hover { background: rgba(251, 113, 133, 1); }
  `
})()
