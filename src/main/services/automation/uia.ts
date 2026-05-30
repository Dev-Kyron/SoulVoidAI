/**
 * v1.9.0 — Windows UI Automation enumerator.
 *
 * Reads the accessibility tree of every visible top-level window via the
 * built-in System.Windows.Automation .NET assemblies (PowerShell). Each
 * clickable element exposes its accessibility Name (the same string that
 * appears as a tooltip on hover), AutomationId, ControlType, and a
 * screen-coordinate BoundingRectangle — exactly what we need to click an
 * icon-only button that vision-locate would miss.
 *
 * Why this matters: most apps that use stock UI frameworks (UWP, WPF,
 * Win32, Electron, Chromium) populate the UIA tree automatically. A
 * Messenger send button rendered as a paper-plane icon has Name="Send"
 * or HelpText="Press enter to send" — vision can't read the icon, but
 * UIA reads the tooltip directly. 100% accurate, ~100-300ms, free.
 *
 * Why we still keep vision: not every target is in the UIA tree. Custom-
 * rendered UIs (games, canvas-based apps, screenshots-of-things, browser
 * web content with accessibility disabled) need pixel-level locate. The
 * orchestrator falls back to the vision pipeline whenever UIA returns
 * nothing or returns ambiguous results.
 *
 * Architecture:
 *  - We exclude our own Electron windows by process name so VoidSoul's
 *    own UI tree doesn't pollute results.
 *  - We cap walker depth so a deeply-nested tree (Visual Studio is 20+)
 *    doesn't take seconds. Most clickable buttons live in the first 5-7
 *    layers; descending deeper would only catch leaf decorations.
 *  - We filter offscreen / disabled / zero-bounds elements at PowerShell
 *    time so the TypeScript matcher never sees garbage candidates.
 */
import { runPowerShellCapturing, DEFAULT_EXCLUDE_PROCESS_NAMES } from './powershell'

/** Default walker depth. Enough to catch buttons inside common nested
 *  layouts (toolbar > stack > group > button = depth 4) without descending
 *  into per-pixel decorations on rich UIs. */
const DEFAULT_MAX_DEPTH = 6

/** Hard cap on how long PowerShell can chew on UIA. The walker can stall
 *  on misbehaving apps; 2.5s enumerates a normal desktop comfortably
 *  (~200-800ms) but fails fast enough that the vision fallback feels
 *  snappy if the walker hangs. */
const TIMEOUT_MS = 2_500

export interface UiaElement {
  /** Accessibility name — the tooltip / aria-label string. Often the
   *  best signal for what the user described. */
  name: string
  /** Stable element id set by the app developer (rare on web content,
   *  common in native apps). Useful for exact matches. */
  automationId: string
  /** UIA control type ("ControlType.Button", "ControlType.Hyperlink",
   *  "ControlType.Text", etc). Used to bias toward clickable controls. */
  controlType: string
  /** Screen-coordinate bounds. x/y is top-left in LOGICAL pixels —
   *  same coordinate space PowerShell's Cursor::Position takes, so we
   *  can click center = (x + w/2, y + h/2) without DPI math. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * Walks visible top-level windows' UIA trees and returns clickable elements.
 *
 * v1.10.0 — `targetHwnd` scopes enumeration to a SINGLE window. When the
 * user has multiple windows open and the AI has already identified which
 * one the click is for (via the `in_window` parameter to click_on_screen),
 * walking only that window's tree both speeds up enumeration AND eliminates
 * cross-window false positives (a "Send" element in Discord can't match
 * when the user asked for "Send in Messenger").
 *
 * When `targetHwnd` is null/omitted, walks every visible top-level window
 * (the original v1.9.x behaviour) for backwards-compatible callers that
 * don't know which window matters.
 *
 * `excludeProcessNames` still filters even when targetHwnd is set — it's
 * a no-op in that case (only one hwnd is walked) but kept for symmetry.
 */
export async function enumerateClickableElements(
  excludeProcessNames: readonly string[] = DEFAULT_EXCLUDE_PROCESS_NAMES,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  targetHwnd?: number | null
): Promise<UiaElement[]> {
  if (process.platform !== 'win32') return []

  // The PowerShell script is intentionally compact + defensive. UIA calls
  // throw `COMException` on elements that disappear mid-walk; we catch
  // and continue so a single rogue element doesn't abort the whole scan.
  // Output is a JSON array — one line, compressed, parsed by the caller.
  const exclude = excludeProcessNames.map((n) => n.toLowerCase()).join(',')
  // v1.10.0 — targetHwnd path: walk ONLY that window's tree. Skips
  // foreach-windows loop and the per-window process exclusion check
  // (we know which window we want; exclusion only matters for global
  // enumeration). Passed as 0 sentinel when omitted so PowerShell can
  // simple-check via `-eq 0`.
  const hwndArg = targetHwnd && Number.isFinite(targetHwnd) ? Math.round(targetHwnd) : 0
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
}
"@
$exclude = @('${exclude}' -split ',')
$maxDepth = ${maxDepth}
$targetHwnd = ${hwndArg}
$out = New-Object System.Collections.Generic.List[Object]
function ShouldSkipWindow($win) {
  $h = $win.Current.NativeWindowHandle
  if ($h -eq 0) { return $true }
  $pid_local = 0
  [void][W]::GetWindowThreadProcessId([IntPtr]$h, [ref]$pid_local)
  if ($pid_local -eq 0) { return $true }
  try {
    $p = Get-Process -Id $pid_local -ErrorAction Stop
    foreach ($e in $exclude) { if ($p.ProcessName.ToLower() -eq $e) { return $true } }
  } catch { return $true }
  if (-not [W]::IsWindowVisible([IntPtr]$h)) { return $true }
  return $false
}
function Walk($elem, $depth) {
  if ($depth -gt $maxDepth) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try { $child = $walker.GetFirstChild($elem) } catch { return }
  while ($child -ne $null) {
    try {
      $c = $child.Current
      if (-not $c.IsOffscreen -and $c.IsEnabled) {
        $r = $c.BoundingRectangle
        if ($r.Width -gt 0 -and $r.Height -gt 0) {
          if ($c.Name -or $c.AutomationId -or $c.HelpText) {
            $out.Add([PSCustomObject]@{
              name = $c.Name
              automationId = $c.AutomationId
              controlType = $c.ControlType.ProgrammaticName
              x = [int]$r.X
              y = [int]$r.Y
              w = [int]$r.Width
              h = [int]$r.Height
            }) | Out-Null
          }
        }
      }
      Walk $child ($depth + 1)
    } catch {}
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}
try {
  if ($targetHwnd -ne 0) {
    # Scoped enumeration — only the supplied window's tree.
    $target = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$targetHwnd)
    if ($target -ne $null) { Walk $target 0 }
  } else {
    # Global enumeration — every visible top-level window (legacy v1.9.x path).
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $windows) {
      if (ShouldSkipWindow $w) { continue }
      Walk $w 0
    }
  }
} catch {}
$out | ConvertTo-Json -Depth 1 -Compress
`

  try {
    const stdout = await runPowerShellCapturing(script, {
      timeoutMs: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })
    return parseUiaJson(stdout)
  } catch {
    // Timeout / PowerShell crash / no .NET — return empty so vision-locate
    // picks up the slack. Logging is the orchestrator's job.
    return []
  }
}

/**
 * v2.0 Phase 4 — UIA element-at-point lookup. Given screen coordinates
 * (LOGICAL pixels — same space `enumerateClickableElements` returns
 * and Cursor::Position takes), returns the UIA element directly under
 * that point, or null when none / off-Windows / UIA can't reach.
 *
 * Used by hover-to-teach: user demonstrates a click → we capture
 * cursor pos via Electron's `screen.getCursorScreenPoint()` → call
 * this to identify which UI element they targeted → store
 * (description, name, controlType, automationId) so future identical
 * descriptions short-circuit straight to a UIA click with zero model
 * calls.
 *
 * Walks UIA's TreeWalker UP from the FromPoint result until we find
 * an element with a non-empty Name OR a recognised clickable
 * ControlType — the leaf at the click point is often a structural
 * Text/Image inside the actual button.
 */
export async function elementAtPoint(x: number, y: number): Promise<UiaElement | null> {
  if (process.platform !== 'win32') return null
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch { return }
$point = New-Object System.Windows.Point(${Math.round(x)}, ${Math.round(y)})
$el = $null
try { $el = [System.Windows.Automation.AutomationElement]::FromPoint($point) } catch { return }
if (-not $el) { return }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$clickable = @(
  'Button','SplitButton','MenuItem','Hyperlink','TabItem',
  'CheckBox','RadioButton','ListItem','TreeItem'
)
$current = $el
$best = $null
for ($i = 0; $i -lt 6; $i++) {
  if (-not $current) { break }
  try {
    $ct = $current.Current.ControlType.ProgrammaticName
    $nm = $current.Current.Name
    $rect = $current.Current.BoundingRectangle
    $ctShort = $ct -replace '^ControlType\\.',''
    if ($clickable -contains $ctShort -or $nm) {
      $best = @{
        name = $nm
        automationId = $current.Current.AutomationId
        controlType = $ct
        x = [int]$rect.X
        y = [int]$rect.Y
        w = [int]$rect.Width
        h = [int]$rect.Height
      }
      if ($clickable -contains $ctShort) { break }
    }
  } catch {}
  try { $current = $walker.GetParent($current) } catch { break }
}
if (-not $best) {
  try {
    $rect = $el.Current.BoundingRectangle
    $best = @{
      name = $el.Current.Name
      automationId = $el.Current.AutomationId
      controlType = $el.Current.ControlType.ProgrammaticName
      x = [int]$rect.X
      y = [int]$rect.Y
      w = [int]$rect.Width
      h = [int]$rect.Height
    }
  } catch { return }
}
$best | ConvertTo-Json -Compress
`
  try {
    const stdout = await runPowerShellCapturing(script, {
      timeoutMs: TIMEOUT_MS,
      maxBuffer: 256 * 1024
    })
    const elements = parseUiaJson(stdout)
    return elements[0] ?? null
  } catch {
    return null
  }
}

/**
 * v2.0 polish — fast UIA lookup by AutomationId + ControlType. Used
 * by the hover-to-teach short-circuit (`taughtClicks.resolveTaughtClick`)
 * to avoid walking the full UIA tree when the taught entry has a
 * stable AutomationId. FindFirst with a PropertyCondition is O(tree)
 * inside the UIAClient instead of marshalling every node back through
 * the PowerShell→JSON→TS pipe.
 *
 * Returns null when:
 *  - non-Windows host
 *  - no element matches
 *  - PowerShell timed out / crashed
 *  - hwnd doesn't resolve to a live window
 */
export async function findElementByAutomationId(args: {
  hwnd: number | null
  automationId: string
  controlType: string
}): Promise<UiaElement | null> {
  if (process.platform !== 'win32') return null
  if (!args.automationId) return null
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch { return }
$root = $null
try {
  if (${args.hwnd ?? 0} -gt 0) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${args.hwnd ?? 0})
  } else {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
  }
} catch { return }
if (-not $root) { return }
$idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${args.automationId.replace(/'/g, "''")}')
$found = $null
try { $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $idCond) } catch { return }
if (-not $found) { return }
try {
  $ct = $found.Current.ControlType.ProgrammaticName
  if ($ct -ne '${args.controlType.replace(/'/g, "''")}') { return }
  $rect = $found.Current.BoundingRectangle
  @{
    name = $found.Current.Name
    automationId = $found.Current.AutomationId
    controlType = $ct
    x = [int]$rect.X
    y = [int]$rect.Y
    w = [int]$rect.Width
    h = [int]$rect.Height
  } | ConvertTo-Json -Compress
} catch { return }
`
  try {
    const stdout = await runPowerShellCapturing(script, {
      timeoutMs: TIMEOUT_MS,
      maxBuffer: 64 * 1024
    })
    const elements = parseUiaJson(stdout)
    return elements[0] ?? null
  } catch {
    return null
  }
}

/**
 * Parses the PowerShell JSON output. Exported for unit tests. Tolerates:
 *  · empty output (no windows found)
 *  · single-object output (PowerShell ConvertTo-Json doesn't wrap 1 item in array)
 *  · BOM / whitespace
 *  · missing optional fields (name/automationId can be empty strings)
 */
export function parseUiaJson(raw: string): UiaElement[] {
  const trimmed = raw.trim().replace(/^﻿/, '')
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const elements: UiaElement[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const x = Number(o.x)
    const y = Number(o.y)
    const w = Number(o.w)
    const h = Number(o.h)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue
    }
    elements.push({
      name: String(o.name ?? ''),
      automationId: String(o.automationId ?? ''),
      controlType: String(o.controlType ?? ''),
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h)
    })
  }
  return elements
}
