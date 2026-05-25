/**
 * Low-level input synthesis — mouse movement, clicks and keyboard shortcuts.
 * Implemented on Windows via short PowerShell snippets so no native module or
 * rebuild step is required. Other platforms throw a clear "unsupported" error.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { screen } from 'electron'

const execAsync = promisify(exec)

/**
 * v1.12.3 — virtual desktop bounds for clamping mouse coords. Pulled
 * lazily on each move because the OS can hot-add/remove displays at
 * runtime (laptop docking, second monitor unplugged) and we'd rather
 * pay the ~0.1ms lookup than show the user an off-screen click.
 *
 * Returns the union rect of every connected display. SetCursorPos
 * outside this rect either no-ops (Windows clamps internally) or
 * lands on the nearest display edge in unpredictable ways — we'd
 * rather clip explicitly + log so a runaway agent's (-99999, -50)
 * doesn't fire mouse events into the void.
 */
function virtualDesktopRect(): { minX: number; minY: number; maxX: number; maxY: number } {
  const displays = screen.getAllDisplays()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const d of displays) {
    const b = d.bounds
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.width > maxX) maxX = b.x + b.width
    if (b.y + b.height > maxY) maxY = b.y + b.height
  }
  // Fall back to a sane single-monitor rect if `getAllDisplays` ever returns
  // an empty array (shouldn't happen with a display attached, but defensive
  // code is cheap here).
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1920, maxY: 1080 }
  return { minX, minY, maxX, maxY }
}

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function runPowerShell(script: string): Promise<void> {
  await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(script)}`, {
    windowsHide: true
  })
}

function assertWindows(feature: string): void {
  if (process.platform !== 'win32') {
    throw new Error(`${feature} is currently implemented for Windows only.`)
  }
}

export async function moveMouse(x: number, y: number): Promise<void> {
  assertWindows('Cursor control')
  // v1.12.3 — clamp to the virtual desktop rect. Without this, an agent
  // passing nonsense coordinates like (-99999, -50) or (99999, 99999)
  // would silently fire mouse events into limbo OR onto unintended
  // displays. Clamping at the boundary turns "off-screen" into "at the
  // edge of the nearest display" which is harmless + visible.
  const rect = virtualDesktopRect()
  const clampedX = Math.min(Math.max(Math.round(x), rect.minX), rect.maxX - 1)
  const clampedY = Math.min(Math.max(Math.round(y), rect.minY), rect.maxY - 1)
  await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${clampedX}, ${clampedY})`
  )
}

/**
 * v1.12.4 — mouse-click rate limit. A runaway agent in a tight loop
 * could click hundreds of times before the user notices. 10 clicks per
 * second is well above any plausible legitimate burst (the fastest UI
 * automation case is ~3-5 clicks for a drag-and-drop sequence) while
 * being low enough that a runaway loop hits the limit and surfaces a
 * clear error to the user before any real damage.
 *
 * Sliding window: we keep timestamps of clicks within the last 1000ms
 * and refuse the next click when the window is already full. Shift the
 * oldest entries out as time advances so a burst doesn't get
 * permanently penalised.
 */
const MAX_CLICKS_PER_SEC = 10
const clickWindow: number[] = []

function enforceClickRateLimit(): void {
  const now = Date.now()
  while (clickWindow.length > 0 && clickWindow[0] < now - 1000) {
    clickWindow.shift()
  }
  if (clickWindow.length >= MAX_CLICKS_PER_SEC) {
    throw new Error(
      `Mouse click rate limit hit (${MAX_CLICKS_PER_SEC}/sec). This is usually a sign of a runaway agent loop — review the conversation and stop the run if needed.`
    )
  }
  clickWindow.push(now)
}

export async function mouseClick(button: 'left' | 'right'): Promise<void> {
  assertWindows('Mouse clicks')
  enforceClickRateLimit()
  const down = button === 'right' ? '0x0008' : '0x0002'
  const up = button === 'right' ? '0x0010' : '0x0004'
  await runPowerShell(
    `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VoidSoulMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
"@
[VoidSoulMouse]::mouse_event(${down}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[VoidSoulMouse]::mouse_event(${up}, 0, 0, 0, [IntPtr]::Zero)`
  )
}

const NAMED_KEYS: Record<string, string> = {
  enter: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  space: ' ',
  del: '{DEL}',
  delete: '{DEL}',
  backspace: '{BACKSPACE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  insert: '{INSERT}'
}

/** Converts a human combo like `ctrl+shift+p` to a SendKeys sequence. */
function toSendKeys(combo: string): string {
  let modifiers = ''
  let key = ''
  for (const raw of combo.toLowerCase().split('+')) {
    const part = raw.trim()
    if (!part) continue
    if (part === 'ctrl' || part === 'control') modifiers += '^'
    else if (part === 'alt') modifiers += '%'
    else if (part === 'shift') modifiers += '+'
    else if (part === 'win' || part === 'cmd' || part === 'meta') {
      // SendKeys cannot synthesise the Windows key — ignore it.
    } else if (NAMED_KEYS[part]) key = NAMED_KEYS[part]
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) key = `{${part.toUpperCase()}}`
    else key = part
  }
  if (!key) throw new Error(`Hotkey "${combo}" has no main key.`)
  return modifiers + key
}

export async function sendHotkey(combo: string): Promise<string> {
  assertWindows('Keyboard shortcuts')
  const sequence = toSendKeys(combo).replace(/'/g, "''")
  await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      'Start-Sleep -Milliseconds 300; ' +
      `[System.Windows.Forms.SendKeys]::SendWait('${sequence}')`
  )
  return combo
}
