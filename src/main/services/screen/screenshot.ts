/**
 * Screen capture. Uses Electron's desktopCapturer so it works cross-platform
 * without spawning external processes. The image is written to the user-data
 * directory and also returned as a data URL ready for AI vision requests.
 *
 * v1.12.3 — multi-monitor support. The previous version captured ONLY the
 * primary display, so anything the user was actually looking at on a
 * secondary monitor was invisible to OCR / vision / screen-watch. Now we
 * enumerate every connected display, pick the one containing the cursor
 * (best guess at "what the user is looking at"), and cap the thumbnail
 * at a reasonable resolution so a 4K@200% display doesn't produce a 30MB
 * PNG that stalls IPC.
 *
 * v2.0 polish — added `persist` option (default true for back-compat) and
 * a janitor that caps the screenshots dir at MAX_PERSISTED. The semantic-
 * awareness loop fires every window change and was accruing ~1-2MB PNGs
 * indefinitely with no consumer — passing `persist: false` skips the
 * write entirely and OCR runs against the data URL instead.
 */
import { desktopCapturer, screen } from 'electron'
import { writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../storage/store'
import { log } from '../logger'
import type { ScreenshotResult } from '@shared/types'

/** Cap thumbnails at 2400 wide. Vision-model input limits + IPC payload
 *  sanity. A 4K display at 200% scaling natively renders 7680×4320 — way
 *  past anything we'd want to ship over IPC or feed into a vision API. */
const MAX_THUMBNAIL_WIDTH = 2400

/** Keep at most this many persisted shots in the screenshots dir. Older
 *  files get pruned best-effort after a successful write. Stops the dir
 *  from growing without bound for callers that legitimately persist
 *  (manual `screen:capture` IPC, debug-audit knobs). */
const MAX_PERSISTED = 50

export interface CaptureScreenOptions {
  /** Write the PNG to disk under userData/screenshots. Defaults to true
   *  so callers that depended on `path` keep working — semantic awareness
   *  passes `false` because it only needs the data URL for OCR. */
  persist?: boolean
}

export async function captureScreen(opts: CaptureScreenOptions = {}): Promise<ScreenshotResult> {
  const persist = opts.persist !== false
  // v1.12.3 — pick the display under the cursor as a best guess at "what
  // the user is currently looking at". Falls back to the primary display
  // if the cursor is between monitors or on an unrecognised display.
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  const nativeWidth = Math.round(display.size.width * scale)
  const nativeHeight = Math.round(display.size.height * scale)

  // Scale down if the native resolution exceeds our cap. Preserves aspect
  // ratio so vision input geometry stays accurate.
  const widthScale = nativeWidth > MAX_THUMBNAIL_WIDTH ? MAX_THUMBNAIL_WIDTH / nativeWidth : 1
  const thumbWidth = Math.round(nativeWidth * widthScale)
  const thumbHeight = Math.round(nativeHeight * widthScale)

  // Find the source for THIS display. Electron's desktopCapturer returns
  // every screen source; the order is platform-dependent so we match by
  // display id, falling back to source[0] when matching fails.
  //
  // v1.12.5 — explicitly handle the case where `display_id` is undefined
  // on ALL sources (older Electron versions, Wayland, some Linux X11
  // configs). Previously `String(undefined) === '${id}'` always evaluated
  // false, so the find quietly returned the first source AND silently
  // captured the primary display regardless of cursor location —
  // defeating the multi-monitor rewrite's purpose without any signal.
  // Now we log a warning so users on affected platforms can see why
  // captures aren't following the cursor.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbWidth, height: thumbHeight }
  })
  if (sources.length === 0) {
    throw new Error('No screen source is available to capture.')
  }
  const hasIds = sources.some((s) => s.display_id != null && s.display_id !== '')
  let source = sources[0]
  if (hasIds) {
    const matched = sources.find((s) => String(s.display_id) === String(display.id))
    if (matched) {
      source = matched
    } else if (sources.length > 1) {
      log(
        'warn',
        'system',
        `screenshot: no source matched display ${display.id}; falling back to sources[0] (might capture wrong monitor).`
      )
    }
  } else if (sources.length > 1) {
    log(
      'warn',
      'system',
      'screenshot: desktopCapturer sources lack display_id on this platform; multi-monitor capture falls back to primary display.'
    )
  }

  const image = source.thumbnail
  const png = image.toPNG()
  const size = image.getSize()

  let file = ''
  if (persist) {
    const dir = dataPath('screenshots')
    await mkdir(dir, { recursive: true })
    file = join(dir, `shot-${Date.now()}.png`)
    await writeFile(file, png)
    // Best-effort prune so the dir doesn't grow without bound. Awaited so a
    // burst of captures can't pile up writes faster than we trim, but
    // failures are swallowed — pruning is non-essential.
    await pruneOldShots(dir).catch((err) => {
      log(
        'warn',
        'system',
        `screenshot: prune failed (${err instanceof Error ? err.message : String(err)}) — dir may grow.`
      )
    })
  }

  return {
    path: file,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height
  }
}

/**
 * Delete the oldest PNGs in `dir` until at most MAX_PERSISTED remain. Best
 * effort — any individual unlink failure is logged and skipped so a locked
 * file (anti-virus scan, explorer preview) can't stall the loop.
 */
async function pruneOldShots(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const pngs = names.filter((n) => n.endsWith('.png'))
  if (pngs.length <= MAX_PERSISTED) return
  const entries = await Promise.all(
    pngs.map(async (name) => {
      try {
        const s = await stat(join(dir, name))
        return { name, mtime: s.mtimeMs }
      } catch {
        return null
      }
    })
  )
  const ranked = entries
    .filter((e): e is { name: string; mtime: number } => e != null)
    .sort((a, b) => a.mtime - b.mtime)
  const excess = ranked.length - MAX_PERSISTED
  if (excess <= 0) return
  await Promise.all(
    ranked.slice(0, excess).map((e) =>
      unlink(join(dir, e.name)).catch(() => {
        /* swallow — file may already be gone or AV-locked */
      })
    )
  )
}
