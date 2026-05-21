/**
 * Reads the apps the user has pinned to the Windows taskbar so they can be
 * imported into VoidSoul's favourites for fast workflow setup. Taskbar pins
 * are `.lnk` shortcuts under the Quick Launch directory; their targets are
 * resolved with the WScript.Shell COM object.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface TaskbarApp {
  name: string
  target: string
}

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const SCRIPT = `
$shell = New-Object -ComObject WScript.Shell
$dir = Join-Path $env:APPDATA 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
$apps = @()
if (Test-Path $dir) {
  Get-ChildItem -Path $dir -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $link = $shell.CreateShortcut($_.FullName)
    if ($link.TargetPath -and (Test-Path $link.TargetPath)) {
      $apps += [PSCustomObject]@{ name = $_.BaseName; target = $link.TargetPath }
    }
  }
}
[Console]::Out.Write(($apps | ConvertTo-Json -Compress))
`.trim()

export async function importTaskbarApps(): Promise<TaskbarApp[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(SCRIPT)}`,
      { windowsHide: true, timeout: 10_000 }
    )
    const parsed = JSON.parse(stdout.trim() || '[]')
    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter(
        (a): a is TaskbarApp =>
          !!a &&
          typeof (a as TaskbarApp).name === 'string' &&
          typeof (a as TaskbarApp).target === 'string'
      )
      .map((a) => ({ name: a.name, target: a.target }))
  } catch {
    return []
  }
}
