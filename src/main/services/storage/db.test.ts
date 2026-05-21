import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * SQLite suite. Skipped by default because `better-sqlite3` is a native module
 * built against Electron's Node ABI (via `electron-builder install-app-deps`),
 * not the system Node that Vitest runs under. To execute this suite locally:
 *
 *   1. `npm rebuild better-sqlite3`  (builds for system Node — needs Python)
 *   2. `RUN_SQLITE_TESTS=1 npm test`
 *   3. After tests:  `npm run postinstall`  (rebuilds back for Electron)
 *
 * The harness is verified by the pure-function suites (chunk, utils). Pure
 * tests run on every commit; the SQL suite is opt-in.
 */
const RUN = process.env.RUN_SQLITE_TESTS === '1'

let dataRoot = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => dataRoot
  }
}))

async function loadFresh(): Promise<typeof import('./db')> {
  vi.resetModules()
  return await import('./db')
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'voidsoul-db-test-'))
})

afterEach(() => {
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* ignore cleanup races */
  }
})

describe.skipIf(!RUN)('db()', () => {
  it('creates the database file and applies migrations on first open', async () => {
    const mod = await loadFresh()
    const handle = mod.db()
    const tables = handle
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('threads')
    expect(names).toContain('messages')
    expect(names).toContain('embeddings')
    expect(names).toContain('indexed_folders')
    expect(names).toContain('indexed_files')
    expect(names).toContain('usage_entries')
    expect(names).toContain('usage_budget')

    const version = handle
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string }
    expect(Number(version.value)).toBeGreaterThanOrEqual(1)
    mod.closeDb()
  })

  it('is idempotent — reopening does not re-run migrations or wipe data', async () => {
    let mod = await loadFresh()
    mod
      .db()
      .prepare(
        `INSERT INTO threads (id, title, created_at, updated_at) VALUES ('t1','demo','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
      )
      .run()
    mod.closeDb()

    mod = await loadFresh()
    const row = mod.db().prepare(`SELECT title FROM threads WHERE id = 't1'`).get() as
      | { title: string }
      | undefined
    expect(row?.title).toBe('demo')
    mod.closeDb()
  })

  it('round-trips vectors through vectorToBlob / blobToVector', async () => {
    const mod = await loadFresh()
    const vec = [0.1, -0.25, 0.75, 1.5, -3.14159]
    const blob = mod.vectorToBlob(vec)
    const back = mod.blobToVector(blob)
    expect(back).toHaveLength(vec.length)
    back.forEach((value, i) => {
      // Float32 loses precision past ~7 sig figs — assert close-enough equality.
      expect(value).toBeCloseTo(vec[i], 5)
    })
    mod.closeDb()
  })

  it('ingestLegacyJson renames the file to .migrated after a successful read', async () => {
    const mod = await loadFresh()
    const file = join(dataRoot, 'voidsoul-data', 'demo.json')
    writeFileSync(file, JSON.stringify({ records: [{ id: 'a' }] }), 'utf-8')

    const ingested: Array<{ id: string }> = []
    const result = mod.ingestLegacyJson<{ records: Array<{ id: string }> }>('demo', (parsed) => {
      ingested.push(...parsed.records)
    })

    expect(result.migrated).toBe(true)
    expect(ingested).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.migrated`)).toBe(true)
    mod.closeDb()
  })

  it('ingestLegacyJson is a no-op when the file does not exist', async () => {
    const mod = await loadFresh()
    let called = false
    const result = mod.ingestLegacyJson('missing', () => {
      called = true
    })
    expect(result.migrated).toBe(false)
    expect(called).toBe(false)
    mod.closeDb()
  })
})
