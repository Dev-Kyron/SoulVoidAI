/**
 * v2.0 — Semantic screen awareness.
 *
 * The wound: `awareness.ts` polls the active window title every 4
 * seconds and broadcasts it. That tells the assistant "you're in VS
 * Code" — but NOT "you're editing visualClick.ts and looking at the
 * sonnet routing block". The OCR and vision services exist in
 * `screen/` but were never wired into the continuous loop, so screen
 * awareness was perpetually coarse.
 *
 * The fix: on every window-title CHANGE (not on a timer — the title
 * is the natural "context shifted" signal), debounce ~3s for the
 * change to settle (alt-tab passes through several titles), then
 * capture the active display and run OCR for a short text excerpt.
 * Broadcast a richer `screen:snapshot` event that downstream consumers
 * (chat surface system-prompt builder, tray, etc) can use to inject
 * real context when the user asks "what am I looking at" or the
 * assistant decides to be helpful.
 *
 * Cost guards:
 *  - Debounce window-title changes for 3s — alt-tab between five apps
 *    fires once, not five times.
 *  - Dedup against the last captured fingerprint — title that didn't
 *    semantically change ("untitled - notepad" → "untitled* - notepad"
 *    on the first keystroke) doesn't re-OCR.
 *  - Hard cap on excerpt length so the prompt cost stays bounded.
 *  - OCR runs entirely locally via tesseract.js — no network, no API
 *    spend. Vision-summary (cloud call, real money) is intentionally
 *    out of scope here; if/when added it'll be a separate gate.
 *  - Skip when the screen-capture permission isn't granted (defence in
 *    depth — `setSemanticAwareness` also gates).
 */
import { broadcast } from '../../events'
import { isGranted } from '../permissions/permissions'
import { log } from '../logger'
import { captureScreen } from './screenshot'
import { extractText } from './ocr'
import type { ScreenSnapshot } from '@shared/types'

export type { ScreenSnapshot } from '@shared/types'

/** Wait this long after a window-title change before capturing. Alt-tab
 *  in particular fires several intermediate titles; the user almost
 *  always rests on the final one for at least this long. */
const DEBOUNCE_MS = 3000

/** OCR output is clamped to this many chars before the broadcast. Just
 *  enough for a useful "you're looking at..." injection without dragging
 *  the whole document into the system prompt. */
const MAX_EXCERPT_CHARS = 1200

/** Skip OCR entirely when the previous successful capture was less than
 *  this long ago AND the new fingerprint is the same. Protects against
 *  a window title flickering between two states (e.g. "saving..." vs
 *  steady) from triggering back-to-back OCR runs. */
const MIN_GAP_MS = 8000

// ScreenSnapshot now lives in @shared/types so producer (here) and
// consumer (renderer App.tsx + useChatStore) share one type. Field-
// level drift would silently break injection.

let pending: NodeJS.Timeout | null = null
let pendingFor: { title: string; process: string } | null = null
let lastFingerprint = ''
let lastCapturedAt = 0
let enabled = false
let inFlight = false

/**
 * Toggle the semantic awareness loop. Idempotent; passes through to
 * `false` when the screenCapture permission isn't granted (defence in
 * depth — the caller in awareness.ts also checks).
 */
export function setSemanticAwareness(value: boolean): boolean {
  if (value && !isGranted('screenCapture')) {
    log('warn', 'screen', 'Semantic awareness needs the Screen Capture permission — staying off.')
    enabled = false
    return false
  }
  if (value === enabled) return enabled
  enabled = value
  if (!enabled) {
    if (pending) {
      clearTimeout(pending)
      pending = null
    }
    pendingFor = null
    // v2.0 polish — clear the renderer's cached snapshot so the chat
    // surface stops injecting a stale OCR excerpt after the user
    // toggles off. Without this, the last-known snapshot would keep
    // leaking into every subsequent system prompt until the renderer
    // process restarts. Null payload signals "no snapshot".
    broadcast('screen:snapshot', null)
    // In-flight OCR is left to settle but the post-OCR `enabled`
    // check at the bottom of runCapture short-circuits the broadcast.
    log('info', 'screen', 'Semantic awareness disabled.')
  } else {
    log('info', 'screen', 'Semantic awareness enabled.')
  }
  return enabled
}

export function isSemanticAwarenessEnabled(): boolean {
  return enabled
}

/**
 * Called by `awareness.ts` whenever the active-window fingerprint
 * changes. We debounce here so a rapid alt-tab through five apps
 * lands as ONE OCR call, against the app the user actually rests on.
 */
export function noteWindowChange(info: { title: string; process: string }): void {
  if (!enabled) return
  if (!info.title && !info.process) return
  // Debounce — replace any pending capture with the latest title.
  if (pending) clearTimeout(pending)
  pendingFor = { title: info.title, process: info.process }
  pending = setTimeout(() => {
    pending = null
    const target = pendingFor
    pendingFor = null
    if (target) void runCapture(target)
  }, DEBOUNCE_MS)
}

async function runCapture(target: { title: string; process: string }): Promise<void> {
  if (inFlight) {
    // A prior OCR is still running — drop this one. The next title
    // change will re-schedule. Logging at info because this is
    // expected when the user is alt-tabbing rapidly.
    log('info', 'screen', `[semantic-awareness] dropping ${target.title} — prior capture in flight`)
    return
  }
  const fingerprint = `${target.process}::${target.title}`
  const now = Date.now()
  if (fingerprint === lastFingerprint && now - lastCapturedAt < MIN_GAP_MS) {
    // Same window, recent capture — skip. Saves OCR cost on a
    // flickering title.
    return
  }

  inFlight = true
  try {
    // v2.0 polish — persist:false to skip the PNG write. OCR can take
    // the data URL directly, so the disk write was pure waste — semantic
    // awareness fires every window change and was filling
    // userData/screenshots indefinitely with no consumer.
    const shot = await captureScreen({ persist: false })
    let text = ''
    let confidence = 0
    try {
      const ocr = await extractText(shot.dataUrl)
      text = (ocr.text || '').slice(0, MAX_EXCERPT_CHARS)
      confidence = ocr.confidence
    } catch (err) {
      // OCR can fail when tesseract.js can't download its lang data on
      // first use (no network) or when the image is a transparent
      // overlay. Surface the snapshot WITHOUT text rather than
      // dropping the whole event — the renderer can still benefit
      // from knowing the window changed.
      log(
        'warn',
        'screen',
        `[semantic-awareness] OCR failed for "${target.title}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
    // v2.0 polish — re-check enabled AFTER the slow OCR step. tesseract.js
    // cold-start can be 5s+; the user can toggle off mid-capture. Without
    // this guard the snapshot still fires after they opted out, leaking
    // window context into the system prompt of any chat that's already
    // open.
    if (!enabled) {
      log('info', 'screen', '[semantic-awareness] capture finished after disable — dropping')
      return
    }
    const snapshot: ScreenSnapshot = {
      title: target.title,
      process: target.process,
      text,
      confidence,
      capturedAt: new Date().toISOString(),
      width: shot.width,
      height: shot.height
    }
    lastFingerprint = fingerprint
    lastCapturedAt = Date.now()
    broadcast('screen:snapshot', snapshot)
    log(
      'info',
      'screen',
      `[semantic-awareness] snapshot "${target.title}" (${target.process}) — ${text.length} chars, conf ${confidence}`
    )
  } catch (err) {
    log(
      'warn',
      'screen',
      `[semantic-awareness] capture threw for "${target.title}": ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    inFlight = false
  }
}

/** Test-only — reset internal state. */
export function _resetForTests(): void {
  if (pending) clearTimeout(pending)
  pending = null
  pendingFor = null
  lastFingerprint = ''
  lastCapturedAt = 0
  enabled = false
  inFlight = false
}
