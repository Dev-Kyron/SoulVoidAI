import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SQLite-backed; see src/main/services/storage/db.test.ts for the rationale
// behind the RUN_SQLITE_TESTS flag.
const RUN = process.env.RUN_SQLITE_TESTS === '1'

let dataRoot = ''

vi.mock('electron', () => ({
  app: { getPath: () => dataRoot }
}))

// History's RAG-on check pulls config; stub it so tests stay focused.
vi.mock('./config', () => ({
  getConfig: () => ({ chat: { rag: false } })
}))

// Indexing is best-effort — stub the embeddings facade so the tests don't try
// to hit a real embedding provider.
vi.mock('../embeddings', () => ({
  indexMessages: async () => 0,
  removeByThread: () => undefined,
  clearEmbeddings: () => undefined
}))

async function loadFresh(): Promise<typeof import('./history')> {
  vi.resetModules()
  return await import('./history')
}

function writeLegacyFile(name: string, body: unknown): string {
  const dir = join(dataRoot, 'voidsoul-data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify(body), 'utf-8')
  return path
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'voidsoul-history-test-'))
})

afterEach(() => {
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe.skipIf(!RUN)('history migrator', () => {
  it('promotes a legacy single-log file into one threaded entry on first read', async () => {
    writeLegacyFile('history', {
      messages: [
        { id: 'u1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'a1', role: 'assistant', content: 'hello!', createdAt: '2026-01-01T00:00:01.000Z' }
      ],
      summary: null
    })

    const mod = await loadFresh()
    const file = mod.getHistory()
    expect(file.threads).toHaveLength(1)
    expect(file.threads[0].title).toBe('Original chat')
    expect(file.threads[0].messages).toHaveLength(2)
    expect(file.threads[0].messages[0].id).toBe('u1')
    expect(file.activeThreadId).toBe(file.threads[0].id)
  })

  it('rehydrates a threaded JSON file directly into the database', async () => {
    writeLegacyFile('history', {
      threads: [
        {
          id: 'tA',
          title: 'Alpha',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'first message',
              createdAt: '2026-01-01T00:00:01.000Z'
            }
          ],
          summary: null
        },
        {
          id: 'tB',
          title: 'Beta',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          messages: [],
          summary: null,
          pinned: true
        }
      ],
      activeThreadId: 'tB'
    })

    const mod = await loadFresh()
    const file = mod.getHistory()
    expect(file.threads.map((t) => t.id).sort()).toEqual(['tA', 'tB'])
    const beta = file.threads.find((t) => t.id === 'tB')
    expect(beta?.pinned).toBe(true)
    expect(file.activeThreadId).toBe('tB')
  })

  it('createThread sets the new thread active and a fresh load returns it', async () => {
    const mod = await loadFresh()
    const thread = mod.createThread('My UE5 notes')
    const file = mod.getHistory()
    expect(file.threads.some((t) => t.id === thread.id)).toBe(true)
    expect(file.activeThreadId).toBe(thread.id)
    expect(thread.title).toBe('My UE5 notes')
  })

  it('saveThread persists messages and bumps updatedAt', async () => {
    const mod = await loadFresh()
    const t = mod.createThread('demo')
    const before = t.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    const saved = mod.saveThread(t.id, [
      { id: 'u1', role: 'user', content: 'hi', createdAt: '2026-01-02T00:00:00.000Z' }
    ])
    expect(saved?.messageCount).toBe(1)
    expect(saved && saved.updatedAt >= before).toBe(true)
    const messages = mod.getThreadMessages(t.id)
    expect(messages[0]?.id).toBe('u1')
  })

  it('deleteThread removes its row and its messages', async () => {
    const mod = await loadFresh()
    const a = mod.createThread('a')
    const b = mod.createThread('b')
    mod.saveThread(a.id, [{ id: 'm1', role: 'user', content: 'x', createdAt: '2026-01-01T00:00:00.000Z' }])
    const after = mod.deleteThread(a.id)
    expect(after.summaries.some((t) => t.id === a.id)).toBe(false)
    expect(after.summaries.some((t) => t.id === b.id)).toBe(true)
  })

  it('setThreadPinned toggles the pinned flag and persists across reload', async () => {
    let mod = await loadFresh()
    const t = mod.createThread('pin me')
    expect(mod.setThreadPinned(t.id, true)?.pinned).toBe(true)
    mod = await loadFresh()
    const file = mod.getHistory()
    expect(file.threads.find((thread) => thread.id === t.id)?.pinned).toBe(true)
  })
})
