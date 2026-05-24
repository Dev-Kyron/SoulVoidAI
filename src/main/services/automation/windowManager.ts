/**
 * v1.10.0 — visible-window enumeration + foreground control.
 *
 * Reads the list of every visible top-level window (title, owning process,
 * screen-coordinate bounds, whether it's currently foreground) via Get-Process
 * + User32 GetWindowRect. Used by click_on_screen's `in_window` parameter to
 * dramatically improve multi-window accuracy:
 *
 *   1. Enumerate windows
 *   2. Fuzzy-match the user's `in_window` hint ("Messenger") against titles
 *   3. SetForegroundWindow(matched.hwnd) so the target app is active and visible
 *   4. Scope UIA + screenshot to JUST that window
 *   5. Click within its bounds
 *
 * Without window-aware scoping, having Discord + Messenger + a browser open
 * simultaneously made vision-locate confuse "Send button" across them. With
 * scoping, the model only sees the chosen window's content — no false
 * positives possible from neighbouring apps.
 *
 * Why Get-Process instead of EnumWindows: Get-Process gives us MainWindow
 * Handle + MainWindowTitle directly without needing an EnumWindows callback
 * (which is tricky to bridge through PowerShell's COM marshalling). Catches
 * every "real" top-level window the user could click in, and skips
 * windowless background processes for free.
 *
 * SetForegroundWindow caveat: Windows restricts foreground stealing — the
 * call fails silently if the calling process isn't already in foreground or
 * recently received user input. The well-known workaround is to send Alt
 * first (which "releases" the foreground lock), then SetForegroundWindow.
 * `focusWindow` does both.
 */
import {
  runPowerShell,
  runPowerShellCapturing,
  DEFAULT_EXCLUDE_PROCESS_NAMES
} from './powershell'

const ENUM_TIMEOUT_MS = 3_000
const FOCUS_TIMEOUT_MS = 2_000

export interface WindowInfo {
  /** Native window handle as 64-bit number (PowerShell IntPtr value). Opaque to callers; only used as a token to pass back to focusWindow. */
  hwnd: number
  /** The window's main caption — what shows in Alt-Tab / taskbar. */
  title: string
  /** Owning process name (e.g. "opera", "Discord", "Code"). Lowercase. */
  processName: string
  /** Screen-coordinate bounds in LOGICAL pixels. */
  x: number
  y: number
  w: number
  h: number
  /** True if this window is the foreground window right now. */
  focused: boolean
}

/**
 * Returns every visible top-level window with a non-empty title. Excludes
 * processes whose names appear in `exclude` (case-insensitive) so VoidSoul's
 * own windows don't pollute results. Returns [] on non-Windows / on
 * enumeration failure.
 */
export async function enumerateWindows(
  excludeProcessNames: readonly string[] = DEFAULT_EXCLUDE_PROCESS_NAMES
): Promise<WindowInfo[]> {
  if (process.platform !== 'win32') return []
  const exclude = excludeProcessNames.map((n) => n.toLowerCase()).join(',')
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinM {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$exclude = @('${exclude}' -split ',')
$fg = [WinM]::GetForegroundWindow()
$out = New-Object System.Collections.Generic.List[Object]
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $name = $_.ProcessName.ToLower()
  $skip = $false
  foreach ($e in $exclude) { if ($name -eq $e) { $skip = $true; break } }
  if ($skip) { return }
  if ([WinM]::IsIconic($_.MainWindowHandle)) { return }
  $rect = New-Object WinM+RECT
  if (-not [WinM]::GetWindowRect($_.MainWindowHandle, [ref]$rect)) { return }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 1 -or $h -le 1) { return }
  $out.Add([PSCustomObject]@{
    hwnd = $_.MainWindowHandle.ToInt64()
    title = $_.MainWindowTitle
    process = $name
    x = $rect.Left
    y = $rect.Top
    w = $w
    h = $h
    focused = ($_.MainWindowHandle -eq $fg)
  }) | Out-Null
}
$out | ConvertTo-Json -Depth 1 -Compress
`
  try {
    const stdout = await runPowerShellCapturing(script, {
      timeoutMs: ENUM_TIMEOUT_MS
    })
    return parseWindowList(stdout)
  } catch {
    return []
  }
}

/**
 * Brings the supplied window to foreground. Sends Alt first to release the
 * Windows foreground-stealing-prevention lock — without it,
 * SetForegroundWindow silently fails when VoidSoul (the calling process)
 * isn't already foreground. Also restores the window if minimised.
 *
 * Returns true if the focus call succeeded (best-effort — the OS won't
 * always confirm), false on non-Windows / on PowerShell failure.
 */
export async function focusWindow(hwnd: number): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!Number.isFinite(hwnd) || hwnd <= 0) return false
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinF {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$h = [IntPtr]${hwnd}
# Restore the window first if minimised. SW_RESTORE = 9.
if ([WinF]::IsIconic($h)) { [void][WinF]::ShowWindow($h, 9) }
# Alt-key trick to release Windows' foreground-lock so a non-foreground
# process (us) is allowed to call SetForegroundWindow on someone else.
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 40
[void][WinF]::SetForegroundWindow($h)
`
  try {
    await runPowerShell(script, { timeoutMs: FOCUS_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * Parses the PowerShell ConvertTo-Json output into a typed window list.
 * Tolerates single-object output (PowerShell quirk) and BOM. Exported
 * for unit tests.
 */
export function parseWindowList(raw: string): WindowInfo[] {
  const trimmed = raw.trim().replace(/^﻿/, '')
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: WindowInfo[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const hwnd = Number(o.hwnd)
    const x = Number(o.x)
    const y = Number(o.y)
    const w = Number(o.w)
    const h = Number(o.h)
    if (!Number.isFinite(hwnd) || !Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(w) || !Number.isFinite(h)) continue
    out.push({
      hwnd,
      title: String(o.title ?? ''),
      processName: String(o.process ?? '').toLowerCase(),
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      focused: o.focused === true
    })
  }
  return out
}
