/**
 * v1.7 — screen-watch loop.
 *
 * Every N minutes, capture a low-resolution screenshot, send it to the
 * user's active vision-capable AI provider, and let the model decide if
 * it has something genuinely useful to say. If it does, route the spoken
 * line through `speakProactiveAdHoc` so the existing DND / voice-mute /
 * master-toggle gates all apply.
 *
 * Hard constraints (all configurable in Settings → Voice → Screen watch):
 *   · Opt-in only — config.screenWatch.enabled = false by default
 *   · screenCapture permission must be granted
 *   · Active hours window — Soul doesn't look at 3am unless told to
 *   · Daily cap — observation calls/day hard-stops at config.dailyCap
 *   · Per-tick dedup — if a tick fires a spoken line, the next tick
 *     compares the new content to the prior and suppresses near-dupes
 *
 * Why a SEPARATE module rather than a new WatchSpec.type:
 *   · Different lifecycle (timer + cost cap, not condition matcher)
 *   · Special provider gating (must be vision-capable)
 *   · Privacy/cost considerations deserve dedicated UI surface
 *
 * The decision route is: tick → captureScreen → ask provider → parse
 * JSON → speakProactiveAdHoc. Failures at any step log a warning and
 * continue; the next tick will try again.
 */
import { desktopCapturer, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../storage/config'
import { isQuietNow } from '@shared/types'
import { log } from '../logger'
import { invokeCompletion } from '../ai'
import { getIdleMinutes, speakProactiveAdHoc } from './watchTasks'
import type { ChatTurn, ScreenWatchConfig, ScreenWatchStatus } from '@shared/types'
import type { ToneTag } from '@shared/voiceMarkers'

/* ---------------------- module state (volatile) --------------------- */

let timerId: NodeJS.Timeout | null = null
let dailyCalls = 0
/** Wall-clock ms at which dailyCalls should reset (next local midnight). */
let dailyResetAt = 0

let lastObservationAt: number | null = null
let lastSpoke = false
let lastReason: string | null = null
let lastSpokenContent: string | null = null

/* ---------------------- lifecycle ----------------------------------- */

/**
 * Start (or restart) the loop. Idempotent — safe to call after config
 * changes. Reads the latest interval from config; if disabled, just
 * stops any existing timer and returns.
 */
export function startScreenWatch(): void {
  stopScreenWatch()
  const cfg = getConfig().screenWatch
  if (!cfg.enabled) return
  const interval = Math.max(1, cfg.intervalMinutes) * 60_000
  timerId = setInterval(() => void tick(), interval)
  log(
    'info',
    'system',
    `[screen-watch] loop armed — every ${cfg.intervalMinutes} min, cap ${cfg.dailyCap}/day.`
  )
}

export function stopScreenWatch(): void {
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
}

/** Public observation-on-demand path (Settings "Test now" button). */
export async function observeNow(): Promise<ScreenWatchStatus> {
  await tick()
  return getScreenWatchStatus()
}

/* ---------------------- status surface ------------------------------ */

export function getScreenWatchStatus(): ScreenWatchStatus {
  const cfg = getConfig().screenWatch
  resetDailyCounterIfNeeded()
  return {
    enabled: cfg.enabled,
    intervalMinutes: cfg.intervalMinutes,
    callsToday: dailyCalls,
    dailyCap: cfg.dailyCap,
    lastObservationAt: lastObservationAt ? new Date(lastObservationAt).toISOString() : null,
    lastSpoke,
    lastReason
  }
}

/* ---------------------- daily cap reset ----------------------------- */

function resetDailyCounterIfNeeded(): void {
  const now = Date.now()
  if (dailyResetAt === 0 || now >= dailyResetAt) {
    dailyCalls = 0
    const tomorrow = new Date()
    tomorrow.setHours(24, 0, 0, 0)
    dailyResetAt = tomorrow.getTime()
  }
}

/* ---------------------- active-hours check -------------------------- */

function parseHHMM(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function isInActiveHours(cfg: ScreenWatchConfig): boolean {
  if (!cfg.activeFrom || !cfg.activeTo) return true
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const from = parseHHMM(cfg.activeFrom)
  const to = parseHHMM(cfg.activeTo)
  if (from === null || to === null) return true
  return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to
}

/* ---------------------- screen capture (low-res) -------------------- */

interface Screenshot {
  dataUrl: string
  width: number
  height: number
}

/**
 * Captures the primary display at ~1280px width — enough for vision
 * models to read text without paying for a 4K image every tick. The
 * full-res `captureScreen()` in `services/screen/screenshot.ts` is
 * still used for the one-off "Screenshot" quick action (file save).
 */
async function captureScreenForWatch(): Promise<Screenshot> {
  const display = screen.getPrimaryDisplay()
  const targetW = 1280
  const ratio = targetW / Math.max(1, display.size.width)
  const targetH = Math.round(display.size.height * ratio)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  })
  if (sources.length === 0) {
    throw new Error('No screen source available for screen-watch.')
  }
  const png = sources[0].thumbnail.toPNG()
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: targetW,
    height: targetH
  }
}

/* ---------------------- vision observation -------------------------- */

const OBSERVATION_SYSTEM = `You are observing the user's screen as part of VoidSoul AI Companion's screen-watch feature. The user has explicitly opted in — they want you to look and comment ONLY when there's real value.

Decide if you have something MEANINGFULLY helpful to say:
- A real observation about what they're doing (stuck on a stack trace, repeated paste/undo cycles, blocking error dialog)
- A gentle check-in if they seem distracted or frustrated (rapid app switching, many tabs)
- A useful nudge about something you notice (open Slack with mentions, calendar event due soon)

Strict rules — silence is the default:
- Stay silent unless there is REAL value. Most observations should result in silence.
- Don't comment on app names alone ("you're using VS Code")
- Don't read text aloud — the user can see it
- Don't repeat yourself across ticks
- Under 30 words when you do speak
- Pick the right tone: casual / warm / curious / focused / thinking

Reply with STRICT JSON, no markdown fences, no prose:
{ "speak": boolean, "content": string, "tone": string, "reason": string }

- speak=false: leave content empty, put a short reason ("user is reading docs")
- speak=true: content is what Soul will say, tone is the delivery, reason can be empty`

interface Decision {
  speak: boolean
  content: string
  tone: ToneTag
  reason: string
}

function parseDecision(text: string): Decision {
  // Strip markdown fences (Gemini in particular wraps JSON in ```json…```)
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    const json = JSON.parse(cleaned) as Record<string, unknown>
    const speak = json.speak === true
    const content = typeof json.content === 'string' ? json.content.trim().slice(0, 300) : ''
    const toneRaw = typeof json.tone === 'string' ? json.tone.toLowerCase() : 'warm'
    const validTones: ToneTag[] = [
      'casual',
      'focused',
      'excited',
      'serious',
      'dry',
      'encouraging',
      'playful',
      'warm',
      'curious',
      'thinking'
    ]
    const tone = (validTones.includes(toneRaw as ToneTag) ? toneRaw : 'warm') as ToneTag
    const reason = typeof json.reason === 'string' ? json.reason.slice(0, 120) : ''
    return { speak, content, tone, reason }
  } catch {
    return { speak: false, content: '', tone: 'warm', reason: 'unparseable response' }
  }
}

/** Returns true when the two observation texts look like the same idea
 *  expressed twice — first 30 lowercased chars equal. Cheap; if the
 *  model is wordy on its repetitions this won't catch them, but it
 *  catches "You've been on this stack trace for a while" reruns. */
function tooSimilar(a: string, b: string): boolean {
  const aLow = a.toLowerCase().slice(0, 30)
  const bLow = b.toLowerCase().slice(0, 30)
  return aLow === bLow
}

/* ---------------------- tick (the loop body) ------------------------ */

async function tick(): Promise<void> {
  const cfg = getConfig()
  const watch = cfg.screenWatch

  // Gate 1: feature toggle
  if (!watch.enabled) return

  // Gate 2: master proactive switch
  if (!cfg.proactiveVoice.enabled) {
    lastReason = 'master proactive switch is off'
    return
  }

  // Gate 3: DND
  if (isQuietNow(cfg.appearance.dnd)) {
    lastReason = 'inside DND window'
    return
  }

  // Gate 4: active hours
  if (!isInActiveHours(watch)) {
    lastReason = 'outside active hours'
    return
  }

  // Gate 5: screen-capture permission
  if (!cfg.permissions.screenCapture?.granted) {
    lastReason = 'screenCapture permission not granted'
    return
  }

  // Gate 6: daily cap
  resetDailyCounterIfNeeded()
  if (dailyCalls >= watch.dailyCap) {
    lastReason = `daily cap reached (${watch.dailyCap} calls)`
    return
  }

  // v2.0 round-7 perf — Gate 7: AFK guard. If the user hasn't interacted
  // with VoidSoul in the last 15 minutes they're almost certainly away
  // from the keyboard; firing the vision provider (real money — cloud
  // API call per tick) at an unchanging screen burns budget the user
  // never sees. The `tooSimilar` check downstream would discard the
  // result anyway. This pairs with the daily cap as a SECOND-class
  // cost guard: cap = "you've spent enough today", AFK = "you're not
  // even watching right now".
  //
  // Threshold of 15min mirrors the idle-duration watch's default
  // "long idle" sense — chosen high enough that a quick coffee break
  // doesn't pause the loop the user actually wants running.
  const AFK_THRESHOLD_MIN = 15
  if (getIdleMinutes() >= AFK_THRESHOLD_MIN) {
    lastReason = `user appears AFK (${getIdleMinutes()}min idle)`
    return
  }

  // Take the screenshot
  let shot: Screenshot
  try {
    shot = await captureScreenForWatch()
  } catch (err) {
    log(
      'warn',
      'system',
      `[screen-watch] capture failed: ${err instanceof Error ? err.message : String(err)}`
    )
    lastReason = 'capture failed'
    return
  }

  // Count the call BEFORE the AI call so a failure still consumes a
  // tick of budget — protects against a stuck provider draining the
  // user's wallet via infinite retries.
  dailyCalls++
  lastObservationAt = Date.now()

  // Call the active provider with the screenshot + JSON prompt
  const provider = cfg.activeProvider
  const model = cfg.providers[provider].model
  const turn: ChatTurn = {
    role: 'user',
    content:
      'Look at this screenshot of my desktop and decide if you have something meaningfully useful to say. Reply with the strict JSON envelope.',
    images: [shot.dataUrl]
  }

  const controller = new AbortController()
  // 30s hard limit — vision calls on slow providers can hang; we'd
  // rather skip this tick than block the next one.
  const timer = setTimeout(() => controller.abort(), 30_000)
  let raw: string
  try {
    const result = await invokeCompletion(
      {
        requestId: `screen-watch-${randomUUID()}`,
        provider,
        model,
        system: OBSERVATION_SYSTEM,
        messages: [turn]
      },
      controller.signal,
      // Suppress the agent tool schema — we want a clean JSON one-shot,
      // not "the model decided to call web_search instead of answering".
      { tools: [] }
    )
    clearTimeout(timer)
    if (result.error) {
      lastSpoke = false
      lastReason = `provider error: ${result.error}`
      log('warn', 'system', `[screen-watch] provider error: ${result.error}`)
      return
    }
    raw = result.text
  } catch (err) {
    clearTimeout(timer)
    lastSpoke = false
    lastReason = 'vision call failed'
    log(
      'warn',
      'system',
      `[screen-watch] vision call failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

  const decision = parseDecision(raw)

  if (!decision.speak || !decision.content) {
    lastSpoke = false
    lastReason = decision.reason || 'model chose silence'
    return
  }

  // Dedup against the prior spoken line
  if (lastSpokenContent && tooSimilar(lastSpokenContent, decision.content)) {
    lastSpoke = false
    lastReason = 'similar to previous observation (deduped)'
    return
  }

  // Pipe through the shared gated-broadcast path so DND/mute checks
  // run one more time (in case state flipped during the vision call)
  // and the audio queue picks it up like any other proactive nudge.
  const fired = speakProactiveAdHoc('Screen watch', {
    type: 'speak',
    content: decision.content,
    tone: decision.tone,
    allowInterrupt: false
  })

  if (fired) {
    lastSpoke = true
    lastReason = decision.reason || 'observation worth sharing'
    lastSpokenContent = decision.content
  } else {
    lastSpoke = false
    lastReason = 'gated-broadcast suppressed (DND/mute/master?)'
  }
}
