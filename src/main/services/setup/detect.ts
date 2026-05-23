/**
 * Setup-time scan that looks across the user's machine for AI tools they've
 * already configured — Claude Desktop, Cursor, ChatGPT Desktop, env-var API
 * keys, and the existing local-provider probe results — and returns a
 * single structured report.
 *
 * This is the data layer behind the first-run "we found X, want to import?"
 * panel and the in-Settings "Import from Claude Desktop" buttons. Pure
 * detection only — it never mutates state, never writes to disk, and never
 * carries raw API-key values across the IPC boundary (only previews; the
 * separate import functions read env vars again at import time so the key
 * itself never leaks).
 *
 * Failure mode: every probe is wrapped in a try/catch — a malformed config
 * file, a permission denial on a path, or a slow localhost probe shouldn't
 * blank the whole report. We always return a complete report shape; missing
 * pieces show as `installed: false` or empty arrays.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { log } from '../logger'
import { wasLocalProviderDetected } from '../ai/detect'
import {
  ENV_KEY_PROVIDERS,
  keyPreview,
  parseMcpServersBlock
} from './parse'
import type {
  DetectedDesktopApp,
  DetectedEnvKey,
  DetectedLocalProvider,
  DetectedMcpServer,
  SetupReport
} from '@shared/types'

/* ---------------------------- path helpers ---------------------------- */

/**
 * Standard install / config locations per OS. Centralised so the cross-
 * platform logic doesn't sprawl into every detection function.
 *
 * On Windows we prefer the `APPDATA` env var over a homedir join — Windows
 * users with non-standard profile setups (corporate environments, OneDrive
 * Documents redirect, junction-pointed roaming profiles) get their config
 * files in the redirected path that `APPDATA` reflects, not in
 * `%USERPROFILE%\AppData\Roaming`.
 */
function appDataDir(): string {
  if (platform() === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  }
  return homedir()
}

function localAppDataDir(): string {
  if (platform() === 'win32') {
    return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  }
  return homedir()
}

/** Per-OS path to Claude Desktop's MCP-bearing config file. */
function claudeDesktopConfigPath(): string {
  const os = platform()
  if (os === 'win32') return join(appDataDir(), 'Claude', 'claude_desktop_config.json')
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  // Linux + everything else
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

/**
 * Cursor's MCP config moved around in early 2025. Current canonical
 * location is `~/.cursor/mcp.json` on every platform; older installs may
 * still have it at the User-settings dir. We check the canonical path
 * first and fall back to the older location only if it exists.
 */
function cursorMcpConfigPath(): string {
  const primary = join(homedir(), '.cursor', 'mcp.json')
  if (existsSync(primary)) return primary
  if (platform() === 'win32') {
    return join(appDataDir(), 'Cursor', 'User', 'globalStorage', 'mcp.json')
  }
  return primary // primary path for "missing" return — caller checks existsSync
}

/**
 * Likely ChatGPT Desktop install paths. Presence-only — the OpenAI app
 * doesn't expose a config we can mine, so we just confirm the install
 * exists and surface that as a "you have ChatGPT installed" signal in
 * case the user wants to set up OpenAI as a provider in VoidSoul too.
 */
function chatGptDesktopPath(): string | null {
  const os = platform()
  if (os === 'win32') {
    const exe = join(localAppDataDir(), 'Programs', 'OpenAI', 'ChatGPT', 'ChatGPT.exe')
    return existsSync(exe) ? exe : null
  }
  if (os === 'darwin') {
    const app = '/Applications/ChatGPT.app'
    return existsSync(app) ? app : null
  }
  return null
}

/* --------------------------- file readers ---------------------------- */

/**
 * Safely read + JSON.parse a config file. Returns null on any failure
 * (missing, permission denied, malformed JSON) — the caller treats null
 * as "not installed" or "unparseable, skip".
 *
 * Skips the `existsSync` precheck — `readFileSync` raises ENOENT on
 * missing files, which we catch here. Avoids the TOCTOU pattern and one
 * extra stat per probe.
 */
function readJsonIfExists(path: string): unknown {
  try {
    const text = readFileSync(path, 'utf-8')
    return JSON.parse(text)
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    log(
      'warn',
      'system',
      `Setup detect: couldn't read ${path}`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/* ---------------------- desktop-app detectors ------------------------ */

function detectClaudeDesktop(): DetectedDesktopApp & { mcpServers: DetectedMcpServer[] } {
  const path = claudeDesktopConfigPath()
  const raw = readJsonIfExists(path)
  if (!raw) return { installed: false, mcpServers: [] }
  const mcpServers = parseMcpServersBlock(raw, 'claude-desktop')
  return { installed: true, path, mcpServers }
}

function detectCursor(): DetectedDesktopApp & { mcpServers: DetectedMcpServer[] } {
  const path = cursorMcpConfigPath()
  const raw = readJsonIfExists(path)
  if (!raw) return { installed: false, mcpServers: [] }
  const mcpServers = parseMcpServersBlock(raw, 'cursor')
  return { installed: true, path, mcpServers }
}

function detectChatGptDesktop(): DetectedDesktopApp {
  const path = chatGptDesktopPath()
  return path ? { installed: true, path } : { installed: false }
}

/* ----------------------------- env keys ------------------------------ */

/**
 * Walk the env-var → provider map and emit a row for each key that's
 * actually set + non-empty. Deduplicates by provider — if both
 * GOOGLE_API_KEY and GEMINI_API_KEY are set, we surface only the first
 * one (matching the order in ENV_KEY_PROVIDERS) so the import dialog
 * doesn't show two "Import Gemini key" rows that overwrite each other.
 *
 * Critically: the report contains only the PREVIEW string, not the full
 * key. The actual key never leaves main — `importEnvKey(providerId)` in
 * a later phase reads `process.env` again at import time.
 */
function detectEnvKeys(): DetectedEnvKey[] {
  const seenProviders = new Set<string>()
  const out: DetectedEnvKey[] = []
  for (const [varName, providerId] of Object.entries(ENV_KEY_PROVIDERS)) {
    if (seenProviders.has(providerId)) continue
    const value = process.env[varName]
    if (!value || !value.trim()) continue
    out.push({ varName, providerId, keyPreview: keyPreview(value) })
    seenProviders.add(providerId)
  }
  return out
}

/* ------------------------ local providers (existing) ------------------ */

/**
 * Mirror the existing Ollama / LM Studio detection results into the report
 * shape. Doesn't re-probe — uses the cached results from the boot-time
 * sweep (`wasLocalProviderDetected`) so adding a second probe call here
 * doesn't slow setup detection.
 *
 * Note: model counts aren't currently cached by `ai/detect.ts`'s sweep
 * (it just records "reachable: yes/no"). For now we report -1 to signal
 * "reachable but count unknown" — a future improvement to detect.ts can
 * cache the count and wire it in.
 */
function detectLocalProviders(): DetectedLocalProvider[] {
  const out: DetectedLocalProvider[] = []
  for (const id of ['ollama', 'lmstudio', 'llamacpp'] as const) {
    if (wasLocalProviderDetected(id)) {
      out.push({ providerId: id, modelCount: -1 })
    }
  }
  // Best-effort log so the renderer / dev console shows what we found.
  if (out.length > 0) {
    log('info', 'system', `Setup detect: local providers reachable — ${out.map((p) => p.providerId).join(', ')}`)
  }
  return out
}

/* ----------------------------- main entry ----------------------------- */

/**
 * Run all detection probes and return a single structured report. Each
 * probe is independently fault-tolerant — a thrown error in one section
 * doesn't blank the others. Total wall-clock is dominated by the file
 * reads (each <5 ms on a warm cache), so the whole sweep finishes in
 * under 50 ms on a typical machine.
 */
export function runSetupDetection(): SetupReport {
  return {
    claudeDesktop: safe('claude-desktop', detectClaudeDesktop, { installed: false, mcpServers: [] }),
    cursor: safe('cursor', detectCursor, { installed: false, mcpServers: [] }),
    chatgptDesktop: safe('chatgpt-desktop', detectChatGptDesktop, { installed: false }),
    envKeys: safe('env-keys', detectEnvKeys, []),
    localProviders: safe('local-providers', detectLocalProviders, []),
    generatedAt: new Date().toISOString()
  }
}

/**
 * Run `fn`; on any thrown error log + return `fallback`. Takes an explicit
 * `label` rather than relying on `fn.name` because minifiers mangle
 * function names in production builds — without the explicit label we'd
 * see warnings like "probe a threw" with no clue which probe failed.
 */
function safe<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (err) {
    log(
      'warn',
      'system',
      `Setup detect: probe ${label} threw`,
      err instanceof Error ? err.message : String(err)
    )
    return fallback
  }
}
