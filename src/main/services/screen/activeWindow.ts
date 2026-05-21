/**
 * Active-window detection. Gives the assistant lightweight context about what
 * the user currently has focused. Windows uses a small P/Invoke snippet; other
 * platforms return an empty result rather than failing.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ActiveWindowInfo } from '@shared/types'

const execAsync = promisify(exec)

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const WIN_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class VoidSoulWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$handle = [VoidSoulWin]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][VoidSoulWin]::GetWindowText($handle, $builder, 512)
$procId = 0
[void][VoidSoulWin]::GetWindowThreadProcessId($handle, [ref]$procId)
$procName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
[Console]::Out.Write((ConvertTo-Json @{ title = $builder.ToString(); process = $procName }))
`.trim()

export async function getActiveWindow(): Promise<ActiveWindowInfo> {
  if (process.platform !== 'win32') {
    return { title: '', process: '' }
  }
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(WIN_SCRIPT)}`,
      { windowsHide: true, timeout: 5000 }
    )
    const json = JSON.parse(stdout)
    return { title: json.title ?? '', process: json.process ?? '' }
  } catch {
    return { title: '', process: '' }
  }
}
