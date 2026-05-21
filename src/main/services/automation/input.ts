/**
 * Low-level input synthesis — mouse movement, clicks and keyboard shortcuts.
 * Implemented on Windows via short PowerShell snippets so no native module or
 * rebuild step is required. Other platforms throw a clear "unsupported" error.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

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
  await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`
  )
}

export async function mouseClick(button: 'left' | 'right'): Promise<void> {
  assertWindows('Mouse clicks')
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
