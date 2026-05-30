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
import { log } from '../logger'
import { broadcast } from '../../events'
import { assertGranted, PermissionDeniedError } from '../permissions/permissions'
import { moveMouse, mouseClick } from './input'
import { locateElement } from '../vision/locate'
import { requestPreview } from './clickPreview'
import { enumerateClickableElements } from './uia'
import { matchUiaElement, prettyControlType } from './uiaMatch'
import { enumerateWindows, focusWindow } from './windowManager'
import { matchWindow } from './windowMatch'
import { captureScreen, REFINE_CROP } from './screenCapture'
import { isSonnetComputerUseCapable, locateViaComputerUse } from './computerUseLocate'
import { locateViaUiaPick } from './uiaPickLocate'
import { findTaughtByDescription, recordTaughtHit, resolveTaughtClick } from './taughtClicks'
import { getConfig } from '../storage/config'
import type { CapturedScreen } from './screenCapture'
import type { UiaElement } from './uia'
import type { ActionResult } from '@shared/types'

/** Pause between closing the preview window and firing the actual click.
 *  Without this, the click can land on the still-fading HUD on slow systems.
 *  150ms covers the Electron close + GPU compositor flush margin we've
 *  measured on Windows. */
const PRE_CLICK_DELAY_MS = 150

/** v2.0 Phase 2 — computer-use never returns a per-action confidence,
 *  but `fireClick` renders `Math.round(confidence * 100)` on the preview
 *  HUD badge. Showing 0 or 10% would mislead — the tool wouldn't have
 *  emitted a click action if it wasn't confident. Default high. */
const COMPUTER_USE_DEFAULT_CONFIDENCE = 0.9

/** v2.0 Phase 3 — uia-pick has no per-call confidence either. Slightly
 *  lower than computer-use's default because picking from a curated
 *  list is structurally easier (you only succeed when the model says
 *  "id N") but the model's "I picked id N" doesn't tell us HOW certain
 *  it was. 0.85 keeps the preview HUD badge in the "high" band without
 *  matching the computer-use number 1:1, so users can read the badge
 *  + the trail and tell which engine produced the click. */
const UIA_PICK_DEFAULT_CONFIDENCE = 0.85

/**
 * Two-pass refinement. Crops a {@link REFINE_CROP}-sized region around the
 * first-pass prediction, re-runs locate on the crop at much higher effective
 * pixel density, and projects the refined point back to original-screenshot
 * space. Refinement is authoritative: if the model looks at the zoomed crop
 * and says "target not here", we return null and the caller refuses the
 * click — never fall back to first-pass coords (that just clicks somewhere
 * we already know is wrong).
 *
 * v1.9.6 — REFINEMENT IS AUTHORITATIVE. v1.9.5 had a first-pass-only
 * fallback that clicked the original guess when refinement failed,
 * thinking the preview HUD would catch errors. In practice the model
 * confidently first-passed wrong locations; refinement correctly said
 * "target not in this crop"; the fallback clicked the wrong location
 * anyway at the inflated first-pass confidence. We now treat refinement's
 * "no" as the strongest possible signal that the first pass was wrong
 * and refuse the click.
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
  const cropY = Math.max(
    0,
    Math.min(Math.round(firstPass.y - cropSize / 2), shot.height - cropSize)
  )

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
        error: 'click_on_screen needs Screen Capture permission to see the screen before clicking.'
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
      pushProgress(`No window matched "${args.inWindow}" — searching all windows…`)
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
        // v2.0 polish — if Windows refuses the foreground steal (common
        // when VoidSoul wasn't the source of recent user input), bail
        // with a clear toast instead of running UIA against a still-
        // background window. The pipeline would otherwise enumerate a
        // stale/offscreen tree, fall through to vision against a
        // screenshot of whatever the user actually had focused, and
        // fire the click in the wrong app.
        if (!focused) {
          return failWithToast(
            what,
            `Could not bring "${targetWindow.title.slice(0, 48)}" to the foreground (Windows blocked the focus steal). Click into the window once and retry.`
          )
        }
        await wait(250)
      }
    }
  }

  // 0.3) v2.0 Phase 4 — taught-click short-circuit. If the user has
  //      previously taught Soul a click for this exact description,
  //      look up the UIA element directly from their teaching and
  //      click it without ANY model call. Zero latency, zero cost,
  //      zero ambiguity — the win that makes hover-to-teach worth
  //      shipping. Falls through silently when no entry matches or
  //      the taught element isn't visible on screen right now.
  try {
    // Look up by description + inWindow scope so a click taught for
    // Slack ("send in slack" with entry.inWindow=Slack) doesn't match
    // when the AI calls click_on_screen with a different in_window
    // (or none). resolveTaughtClick then walks the entry's saved
    // window — not the current call's — so the safety holds even if
    // the AI later passes a contradictory in_window.
    const taught = findTaughtByDescription(what, args.inWindow ?? null)
    // v2.0 polish — `scopedHwnd` lookup used to `throw` and rely on the
    // outer catch as a goto. That confused the error log ("taught-click
    // consult threw") and made the storage-corruption path indistinguishable
    // from the expected "window not open" fall-through. Now we resolve to a
    // nullable `scopedHwnd` and gate the actual lookup with a boolean.
    if (taught) {
      let scopedHwnd: number | null = targetWindow?.hwnd ?? null
      let scopeOk = true
      if (taught.inWindow) {
        const windows = await enumerateWindows()
        const winMatch = matchWindow(windows, taught.inWindow)
        if (winMatch) {
          scopedHwnd = winMatch.window.hwnd
        } else {
          // Saved window isn't open — refuse to silently click
          // somewhere else, fall through to the regular pipeline.
          log(
            'info',
            'automation',
            `[visual-click] taught entry "${what}" wants window "${taught.inWindow}" but it isn't open — falling through`
          )
          scopeOk = false
        }
      } else if (scopedHwnd === null) {
        // v2.0 polish — when the taught entry is window-scoped to "any"
        // (taught.inWindow null) AND the AI didn't pass in_window, fall
        // back to the foreground window. Walking the global UIA tree
        // means a "close" taught entry would match VS Code's tab close
        // X, Settings' close, AND a Discord dialog X — ambiguous,
        // resolveTaughtClick returns null, we fall through to vision,
        // and the taught-click's zero-latency win is lost.
        const windows = await enumerateWindows()
        const focused = windows.find((w) => w.focused)
        if (focused) {
          scopedHwnd = focused.hwnd
          log(
            'info',
            'automation',
            `[visual-click] taught entry "${what}" has no window scope — defaulting to foreground "${focused.title.slice(0, 40)}"`
          )
        }
      }
      const resolved = scopeOk ? await resolveTaughtClick(taught, scopedHwnd) : null
      if (resolved) {
        log(
          'success',
          'automation',
          `[visual-click] taught-click hit: "${what}" → "${resolved.element.name}" (${resolved.element.controlType}) at (${resolved.element.x}, ${resolved.element.y})`
        )
        pushProgress(`Found "${resolved.element.name || what}" (taught) — confirm to click…`)
        recordTaughtHit(taught.id)
        return await fireClick({
          x: resolved.element.x + Math.round(resolved.element.w / 2),
          y: resolved.element.y + Math.round(resolved.element.h / 2),
          description: what,
          // Taught entries earn full confidence — the user themselves
          // pointed at this element and assigned the description.
          confidence: 1,
          button,
          sourceLabel: `taught: ${taught.rawDescription}`,
          source: 'uia',
          totalStartedAt: startedAt
        })
      }
      if (scopeOk) {
        // Distinct from the "saved window isn't open" branch which
        // logged its own reason — this is "window IS open but the
        // taught element vanished from inside it" (UI rearranged,
        // virtualized list scrolled, etc).
        log(
          'info',
          'automation',
          `[visual-click] taught entry "${what}" matched but didn't resolve (window scrolled, app updated, or element gone) — falling through to pipeline`
        )
      }
    }
  } catch (err) {
    // Storage corruption or UIA crash — log + fall through. We never
    // let the taught-click path BLOCK the regular pipeline.
    log(
      'warn',
      'automation',
      `[visual-click] taught-click consult threw: ${err instanceof Error ? err.message : String(err)} — using regular pipeline`
    )
  }

  // 0.4) v2.0 Phase 2 — provider-aware routing decision.
  //
  // When the user is on a capable Anthropic Sonnet AND has selected
  // `auto` (the default) or explicitly forced `sonnet-computer-use`,
  // we route to the native computer-use tool instead of running the
  // UIA-then-vision baseline. Computer-use's grounded-click training
  // outperforms the generic vision-locate path on the failure cases
  // that motivated this work (browser web content, icon-only
  // buttons, busy chat UIs).
  //
  // When `sonnet-computer-use` is forced but the active provider
  // doesn't support it, we surface a clear failure toast instead of
  // silently falling back — otherwise a user who deliberately picked
  // computer-use would be confused when the baseline runs anyway.
  // Config read is a synchronous JsonStore lookup — let it throw if the
  // file is corrupt. Swallowing here would hide a forced-mode failure
  // from the user who deliberately picked `sonnet-computer-use`.
  const config = getConfig()
  const mode = config.experimentalFeatures.clickStrategy ?? 'auto'
  const provider = config.activeProvider
  const modelId = config.providers[provider]?.model ?? ''
  const capable = isSonnetComputerUseCapable(provider, modelId)
  if (mode === 'sonnet-computer-use' && !capable) {
    return failWithToast(
      what,
      `click strategy forced to Sonnet computer-use but active provider (${provider} / ${modelId || 'no model'}) doesn't support it. Switch to an Anthropic Sonnet 3.5+ or change the strategy to "auto" in Settings → Experimental.`
    )
  }

  // Lazy capture — neither routeViaComputerUse nor the vision fallback
  // pay for a screenshot when UIA matches first. Both code paths share
  // ONE capture when both fire (the v2.0 polish fix for the Phase 2
  // double-capture bug: previously routeViaComputerUse captured, didn't
  // commit, and the vision fallback captured again).
  let cachedShot: CapturedScreen | null = null
  const getShot = async (): Promise<CapturedScreen> => {
    if (cachedShot) return cachedShot
    cachedShot = targetWindow
      ? await captureScreen({ window: targetWindow })
      : await captureScreen()
    return cachedShot
  }

  if (mode !== 'uia-then-vision' && capable) {
    try {
      const routed = await routeViaComputerUse({
        what,
        button,
        getShot,
        modelId,
        signal: args.signal,
        totalStartedAt: startedAt
      })
      if (routed) return routed
      // routed === null means "computer-use didn't commit to a click".
      // For `auto` we fall through to the UIA+vision baseline so we
      // still try. For the explicitly-forced `sonnet-computer-use`
      // mode, fail loudly — silently routing through a different
      // engine violates what the user asked for.
      if (mode === 'sonnet-computer-use') {
        return failWithToast(
          what,
          `Sonnet computer-use didn't commit to a click and the strategy is locked to it. Switch to "auto" in Settings → Experimental to allow fallback to UIA + vision.`
        )
      }
    } catch (err) {
      // Network / parse / abort — same contract as above: auto falls
      // through, forced mode surfaces the failure.
      const msg = err instanceof Error ? err.message : String(err)
      log(
        'warn',
        'automation',
        `[visual-click] computer-use route threw: ${msg} — ${mode === 'sonnet-computer-use' ? 'aborting (forced mode)' : 'using baseline'}`
      )
      if (mode === 'sonnet-computer-use') {
        return failWithToast(
          what,
          `Sonnet computer-use failed (${msg}) and the strategy is locked to it. Switch to "auto" in Settings → Experimental to allow fallback to UIA + vision.`
        )
      }
    }
  }

  // 0.5) UIA-first locate (Windows). See uia.ts / uiaMatch.ts for design.
  //      Scoped to the target window when in_window was supplied — only
  //      that window's accessibility tree is walked.
  //
  // Hoisted outside the try so the Phase 3 uia-pick step at 0.6 can
  // reuse the enumeration when matchUiaElement misses, without paying
  // for a second PowerShell round-trip.
  let uiaElements: UiaElement[] = []
  try {
    const uiaStart = Date.now()
    uiaElements = await enumerateClickableElements(undefined, undefined, targetWindow?.hwnd ?? null)
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
        .map((e) => `"${e.name}" (${prettyControlType(e.controlType)})`)
        .join(', ')
      log(
        'info',
        'automation',
        `[visual-click] UIA had ${uiaElements.length} candidates but none matched "${what}" — trying uia-pick (sample: ${sampleNames || 'no named elements'})`
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

  // 0.6) v2.0 Phase 3 — UIA-pick (textual Set-of-Marks). When UIA had
  //      candidates but matchUiaElement returned none, ask the vision
  //      model to PICK from the candidate list with the screenshot as
  //      visual context. Coords come from UIA's bbox (zero pixel
  //      error when the model picks correctly); falls through to
  //      free-form vision-locate when the model says "none".
  //
  //      Reached when control falls through step 0.5 — which happens
  //      for `auto` mode always, for `uia-then-vision` mode always
  //      (well, until the gate below excludes it), and for forced
  //      `sonnet-computer-use` only when the route capability gate
  //      didn't apply (forced-no-commit aborts above, before getting
  //      here). Skipped when UIA returned zero elements (vision-only
  //      is the only remaining path) or when the user explicitly
  //      forced `uia-then-vision` (that mode's contract is "run the
  //      v1.x baseline" — inserting an LLM round-trip would violate
  //      the user's opt-out).
  if (uiaElements.length > 0 && mode !== 'uia-then-vision') {
    pushProgress(`Picking from ${uiaElements.length} candidates…`)
    try {
      const pickShot = await getShot()
      const pick = await locateViaUiaPick({
        shot: pickShot,
        description: what,
        elements: uiaElements,
        signal: args.signal
      })
      if (pick.predicted && pick.pickedElement) {
        log(
          'success',
          'automation',
          `[visual-click] uia-pick → "${pick.pickedElement.name || pick.pickedElement.automationId}" (${pick.pickedElement.controlType}) at (${pick.predicted.x}, ${pick.predicted.y}) in ${pick.msElapsed}ms`
        )
        pushProgress(`Found "${pick.pickedElement.name || what}" — confirm to click…`)
        return await fireClick({
          x: pick.predicted.x,
          y: pick.predicted.y,
          description: what,
          confidence: UIA_PICK_DEFAULT_CONFIDENCE,
          button,
          sourceLabel: pick.pickedElement.name || pick.pickedElement.automationId || 'uia-pick',
          source: 'uia',
          totalStartedAt: startedAt
        })
      }
      log(
        'info',
        'automation',
        `[visual-click] uia-pick didn't commit (${pick.trail}) — falling to vision`
      )
    } catch (err) {
      log(
        'warn',
        'automation',
        `[visual-click] uia-pick threw: ${err instanceof Error ? err.message : String(err)} — falling to vision`
      )
    }
  }

  // 1) Screenshot. (vision fallback) — pulls the cached shot when the
  //    router branch already captured, else captures fresh.
  pushProgress(`Asking the model where to click "${what}"…`)
  let shot: CapturedScreen
  try {
    shot = await getShot()
    log(
      'info',
      'automation',
      `[visual-click] vision fallback shot ${shot.width}×${shot.height} (display ${shot.displayWidth}×${shot.displayHeight}, origin ${shot.windowOriginX}, ${shot.windowOriginY}${cachedShot ? ', reused' : ''})`
    )
  } catch (err) {
    return failWithToast(
      what,
      `Screen capture failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const windowOriginX = shot.windowOriginX
  const windowOriginY = shot.windowOriginY

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
 * v2.0 Phase 2 — ask Sonnet (computer-use) for the click coord using
 * the shared lazy screenshot, then route into the preview-and-click
 * tail. Returns:
 *   - ActionResult on a successful (or user-cancelled) click
 *   - null when computer-use didn't commit — caller falls through to
 *     the UIA+vision baseline
 *
 * Takes `getShot` rather than capturing internally so the baseline
 * vision fallback (which may run if Sonnet doesn't commit) reuses the
 * same NativeImage — without this, a Sonnet-no-commit click paid for
 * two compositor flushes + two PNG encodes + two disk writes.
 */
async function routeViaComputerUse(args: {
  what: string
  button: 'left' | 'right'
  getShot: () => Promise<CapturedScreen>
  modelId: string
  signal?: AbortSignal
  totalStartedAt: number
}): Promise<ActionResult | null> {
  pushProgress(`Asking Sonnet to click "${args.what}"…`)
  let shot: CapturedScreen
  try {
    shot = await args.getShot()
  } catch (err) {
    log(
      'warn',
      'automation',
      `[visual-click] computer-use route capture failed: ${err instanceof Error ? err.message : String(err)} — falling back to baseline`
    )
    return null
  }
  const result = await locateViaComputerUse({
    shot,
    description: args.what,
    modelId: args.modelId,
    signal: args.signal
  })
  if (!result.predicted) {
    log(
      'info',
      'automation',
      `[visual-click] computer-use didn't commit: ${result.trail} — falling back to baseline`
    )
    return null
  }
  log(
    'success',
    'automation',
    `[visual-click] computer-use → (${result.predicted.x}, ${result.predicted.y}) via ${args.modelId} in ${result.msElapsed}ms`
  )
  pushProgress(`Sonnet located "${args.what}" — confirm to click…`)
  return fireClick({
    x: result.predicted.x,
    y: result.predicted.y,
    description: args.what,
    confidence: COMPUTER_USE_DEFAULT_CONFIDENCE,
    button: args.button,
    sourceLabel: 'sonnet computer-use',
    source: 'vision',
    totalStartedAt: args.totalStartedAt,
    extraData: { screenshotPath: shot.path, engine: 'sonnet-computer-use' }
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
    output: extra?.output ?? `Couldn't click "${description}" — ${reason}`,
    error: reason,
    data: extra?.data
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
