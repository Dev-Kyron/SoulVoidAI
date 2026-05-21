/**
 * Optional continuous screen awareness. When enabled, the active window is
 * polled on an interval and broadcast to the renderer so the assistant can
 * reference what the user is currently doing. This is opt-in and gated by the
 * Screen Capture permission — it never runs silently.
 */
import { getActiveWindow } from './activeWindow'
import { broadcast } from '../../events'
import { isGranted } from '../permissions/permissions'
import { log } from '../logger'
import type { ActiveWindowInfo } from '@shared/types'

const POLL_INTERVAL_MS = 4000

let timer: NodeJS.Timeout | null = null
let last = ''

async function poll(): Promise<void> {
  const info = await getActiveWindow()
  const fingerprint = `${info.process}::${info.title}`
  if (fingerprint !== last) {
    last = fingerprint
    broadcast('screen:active-window', info satisfies ActiveWindowInfo)
  }
}

export function setScreenAwareness(enabled: boolean): boolean {
  if (enabled && !isGranted('screenCapture')) {
    log('warn', 'screen', 'Screen awareness needs the Screen Capture permission.')
    return false
  }
  if (enabled && !timer) {
    void poll()
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    log('info', 'screen', 'Continuous screen awareness enabled.')
  } else if (!enabled && timer) {
    clearInterval(timer)
    timer = null
    last = ''
    log('info', 'screen', 'Continuous screen awareness disabled.')
  }
  return enabled
}

export function stopScreenAwareness(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
