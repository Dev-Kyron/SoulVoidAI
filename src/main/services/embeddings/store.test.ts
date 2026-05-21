import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SQLite-backed; see src/main/services/storage/db.test.ts for the rationale
// behind the RUN_SQLITE_TESTS flag.
const RUN = process.env.RUN_SQLITE_TESTS === '1'

let dataRoot = ''

vi.mock('electron', () => ({
  app: { getPath: () => dataRoot }
}))

async function loadFresh(): Promise<typeof import('./store')> {
  vi.resetModules()
  return await import('./store')
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'voidsoul-embed-test-'))
})

afterEach(() => {
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const baseRecord = {
  vector: [0.1, 0.2, 0.3, 0.4],
  preview: 'hello world',
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'user' as const,
  model: 'openai:text-embedding-3-small'
}

describe.skipIf(!RUN)('embedding store', () => {
  it('round-trips a chat record', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([{ messageId: 'm1', threadId: 't1', ...baseRecord }])
    const all = mod.getEmbeddings()
    expect(all).toHaveLength(1)
    expect(all[0].messageId).toBe('m1')
    expect(all[0].threadId).toBe('t1')
    expect(all[0].source).toBe('chat')
    all[0].vector.forEach((v, i) => expect(v).toBeCloseTo(baseRecord.vector[i], 5))
  })

  it('dedupes by id when adding the same record twice', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([{ messageId: 'm1', threadId: 't1', ...baseRecord }])
    mod.addEmbeddings([
      { messageId: 'm1', threadId: 't1', ...baseRecord, preview: 'updated preview' }
    ])
    const all = mod.getEmbeddings()
    expect(all).toHaveLength(1)
    expect(all[0].preview).toBe('updated preview')
  })

  it('hasEmbeddingFor reports presence correctly', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([{ messageId: 'm1', threadId: 't1', ...baseRecord }])
    expect(mod.hasEmbeddingFor('m1')).toBe(true)
    expect(mod.hasEmbeddingFor('m2')).toBe(false)
  })

  it('removeByThread deletes only that thread\'s records', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([
      { messageId: 'a', threadId: 't1', ...baseRecord },
      { messageId: 'b', threadId: 't2', ...baseRecord }
    ])
    mod.removeByThread('t1')
    const left = mod.getEmbeddings()
    expect(left).toHaveLength(1)
    expect(left[0].messageId).toBe('b')
  })

  it('removeByFilePath cleans up chunks for one file', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([
      {
        messageId: 'C:/proj/a.md#0',
        source: 'file',
        filePath: 'C:/proj/a.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file'
      },
      {
        messageId: 'C:/proj/b.md#0',
        source: 'file',
        filePath: 'C:/proj/b.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file'
      }
    ])
    mod.removeByFilePath('C:/proj/a.md')
    const left = mod.getEmbeddings()
    expect(left).toHaveLength(1)
    expect(left[0].filePath).toBe('C:/proj/b.md')
  })

  it('removeByFolder removes all file records under the prefix', async () => {
    const mod = await loadFresh()
    mod.addEmbeddings([
      {
        messageId: 'C:/proj/sub/a.md#0',
        source: 'file',
        filePath: 'C:/proj/sub/a.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file'
      },
      {
        messageId: 'C:/other/b.md#0',
        source: 'file',
        filePath: 'C:/other/b.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file'
      }
    ])
    mod.removeByFolder('C:/proj')
    const left = mod.getEmbeddings()
    expect(left).toHaveLength(1)
    expect(left[0].filePath).toBe('C:/other/b.md')
  })

  it('countEmbeddings reflects inserts and deletes', async () => {
    const mod = await loadFresh()
    expect(mod.countEmbeddings()).toBe(0)
    mod.addEmbeddings([
      { messageId: 'a', threadId: 't', ...baseRecord },
      { messageId: 'b', threadId: 't', ...baseRecord }
    ])
    expect(mod.countEmbeddings()).toBe(2)
    mod.removeByIds(['a'])
    expect(mod.countEmbeddings()).toBe(1)
    mod.clearEmbeddings()
    expect(mod.countEmbeddings()).toBe(0)
  })

  it('file-source trim never evicts chat records, even when files overflow', async () => {
    const mod = await loadFresh()
    // Tight caps so we don't insert 200k rows to trigger the bug.
    mod.__setEmbeddingCapsForTesting({ chat: 1000, file: 3 })

    // Seed chat records first with EARLIER timestamps — under the broken
    // global-FIFO trim these would have been the first to go.
    mod.addEmbeddings([
      { messageId: 'chat-1', threadId: 't', ...baseRecord, createdAt: '2026-01-01T00:00:00.000Z' },
      { messageId: 'chat-2', threadId: 't', ...baseRecord, createdAt: '2026-01-01T00:00:01.000Z' }
    ])

    // Then a file-RAG sweep that overflows the file cap by 2.
    const fileRecord = (i: number, ts: string) => ({
      messageId: `C:/p/f${i}.md#0`,
      source: 'file' as const,
      filePath: `C:/p/f${i}.md`,
      chunkIndex: 0,
      ...baseRecord,
      role: 'file' as const,
      createdAt: ts
    })
    mod.addEmbeddings([
      fileRecord(1, '2026-02-01T00:00:00.000Z'),
      fileRecord(2, '2026-02-01T00:00:01.000Z'),
      fileRecord(3, '2026-02-01T00:00:02.000Z'),
      fileRecord(4, '2026-02-01T00:00:03.000Z'),
      fileRecord(5, '2026-02-01T00:00:04.000Z')
    ])

    const counts = mod.countBySource()
    // Both chat records survived (proves trim was partitioned), file cap
    // enforced, and the trim took the oldest files (f1, f2) not chat.
    expect(counts.chat).toBe(2)
    expect(counts.file).toBe(3)
    const all = mod.getEmbeddings()
    const ids = all.map((r) => r.messageId).sort()
    expect(ids).toContain('chat-1')
    expect(ids).toContain('chat-2')
    expect(ids).not.toContain('C:/p/f1.md#0')
    expect(ids).not.toContain('C:/p/f2.md#0')
  })

  it('chat-source trim never evicts file records', async () => {
    const mod = await loadFresh()
    mod.__setEmbeddingCapsForTesting({ chat: 2, file: 1000 })

    // Seed file records first with EARLIER timestamps.
    mod.addEmbeddings([
      {
        messageId: 'C:/p/a.md#0',
        source: 'file',
        filePath: 'C:/p/a.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file',
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        messageId: 'C:/p/b.md#0',
        source: 'file',
        filePath: 'C:/p/b.md',
        chunkIndex: 0,
        ...baseRecord,
        role: 'file',
        createdAt: '2026-01-01T00:00:01.000Z'
      }
    ])

    // Then a chat burst that overflows the chat cap.
    mod.addEmbeddings([
      { messageId: 'c1', threadId: 't', ...baseRecord, createdAt: '2026-02-01T00:00:00.000Z' },
      { messageId: 'c2', threadId: 't', ...baseRecord, createdAt: '2026-02-01T00:00:01.000Z' },
      { messageId: 'c3', threadId: 't', ...baseRecord, createdAt: '2026-02-01T00:00:02.000Z' },
      { messageId: 'c4', threadId: 't', ...baseRecord, createdAt: '2026-02-01T00:00:03.000Z' }
    ])

    const counts = mod.countBySource()
    expect(counts.chat).toBe(2)
    expect(counts.file).toBe(2)
    const ids = mod.getEmbeddings().map((r) => r.messageId).sort()
    expect(ids).toContain('C:/p/a.md#0')
    expect(ids).toContain('C:/p/b.md#0')
    expect(ids).toContain('c3')
    expect(ids).toContain('c4')
    expect(ids).not.toContain('c1') // oldest chat dropped
    expect(ids).not.toContain('c2')
  })
})
