/**
 * v1.8.0 — vision-guided click orchestrator.
 *
 * One high-level action the AI agent can invoke (`click_on_screen` tool):
 *   1. Capture a screenshot of the user's primary display.
 *   2. Ask the active vision-capable LLM to locate the described element
 *      in the screenshot and return centre-pixel coordinates.
 *   3. Project from screenshot-pixel space back to LOGICAL display pixels
 *      (the coordinate system Windows' Cursor::Position uses).
 *   4. Pop a small transparent HUD over the target with a 3-second countdown
 *      (cancellable via Esc or the Cancel button).
 *   5. If the user lets the countdown finish, close the HUD, brief delay
 *      for the window to actually disappear, then moveMouse + click.
 *   6. Return a structured result describing what happened — found-coords,
 *      decision, click outcome — so the chat surface can show a useful log
 *      line ("Clicked the Send button" / "Cancelled — couldn't find it").
 *
 * Permissions: the AI tool dispatch already gates on `inputAccess`. We
 * additionally need `screenCapture` to take the screenshot — checked here
 * with a friendly error rather than letting the screenshot call throw.
 *
 * DPI / coordinate space:
 *   The screenshot is rendered at a downscaled but logically-proportional
 *   resolution (default 1600 wide). The vision model returns coords in that
 *   space. We project to LOGICAL display pixels via the width ratio. We
 *   never deal with raw DPI-scaled pixels because Windows' Cursor::Position
 *   in PowerShell runs DPI-unaware and accepts logical coords directly —
 *   matching `display.size.width`/`height` (which are themselves logical).
 */
import { desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../storage/store'
import { log } from '../logger'
import { broadcast } from '../../events'
import { assertGranted, PermissionDeniedError } from '../permissions/permissions'
import { moveMouse, mouseClick } from './input'
import { locateElement } from '../vision/locate'
import { requestPreview } from './clickPreview'
import { enumerateClickableElements } from './uia'
import { matchUiaElement } from './uiaMatch'
import { enumerateWindows, focusWindow } from './windowManager'
import { matchWindow } from './windowMatch'
import type { ActionResult } from '@shared/types'

/**
 * Screenshot target width in LOGICAL pixels. v1.8.0 used 1600 to cap wire
 * cost, but beta showed the model returns coordinates off by 30-80 pixels
 * on small targets (chat send buttons, toolbar icons) at that resolution.
 * v1.8.1 raises the cap to 2400 — most desktops are 1920×1080, so this
 * effectively means "no downscale" for the common case and a modest
 * downscale on 4K. Worth the extra ~150KB of base64 payload per call.
 */
const SCREENSHOT_TARGET_WIDTH = 2400

/**
 * Two-pass refinement crop size. After the first locate predicts a point,
 * we crop a REFINE_CROP×REFINE_CROP region centred on it and ask the
 * model to refine. 500 is wide enough to keep the target in frame even
 * if the first pass was 200px off, but narrow enough that the model
 * sees the target at ~5× higher effective pixel density (since the
 * vision input is normalised to a fixed resolution by every provider).
 *
 * v1.9.6 — REFINEMENT IS AUTHORITATIVE. v1.9.5 had a first-pass-only
 * fallback that clicked the original guess when refinement failed,
 * thinking the preview HUD would catch errors. In practice the model
 * (made commit-biased by v1.9.5's prompt) confidently first-passed
 * wrong locations; refinement correctly said "target not in this
 * crop"; the fallback clicked the wrong location anyway at the
 * inflated first-pass confidence. We now treat refinement's "no" as
 * the strongest possible signal that the first pass was wrong and
 * refuse the click. The user gets a clear failure toast and can
 * retry with a tighter description.
 */
const REFINE_CROP = 500

/** Pause between closing the preview window and firing the actual click.
 *  Without this, the click can land on the still-fading HUD on slow systems.
 *  150ms covers the Electron close + GPU compositor flush margin we've
 *  measured on Windows. */
const PRE_CLICK_DELAY_MS = 150

interface CapturedScreen {
  /** Source NativeImage — kept so the refinement pass can crop without
   *  needing a second screen capture (faster + guarantees the crop
   *  matches what was located against). */
  image: NativeImage
  dataUrl: string
  /** Screenshot pixel dimensions (downscaled). */
  width: number
  height: number
  /** Logical display dimensions, used to project model coords back to the
   *  cursor coordinate space. */
  displayWidth: number
  displayHeight: number
  /** On-disk path so the screenshot is auditable later (debug + review). */
  path: string
}

async function captureForVisualClick(): Promise<CapturedScreen> {
  const display = screen.getPrimaryDisplay()
  // Logical width — Windows reports this even on a 200%-scaled monitor (e.g.
  // a 4K 200% display reports 1920x1080 here). We downscale further for the
  // wire cost cap but keep the projection math in logical space.
  const logicalW = display.size.width
  const logicalH = display.size.height
  const targetW = Math.min(SCREENSHOT_TARGET_WIDTH, logicalW)
  const ratio = targetW / Math.max(1, logicalW)
  const targetH = Math.round(logicalH * ratio)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  })
  if (sources.length === 0) {
    throw new Error('No screen source available for visual click.')
  }
  const image = sources[0].thumbnail
  const png = image.toPNG()
  const dir = dataPath('visual-click')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `target-${Date.now()}.png`)
  await writeFile(filePath, png)
  return {
    image,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: targetW,
    height: targetH,
    displayWidth: logicalW,
    displayHeight: logicalH,
    path: filePath
  }
}

/**
 * Two-pass refinement. Crops a {@link REFINE_CROP}-sized region around the
 * first-pass prediction, re-runs locate on the crop at much higher effective
 * pixel density, and projects the refined point back to original-screenshot
 * space. Refinement is authoritative: if the model looks at the zoomed crop
 * and says "target not here", we return null and the caller refuses the
 * click — never fall back to first-pass coords (that just clicks somewhere
 * we already know is wrong).
 */
async function refineLocate(args: {
  shot: CapturedScreen
  firstPass: { x: number; y: number; confidence: number; label: string }
  description: string
  signal?: AbortSignal
}): Promise<{ x: number; y: number; confidence: number; label: string } | null> {
  const { shot, firstPass } = args
  // Clamp the crop so it sits entirely within the screenshot. Without
  // clamping, a prediction near the screen edge would generate a
  // negative or out-of-bounds crop rect.
  const cropSize = Math.min(REFINE_CROP, shot.width, shot.height)
  const cropX = Math.max(0, Math.min(Math.round(firstPass.x - cropSize / 2), shot.width - cropSize))
  const cropY = Math.max(0, Math.min(Math.round(firstPass.y - cropSize / 2), shot.height - cropSize))

  const cropped = shot.image.crop({ x: cropX, y: cropY, width: cropSize, height: cropSize })
  const cropDataUrl = `data:image/png;base64,${cropped.toPNG().toString('base64')}`
  const cropDims = cropped.getSize()

  const refined = await locateElement({
    screenshotDataUrl: cropDataUrl,
    width: cropDims.width,
    height: cropDims.height,
    description: args.description,
    refinement: true,
    signal: args.signal
  })

  if (!refined.ok) return null
  // Project crop-local coords back to original screenshot space.
  return {
    x: cropX + refined.x,
    y: cropY + refined.y,
    confidence: refined.confidence,
    label: refined.label || firstPass.label
  }
}

export interface VisualClickArgs {
  /** Plain-English description of the click target. */
  what: string
  /** Mouse button — default 'left'. */
  button?: 'left' | 'right'
  /**
   * v1.10.0 — optional window hint. When set, we enumerate visible
   * top-level windows, fuzzy-match this string against titles / process
   * names, bring the matched window to foreground, and scope BOTH UIA
   * enumeration AND the vision screenshot to that window's bounds.
   * Eliminates cross-window false positives when the user has
   * multiple browsers / chat apps open.
   *
   * Pass null/undefined for the legacy global-scope behaviour.
   */
  inWindow?: string | null
  /** Caller-supplied abort signal — forwarded to the vision call so Stop
   *  in chat cancels mid-vision. */
  signal?: AbortSignal
}

/**
 * Captures a screenshot scoped to a specific window's screen bounds. The
 * resulting NativeImage is exactly the pixels of that window, projected
 * onto the same target width as the global path. Vision sees only the
 * target window's content.
 */
async function captureForWindow(window: {
  x: number
  y: number
  w: number
  h: number
}): Promise<CapturedScreen> {
  const display = screen.getPrimaryDisplay()
  const logicalW = display.size.width
  const logicalH = display.size.height
  // We capture the full display, then crop to the window bounds via
  // nativeImage.crop. desktopCapturer can't constrain to a sub-rect
  // directly, but the crop is cheap.
  const targetW = Math.min(SCREENSHOT_TARGET_WIDTH, logicalW)
  const ratio = targetW / Math.max(1, logicalW)
  const targetH = Math.round(logicalH * ratio)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  })
  if (sources.length === 0) {
    throw new Error('No screen source available for visual click.')
  }
  const fullImage = sources[0].thumbnail
  // Map window logical-pixel bounds into the downscaled screenshot space.
  const cropX = Math.max(0, Math.round(window.x * ratio))
  const cropY = Math.max(0, Math.round(window.y * ratio))
  const cropW = Math.min(targetW - cropX, Math.round(window.w * ratio))
  const cropH = Math.min(targetH - cropY, Math.round(window.h * ratio))
  if (cropW <= 0 || cropH <= 0) {
    throw new Error('Window bounds intersect screen at zero pixels.')
  }
  const image = fullImage.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  const png = image.toPNG()
  const dir = dataPath('visual-click')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `target-${Date.now()}.png`)
  await writeFile(filePath, png)
  const size = image.getSize()
  return {
    image,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height,
    // displayWidth/Height here are the WINDOW'S logical bounds, not
    // the display's — the projection from screenshot pixels back to
    // logical coords needs window space, not display space. Plus we
    // need to remember the window's screen offset so the click lands
    // at the right absolute position. Stored as such; fireClick adds
    // the offset before issuing moveMouse.
    displayWidth: window.w,
    displayHeight: window.h,
    path: filePath
  }
}

/**
 * End-to-end visual click. Always returns an ActionResult; never throws.
 *
 * v1.9.1 — instrumented at every step so the Logs tab shows the full
 * trail (UIA enumerated N elements in Xms, UIA matched/missed, fell to
 * vision, vision first-pass at (x,y) conf 0.7, refinement succeeded,
 * preview shown, user confirmed, click fired). Plus progress events
 * broadcast to the renderer for real-time visibility while the
 * pipeline is running — the silent failure mode of v1.9.0 was the
 * worst possible UX.
 */
export async function performVisualClick(args: VisualClickArgs): Promise<ActionResult> {
  const startedAt = Date.now()
  const what = args.what.trim()
  if (!what) {
    return {
      ok: false,
      type: 'visual-click',
      error: 'No element description supplied.'
    }
  }
  const button = args.button === 'right' ? 'right' : 'left'

  log(
    'info',
    'automation',
    `[visual-click] start: "${what}" (${button})${args.inWindow ? ` in_window="${args.inWindow}"` : ''}`
  )
  pushProgress(`Looking for "${what}"…`)

  // 0) Secondary permission check.
  try {
    assertGranted('screenCapture')
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      log('warn', 'automation', `[visual-click] blocked — screenCapture permission missing`)
      // Even needsPermission paths broadcast a failure toast — the chat
      // surface might not auto-prompt for the permission in every flow,
      // and silent denial is the bug we're fixing in this version.
      broadcast('visual-click:failure', {
        description: what,
        reason: 'Screen Capture permission not granted'
      })
      return {
        ok: false,
        type: 'visual-click',
        needsPermission: 'screenCapture',
        error:
          'click_on_screen needs Screen Capture permission to see the screen before clicking.'
      }
    }
    throw err
  }

  // 0.25) v1.10.0 — window-aware targeting. If the caller specified
  //       in_window, enumerate visible windows, fuzzy-match the hint,
  //       focus the matched window, and scope EVERYTHING downstream
  //       (UIA enumeration + vision screenshot) to that window's bounds.
  //       Eliminates cross-window false positives entirely — a "Send"
  //       button in Discord can't match when we asked for Messenger.
  let targetWindow: Awaited<ReturnType<typeof enumerateWindows>>[number] | null = null
  if (args.inWindow) {
    const winEnumStart = Date.now()
    const windows = await enumerateWindows()
    log(
      'info',
      'automation',
      `[visual-click] enumerated ${windows.length} windows in ${Date.now() - winEnumStart}ms for in_window="${args.inWindow}"`
    )
    const winMatch = matchWindow(windows, args.inWindow)
    if (!winMatch) {
      // v1.10.1 — soft-fall instead of hard-fail. Beta showed the AI
      // sometimes hallucinates an app name ("Messenger" when the user
      // is in Claude desktop / a browser tab). Refusing here forces
      // the AI into a retry-loop that wastes the user's time. Better
      // to LOG the miss prominently so it's debuggable, then proceed
      // with global enumeration so the click can still land.
      const titles = windows
        .slice(0, 5)
        .map((w) => `"${w.title}" (${w.processName})`)
        .join(', ')
      log(
        'warn',
        'automation',
        `[visual-click] in_window="${args.inWindow}" matched no open window — falling back to global search. Visible windows: ${titles || 'none'}`
      )
      pushProgress(
        `No window matched "${args.inWindow}" — searching all windows…`
      )
      // targetWindow stays null → downstream uses the global UIA +
      // full-screen screenshot path.
    } else {
      targetWindow = winMatch.window
      log(
        'info',
        'automation',
        `[visual-click] window matched: "${targetWindow.title}" (${targetWindow.processName}) at (${targetWindow.x}, ${targetWindow.y}) ${targetWindow.w}×${targetWindow.h} ${targetWindow.focused ? 'already focused' : 'will focus'}`
      )
      // Focus the window (no-op if it's already foreground). Brief wait
      // for the focus to take effect before UIA reads the tree — UIA can
      // return stale offscreen=true on a window that's still transitioning.
      if (!targetWindow.focused) {
        pushProgress(`Switching to "${targetWindow.title.slice(0, 32)}…"`)
        const focused = await focusWindow(targetWindow.hwnd)
        log(
          'info',
          'automation',
          `[visual-click] focus call ${focused ? 'sent' : 'failed'} for hwnd ${targetWindow.hwnd}`
        )
        await wait(250)
      }
    }
  }

  // 0.5) UIA-first locate (Windows). See uia.ts / uiaMatch.ts for design.
  //      Scoped to the target window when in_window was supplied — only
  //      that window's accessibility tree is walked.
  try {
    const uiaStart = Date.now()
    const uiaElements = await enumerateClickableElements(
      undefined,
      undefined,
      targetWindow?.hwnd ?? null
    )
    const uiaMs = Date.now() - uiaStart
    log(
      'info',
      'automation',
      `[visual-click] UIA enumerated ${uiaElements.length} elements in ${uiaMs}ms`
    )
    if (uiaElements.length > 0) {
      const uiaMatch = matchUiaElement(uiaElements, what)
      if (uiaMatch) {
        log(
          'success',
          'automation',
          `[visual-click] UIA matched "${uiaMatch.element.name || uiaMatch.element.automationId}" (${uiaMatch.element.controlType}) at (${uiaMatch.element.x}, ${uiaMatch.element.y}) ${uiaMatch.element.w}×${uiaMatch.element.h}, conf ${(uiaMatch.confidence * 100).toFixed(0)}%`
        )
        pushProgress(`Found "${uiaMatch.element.name || what}" — confirm to click…`)
        return await fireClick({
          x: uiaMatch.element.x + Math.round(uiaMatch.element.w / 2),
          y: uiaMatch.element.y + Math.round(uiaMatch.element.h / 2),
          description: what,
          confidence: uiaMatch.confidence,
          button,
          sourceLabel: uiaMatch.reason,
          source: 'uia',
          totalStartedAt: startedAt
        })
      }
      // v1.9.3 — when UIA had candidates but no usable match, surface
      // the top names so the trail makes the rejection obvious (e.g.
      // "only had the browser pane, falling to vision" is way more
      // useful than just "none matched"). Cap at 3 names to keep the
      // log line short.
      const sampleNames = uiaElements
        .filter((e) => e.name)
        .slice(0, 3)
        .map((e) => `"${e.name}" (${e.controlType.replace('ControlType.', '')})`)
        .join(', ')
      log(
        'info',
        'automation',
        `[visual-click] UIA had ${uiaElements.length} candidates but none matched "${what}" — falling to vision (sample: ${sampleNames || 'no named elements'})`
      )
    } else {
      log(
        'info',
        'automation',
        `[visual-click] UIA returned 0 elements — falling to vision (PowerShell may have failed, timed out, or this is a non-Windows host)`
      )
    }
  } catch (err) {
    log(
      'warn',
      'automation',
      `[visual-click] UIA enumeration threw: ${err instanceof Error ? err.message : String(err)} — falling to vision`
    )
  }

  // 1) Screenshot. (vision fallback)
  pushProgress(`Asking the model where to click "${what}"…`)
  let shot: CapturedScreen
  let windowOriginX = 0
  let windowOriginY = 0
  try {
    if (targetWindow) {
      // Windowed screenshot — vision sees ONLY the target window's
      // pixels at full normalized resolution. Coords come back in
      // window-local space; we add the window's screen origin before
      // clicking so the cursor lands at the absolute position.
      shot = await captureForWindow(targetWindow)
      windowOriginX = targetWindow.x
      windowOriginY = targetWindow.y
      log(
        'info',
        'automation',
        `[visual-click] window-scoped screenshot ${shot.width}×${shot.height} (window origin ${windowOriginX}, ${windowOriginY})`
      )
    } else {
      shot = await captureForVisualClick()
      log(
        'info',
        'automation',
        `[visual-click] screenshot captured ${shot.width}×${shot.height} (display ${shot.displayWidth}×${shot.displayHeight})`
      )
    }
  } catch (err) {
    return failWithToast(
      what,
      `Screen capture failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 2a) First-pass vision lookup.
  const firstPassStart = Date.now()
  const firstPass = await locateElement({
    screenshotDataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    description: what,
    signal: args.signal
  })
  log(
    'info',
    'automation',
    `[visual-click] vision first-pass in ${Date.now() - firstPassStart}ms: ${firstPass.ok ? `(${firstPass.x}, ${firstPass.y}) conf ${(firstPass.confidence * 100).toFixed(0)}%` : `FAILED — ${firstPass.reason}`}`
  )
  if (!firstPass.ok) {
    return failWithToast(what, firstPass.reason, {
      output: `Couldn't find "${what}" on screen — ${firstPass.reason}`,
      data: { screenshotPath: shot.path }
    })
  }

  // 2b) Two-pass refinement.
  const refineStart = Date.now()
  const located = await refineLocate({
    shot,
    firstPass,
    description: what,
    signal: args.signal
  })
  if (!located) {
    // v1.9.6 — refinement said "not here" after looking at a zoom of
    // the first-pass prediction. First pass was speculative — the
    // refusal is the second opinion confirming it. Refuse the click;
    // do NOT fall back to first-pass coords (that was the v1.9.5 bug
    // where the model confidently clicked the wrong location).
    const reason = `refinement rejected the first-pass guess (first-pass conf ${(firstPass.confidence * 100).toFixed(0)}%) after ${Date.now() - refineStart}ms`
    return failWithToast(what, reason, {
      output: `Couldn't locate "${what}" precisely. The first-pass guess was rejected when zoomed in. Try a more specific description — include position ("bottom-right of the compose area"), colour ("the blue arrow"), or surrounding text ("next to the smiley icon").`,
      data: {
        screenshotPath: shot.path,
        firstPassConfidence: firstPass.confidence,
        firstPassPoint: { x: firstPass.x, y: firstPass.y }
      }
    })
  }
  log(
    'info',
    'automation',
    `[visual-click] vision refinement in ${Date.now() - refineStart}ms: (${located.x}, ${located.y}) conf ${(located.confidence * 100).toFixed(0)}%`
  )

  // 3) Project from screenshot pixels → logical display pixels.
  //    When in windowed mode, the projection is screenshot → window-local
  //    coords, and we then add the window's screen origin so the absolute
  //    cursor position is right.
  const localX = Math.round((located.x / shot.width) * shot.displayWidth)
  const localY = Math.round((located.y / shot.height) * shot.displayHeight)
  const realX = localX + windowOriginX
  const realY = localY + windowOriginY
  pushProgress(`Found "${what}" — confirm to click…`)

  return fireClick({
    x: realX,
    y: realY,
    description: what,
    confidence: located.confidence,
    button,
    sourceLabel: located.label || undefined,
    source: 'vision',
    totalStartedAt: startedAt,
    extraData: { screenshotPath: shot.path }
  })
}

/**
 * Pushes a short progress message via the same failure-broadcast channel
 * the toast subscriber listens to, but with `progress: true` so the
 * renderer can render it as an info toast instead of an error. Keeps the
 * preload bridge surface to one event type.
 */
function pushProgress(message: string): void {
  broadcast('visual-click:failure', {
    description: '',
    reason: message,
    progress: true
  })
}

/**
 * Shared "show preview + click" tail. Both the UIA path and the vision
 * fallback funnel through here so the preview HUD UX is identical
 * regardless of how the coordinates were obtained.
 */
async function fireClick(args: {
  x: number
  y: number
  description: string
  confidence: number
  button: 'left' | 'right'
  /** Short tag shown to the user — UIA match name, vision label, or undefined. */
  sourceLabel?: string
  /** Which locator path produced the coords (surfaces in the log/data). */
  source: 'uia' | 'vision'
  /** Wall-clock ms when performVisualClick was first called — used so
   *  the success log line includes total end-to-end timing. */
  totalStartedAt?: number
  extraData?: Record<string, unknown>
}): Promise<ActionResult> {
  log(
    'info',
    'automation',
    `[visual-click] showing preview HUD at (${args.x}, ${args.y}) via ${args.source}`
  )
  const decision = await requestPreview({
    x: args.x,
    y: args.y,
    description: args.description,
    confidence: args.confidence,
    seconds: 3
  })
  if (decision === 'cancel') {
    log('info', 'automation', `[visual-click] cancelled by user: "${args.description}"`)
    return {
      ok: false,
      type: 'visual-click',
      output: `Cancelled the click on "${args.description}".`,
      error: 'cancelled',
      data: {
        x: args.x,
        y: args.y,
        description: args.description,
        source: args.source,
        ...args.extraData
      }
    }
  }

  // Brief pause so the closing HUD doesn't intercept the click, then move
  // + click.
  await wait(PRE_CLICK_DELAY_MS)
  try {
    await moveMouse(args.x, args.y)
    await mouseClick(args.button)
  } catch (err) {
    return failWithToast(
      args.description,
      `Click failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        data: { x: args.x, y: args.y, description: args.description, ...args.extraData }
      }
    )
  }
  const totalMs = args.totalStartedAt ? Date.now() - args.totalStartedAt : null
  log(
    'success',
    'automation',
    `[visual-click] CLICKED "${args.description}" at (${args.x}, ${args.y}) via ${args.source}${totalMs ? ` (total ${totalMs}ms)` : ''}`
  )

  const labelSuffix = args.sourceLabel ? ` (${args.sourceLabel})` : ''
  const sourceSuffix = args.source === 'uia' ? ' via accessibility tree' : ''
  return {
    ok: true,
    type: 'visual-click',
    output: `${args.button === 'right' ? 'Right-' : ''}Clicked "${args.description}"${labelSuffix} at (${args.x}, ${args.y})${sourceSuffix}.`,
    data: {
      x: args.x,
      y: args.y,
      description: args.description,
      label: args.sourceLabel ?? '',
      confidence: args.confidence,
      button: args.button,
      source: args.source,
      ...args.extraData
    }
  }
}

/**
 * Centralised failure path. v1.9.0 — also broadcasts a toast event to
 * every renderer so the user SEES the failure instead of staring at a
 * silent "✓ tool dispatched" in the chat surface. Returns an ActionResult
 * the caller can hand straight back to the dispatcher.
 */
function failWithToast(
  description: string,
  reason: string,
  extra?: { output?: string; data?: Record<string, unknown> }
): ActionResult {
  log('warn', 'automation', `visual-click failed for "${description}": ${reason}`)
  broadcast('visual-click:failure', { description, reason })
  return {
    ok: false,
    type: 'visual-click',
    output:
      extra?.output ??
      `Couldn't click "${description}" — ${reason}`,
    error: reason,
    data: extra?.data
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
