/**
 * Clipboard helper. v1.13.5 — renderer-side `navigator.clipboard.writeText`
 * can silently reject in Electron when the window has just lost OS focus
 * or when a Permissions Policy edge case fires. Every previous call site
 * used `void navigator.clipboard.writeText(...)`, so the rejection was
 * invisible — the UI flashed "Copied" while nothing landed in the OS
 * clipboard. This helper routes through Electron's native `clipboard`
 * module via IPC (no focus / permissions gate), with a `navigator`
 * fallback for the case where the bridge itself is unreachable.
 *
 * Returns `true` if either path succeeded. Callers can branch on the
 * result to surface a toast — most won't bother because the bridge
 * almost always succeeds, but the option is there.
 */
import { vs } from './bridge'

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const ok = await vs.system.copyText(text)
    if (ok) return true
  } catch {
    /* bridge call failed — fall through to the navigator path */
  }
  // Best-effort fallback. If both fail there's nothing more to try; the
  // caller will see `false` and can surface a toast.
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
