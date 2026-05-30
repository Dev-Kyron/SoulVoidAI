/**
 * Shared screen-capture utility — single source of truth for the projection
 * math that the click pipeline (visualClick.ts) and the bench harness
 * (clickBench/locate.ts) both depend on.
 *
 * Before v2.0 Phase 1 polish, capture lived in two places: visualClick's
 * `captureForVisualClick`/`captureForWindow` and clickBench's
 * `captureForBench`. The two duplicated `SCREENSHOT_TARGET_WIDTH`,
 * `REFINE_CROP`, the resolution cap, the window-crop math, and the on-disk
 * filenames — drift between them would silently make bench numbers diverge
 * from production user-facing behaviour. Now both call into here.
 *
 * The constants live here too so a change to the wire-cost cap (or the
 * refinement crop) is impossible to forget in one path.
 */
import { desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../storage/store'

/**
 * Screenshot target width in LOGICAL pixels. v1.8.0 used 1600 to cap wire
 * cost, but beta showed the model returns coordinates off by 30-80 pixels
 * on small targets (chat send buttons, toolbar icons) at that resolution.
 * v1.8.1 raised the cap to 2400 — most desktops are 1920×1080, so this
 * effectively means "no downscale" for the common case and a modest
 * downscale on 4K. Worth the extra ~150KB of base64 payload per call.
 */
export const SCREENSHOT_TARGET_WIDTH = 2400

/**
 * Two-pass refinement crop size. After the first locate predicts a point,
 * we crop a REFINE_CROP×REFINE_CROP region centred on it and ask the
 * model to refine. 500 is wide enough to keep the target in frame even
 * if the first pass was 200px off, but narrow enough that the model
 * sees the target at ~5× higher effective pixel density (since the
 * vision input is normalised to a fixed resolution by every provider).
 */
export const REFINE_CROP = 500

export interface CapturedScreen {
  /** Source NativeImage — kept so the refinement pass can crop without
   *  needing a second screen capture (faster + guarantees the crop matches
   *  what was located against). */
  image: NativeImage
  dataUrl: string
  /** Screenshot pixel dimensions (downscaled). */
  width: number
  height: number
  /** Logical display (or window) dimensions, used to project model coords
   *  back to the cursor coordinate space. When windowed, this is the
   *  window's logical bounds — NOT the display's — so the projection runs
   *  in window-local space; caller adds windowOrigin{X,Y} to land at an
   *  absolute screen position. */
  displayWidth: number
  displayHeight: number
  /** On-disk path so the screenshot is auditable later (debug + review). */
  path: string
  /** Origin offset to add when projecting back to display space. Zero for
   *  global captures; the window's (x, y) for windowed captures. */
  windowOriginX: number
  windowOriginY: number
}

export interface CaptureOptions {
  /** When set, the capture is cropped to these LOGICAL display-pixel
   *  bounds. Coords come back in window-local space; caller projects via
   *  `displayWidth/Height` and then adds `windowOriginX/Y` to get the
   *  absolute cursor position. Omit for a full-display capture. */
  window?: { x: number; y: number; w: number; h: number } | null
  /** Subdirectory under userData for the saved PNG. Defaults to
   *  `visual-click` to match the legacy path; the bench harness passes
   *  `clickbench/shots` to keep its captures separate. */
  saveSubdir?: string
  /**
   * v2.0 polish — write the PNG to disk for audit. Defaults to false:
   * the production click pipeline can fire ~50 times/day at ~1-2MB per
   * shot, which accrues to multi-GB/year with no consumer (the click
   * trail string carries the actually-useful diagnostic). Opt-in via
   * the visualClick-audit setting (or the bench dialog's debug knob)
   * when you genuinely need the pixels for forensics.
   *
   * When false, `path` is the empty string.
   */
  persist?: boolean
}

/**
 * Capture the primary display (or a window crop of it) and persist the PNG
 * to disk for audit. Returns the NativeImage so callers can re-crop for
 * refinement without a second compositor round-trip.
 *
 * Multi-monitor note: only the primary display is captured. The capture
 * dialog warns the user when other displays are present; cross-monitor
 * targeting is out-of-scope for v2.0.
 */
export async function captureScreen(opts: CaptureOptions = {}): Promise<CapturedScreen> {
  const display = screen.getPrimaryDisplay()
  // Logical width — Windows reports this even on a 200%-scaled monitor (e.g.
  // a 4K 200% display reports 1920x1080 here). We downscale further for the
  // wire-cost cap but keep the projection math in logical space.
  const logicalW = display.size.width
  const logicalH = display.size.height
  const targetW = Math.min(SCREENSHOT_TARGET_WIDTH, logicalW)
  const ratio = targetW / Math.max(1, logicalW)
  const targetH = Math.round(logicalH * ratio)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  })
  if (sources.length === 0) throw new Error('No screen source available.')

  let image = sources[0].thumbnail
  let outW = targetW
  let outH = targetH
  let outDisplayW = logicalW
  let outDisplayH = logicalH
  let windowOriginX = 0
  let windowOriginY = 0
  if (opts.window) {
    const w = opts.window
    const cropX = Math.max(0, Math.round(w.x * ratio))
    const cropY = Math.max(0, Math.round(w.y * ratio))
    const cropW = Math.min(targetW - cropX, Math.round(w.w * ratio))
    const cropH = Math.min(targetH - cropY, Math.round(w.h * ratio))
    if (cropW <= 0 || cropH <= 0) {
      throw new Error('Window bounds intersect screen at zero pixels.')
    }
    image = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
    const size = image.getSize()
    outW = size.width
    outH = size.height
    // v2.0 polish — outDisplayW/H must reflect the ACTUALLY CROPPED logical
    // bounds, not the REQUESTED window rect. The previous version kept the
    // un-clamped w.w / w.h here, so when a window extended past the screen
    // edge the projection ratio (outW / outDisplayW) diverged between axes.
    // A click coord predicted relative to the cropped screenshot then
    // projected by w.w landed outside the visible region (window at
    // 1800,0 size 300x600 on a 1920x1080 → cropped to 120 logical, but
    // outDisplayW stayed 300 → projected click at logical X ≈ 2100).
    // Clamp the same way cropW/cropH are clamped, then back-project from
    // target-pixel space to logical bounds.
    const clampedLogicalX = Math.max(0, w.x)
    const clampedLogicalY = Math.max(0, w.y)
    outDisplayW = Math.min(logicalW - clampedLogicalX, w.w - (clampedLogicalX - w.x))
    outDisplayH = Math.min(logicalH - clampedLogicalY, w.h - (clampedLogicalY - w.y))
    windowOriginX = clampedLogicalX
    windowOriginY = clampedLogicalY
  }

  const png = image.toPNG()
  let filePath = ''
  // v2.0 polish — persist flipped to opt-in. The production click
  // pipeline used to default true, accruing ~10-40GB/year of audit
  // PNGs with no consumer. Bench was already opt-out. Now both
  // require an explicit `persist: true`.
  if (opts.persist === true) {
    const subdir = opts.saveSubdir ?? 'visual-click'
    const dir = dataPath(...subdir.split('/'))
    await mkdir(dir, { recursive: true })
    filePath = join(dir, `target-${Date.now()}.png`)
    await writeFile(filePath, png)
  }

  return {
    image,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: outW,
    height: outH,
    displayWidth: outDisplayW,
    displayHeight: outDisplayH,
    path: filePath,
    windowOriginX,
    windowOriginY
  }
}

/**
 * Logical dimensions of the primary display. Surfaces multi-monitor
 * detection too — callers (the capture dialog) warn the user when more
 * than one display is connected so the captured ground truth doesn't
 * mislead a multi-monitor user later.
 */
export function getPrimaryDisplayInfo(): {
  logicalWidth: number
  logicalHeight: number
  displayCount: number
} {
  const display = screen.getPrimaryDisplay()
  return {
    logicalWidth: display.size.width,
    logicalHeight: display.size.height,
    displayCount: screen.getAllDisplays().length
  }
}
