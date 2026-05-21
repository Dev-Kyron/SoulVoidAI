/**
 * Tiny atomic JSON document store. Each store is a single file under the
 * user-data directory. Writes go through a temp file + rename so a crash mid
 * write can never corrupt the document.
 *
 * SQLite is the longer-term target for the memory subsystem; the JsonStore
 * interface is intentionally narrow so it can be swapped for a SQLite-backed
 * implementation without touching callers.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

let cachedDir: string | null = null

/**
 * Resolves the app's data directory, creating it on first call. If the
 * normal `userData` location is unwritable (read-only profile, locked-down
 * managed Windows install, permission revoke), we fall back to a sibling
 * under the system temp dir so the app boots with a clean (ephemeral)
 * state rather than crashing in the constructor.
 *
 * The fallback is logged via `electron`'s `console` because the structured
 * logger lives upstream of this module — bringing it in would create a
 * dependency cycle during the very early boot path.
 */
function dataDir(): string {
  if (cachedDir) return cachedDir
  const primary = join(app.getPath('userData'), 'voidsoul-data')
  try {
    if (!existsSync(primary)) mkdirSync(primary, { recursive: true })
    cachedDir = primary
    return cachedDir
  } catch (err) {
    // Fallback: temp-dir sibling. State here is ephemeral (cleared on OS
    // restart on most platforms) but it's better than not booting at all.
    // The user can fix the root cause and relaunch; until then the app at
    // least opens.
    const fallback = join(app.getPath('temp'), 'voidsoul-data-fallback')
    try {
      if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true })
      console.warn(
        `[voidsoul] userData unwritable (${err instanceof Error ? err.message : String(err)}). ` +
          `Falling back to ephemeral ${fallback}. State will NOT persist across restarts until ` +
          `the original userData path becomes writable.`
      )
      cachedDir = fallback
      return cachedDir
    } catch {
      // Both directories failed — re-throw the original so the user sees
      // the real problem (probably disk full or full lockdown).
      throw err
    }
  }
}

export function dataPath(...parts: string[]): string {
  return join(dataDir(), ...parts)
}

/**
 * Returns a path under the user-data dir, creating the directory (and any
 * missing parents) first. Collapses the recurring `if (!existsSync) mkdirSync`
 * preamble that several IPC + service paths used to repeat.
 */
export function ensureDataPath(...parts: string[]): string {
  const path = join(dataDir(), ...parts)
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

export class JsonStore<T extends object> {
  private cache: T
  private readonly file: string

  constructor(
    name: string,
    private readonly defaults: T
  ) {
    this.file = join(dataDir(), `${name}.json`)
    this.cache = this.load()
  }

  private load(): T {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<T>
        return { ...structuredClone(this.defaults), ...raw }
      }
    } catch {
      // Corrupt or unreadable file — fall back to defaults rather than crash.
    }
    return structuredClone(this.defaults)
  }

  get(): T {
    return this.cache
  }

  set(patch: Partial<T>): T {
    this.cache = { ...this.cache, ...patch }
    this.persist()
    return this.cache
  }

  replace(value: T): T {
    this.cache = value
    this.persist()
    return this.cache
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
    renameSync(tmp, this.file)
  }
}
