/**
 * Toolbar popup. Pings the background worker for desktop-status on open
 * and updates the dot + label. Esc closes the popup automatically per
 * Chrome's default popup keyhandling.
 */
const statusEl = document.getElementById('status')
const labelEl = document.getElementById('label')
const errorEl = document.getElementById('error')
const hotkeyEl = document.getElementById('hotkey')
const optionsBtn = document.getElementById('open-options')

if (navigator.platform.includes('Mac')) {
  hotkeyEl.textContent = '⌥⇧J'
}

optionsBtn.addEventListener('click', () => {
  if (chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage()
  }
})

const port = chrome.runtime.connect({ name: 'voidsoul-popup' })
port.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'status') {
    setStatus(msg.connected, msg.error)
  }
})

port.postMessage({ type: 'request-status' })

function setStatus(connected, error) {
  statusEl.dataset.connected = String(connected)
  if (connected) {
    labelEl.textContent = 'Desktop app connected · local-only'
    errorEl.hidden = true
  } else {
    labelEl.textContent = 'Desktop app not reachable'
    if (error) {
      errorEl.textContent = error
      errorEl.hidden = false
    } else {
      errorEl.hidden = true
    }
  }
}
