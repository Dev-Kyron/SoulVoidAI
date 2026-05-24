/**
 * Shared PowerShell helper. Three of the automation services (input,
 * uia, windowManager) spawn powershell.exe with the same flags + UTF-16
 * base64 encoding pattern. Keeping the scaffolding in one place stops the
 * three copies from drifting and gives us one place to add a future
 * persistent-host optimisation (right now each call cold-spawns the
 * interpreter, which is the dominant ~500-1500ms latency on UIA / window
 * enumeration — see the v1.10.x efficiency review).
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

/** Encodes a PowerShell script as UTF-16 LE base64 — the format
 *  `powershell -EncodedCommand` expects. Avoids quoting nightmares
 *  for multi-line scripts. */
export function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Process names we always exclude from automation enumerations so
 *  VoidSoul's own electron windows don't pollute results. Shared
 *  between uia.ts (UIA tree walk) and windowManager.ts (top-level
 *  window enumeration) — one constant means a future Electron rename
 *  only needs editing here. */
export const DEFAULT_EXCLUDE_PROCESS_NAMES = [
  'voidsoul',
  'voidsoul-ai-companion',
  'electron'
] as const

export interface RunPowerShellOptions {
  /** Hard timeout in ms (PowerShell calls have stalled out on
   *  misbehaving apps; the caller decides how long to tolerate). */
  timeoutMs?: number
  /** Maximum stdout/stderr bytes to buffer. Defaults to 4 MiB which
   *  covers every PS script we ship; UIA enumerations are by far the
   *  largest at ~2 MiB on a busy desktop. */
  maxBuffer?: number
}

/**
 * Runs a PowerShell script with our standard flags (`-NoProfile`,
 * `-NonInteractive`, `-EncodedCommand`, `windowsHide`) and returns
 * the stdout string. Throws on non-zero exit / timeout — callers
 * decide whether that's fatal (typically: catch and return empty
 * results, falling back to whatever's behind the PS-dependent path).
 */
export async function runPowerShellCapturing(
  script: string,
  options: RunPowerShellOptions = {}
): Promise<string> {
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(script)}`,
    {
      timeout: options.timeoutMs ?? 4_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      windowsHide: true
    }
  )
  return stdout
}

/**
 * Fire-and-forget PowerShell — discard stdout, await completion only.
 * Used by side-effecting scripts (focus a window, send a hotkey) where
 * the output is irrelevant.
 */
export async function runPowerShell(
  script: string,
  options: RunPowerShellOptions = {}
): Promise<void> {
  await execAsync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(script)}`,
    {
      timeout: options.timeoutMs ?? 4_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true
    }
  )
}
