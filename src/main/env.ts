/**
 * Minimal `.env` loader for development. A packaged build has no `.env` beside
 * it — API keys live encrypted in the keychain — so this is purely a
 * convenience so developers don't re-enter keys on every run.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function loadDotEnv(): void {
  const candidates = [join(app.getAppPath(), '.env'), join(process.cwd(), '.env')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (key && process.env[key] === undefined) process.env[key] = value
      }
    } catch {
      // Malformed .env — ignore and rely on in-app settings.
    }
    return
  }
}
