/**
 * Screen capture. Uses Electron's desktopCapturer so it works cross-platform
 * without spawning external processes. The image is written to the user-data
 * directory and also returned as a data URL ready for AI vision requests.
 */
import { desktopCapturer, screen } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPath } from '../storage/store'
import type { ScreenshotResult } from '@shared/types'

export async function captureScreen(): Promise<ScreenshotResult> {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  const width = Math.round(display.size.width * scale)
  const height = Math.round(display.size.height * scale)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  if (sources.length === 0) {
    throw new Error('No screen source is available to capture.')
  }

  const image = sources[0].thumbnail
  const png = image.toPNG()
  const size = image.getSize()

  const dir = dataPath('screenshots')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `shot-${Date.now()}.png`)
  await writeFile(file, png)

  return {
    path: file,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height
  }
}
