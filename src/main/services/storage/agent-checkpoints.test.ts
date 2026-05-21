import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentCheckpointCreate,
  AgentCheckpointUpdate,
  ChatTurn,
  ToolInvocation
} from '@shared/types'

/**
 * Agent-checkpoint storage suite. Gated by RUN_SQLITE_TESTS for the same
 * reason as db.test.ts (better-sqlite3 ABI). See db.test.ts header for
 * the rebuild dance.
 */
const RUN = process.env.RUN_SQLITE_TESTS === '1'

let dataRoot = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => dataRoot
  }
}))

async function loadFresh(): Promise<typeof import('./agent-checkpoints')> {
  vi.resetModules()
  return await import('./agent-checkpoints')
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'voidsoul-agent-cp-test-'))
})

afterEach(() => {
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* ignore cleanup races */
  }
})

function makeCreate(overrides: Partial<AgentCheckpointCreate> = {}): AgentCheckpointCreate {
  const turns: ChatTurn[] = [{ role: 'user', content: 'do the thing' }]
  return {
    requestId: 'req-1',
    threadId: 'thread-1',
    userMessageId: 'msg-user-1',
    assistantMessageId: 'msg-asst-1',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    systemPrompt: 'You are VoidSoul.',
    turns,
    ...overrides
  }
}

describe.skipIf(!RUN)('agent-checkpoints', () => {
  it('round-trips a fresh checkpoint via get()', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    const cp = mod.getCheckpoint('req-1')
    expect(cp).not.toBeNull()
    expect(cp!.status).toBe('running')
    expect(cp!.step).toBe(0)
    expect(cp!.turns).toHaveLength(1)
    expect(cp!.invocations).toEqual([])
  })

  it('updateCheckpoint bumps step + turns + invocations, leaves status alone', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    const turns: ChatTurn[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'okay' }
    ]
    const invocations: ToolInvocation[] = [
      {
        id: 'tool-1',
        name: 'see_screen',
        args: {},
        result: 'screenshot taken',
        ok: true
      }
    ]
    const patch: AgentCheckpointUpdate = { step: 3, turns, invocations }
    mod.updateCheckpoint('req-1', patch)
    const cp = mod.getCheckpoint('req-1')
    expect(cp!.step).toBe(3)
    expect(cp!.turns).toHaveLength(2)
    expect(cp!.invocations[0].name).toBe('see_screen')
    expect(cp!.status).toBe('running') // unchanged
  })

  it('updateCheckpoint is a no-op once status is terminal', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    mod.finalizeCheckpoint('req-1', 'completed')
    // Try to write step 5 after the checkpoint has been finalised —
    // should be silently ignored so post-finalise stragglers don't
    // resurrect terminal rows.
    mod.updateCheckpoint('req-1', {
      step: 5,
      turns: [{ role: 'user', content: 'late' }],
      invocations: []
    })
    const cp = mod.getCheckpoint('req-1')
    expect(cp!.step).toBe(0)
    expect(cp!.status).toBe('completed')
  })

  it('finalizeCheckpoint records failure text', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    mod.finalizeCheckpoint('req-1', 'failed', 'provider returned 500')
    const cp = mod.getCheckpoint('req-1')
    expect(cp!.status).toBe('failed')
    expect(cp!.failure).toBe('provider returned 500')
  })

  it('listStaleRunning returns only rows still at running, newest first', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate({ requestId: 'r1' }))
    mod.createCheckpoint(makeCreate({ requestId: 'r2' }))
    mod.createCheckpoint(makeCreate({ requestId: 'r3' }))
    mod.finalizeCheckpoint('r2', 'completed')
    const stale = mod.listStaleRunning()
    expect(stale.map((c) => c.requestId).sort()).toEqual(['r1', 'r3'])
  })

  it('deleteCheckpoint removes the row by requestId', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    expect(mod.getCheckpoint('req-1')).not.toBeNull()
    mod.deleteCheckpoint('req-1')
    expect(mod.getCheckpoint('req-1')).toBeNull()
  })

  it('createCheckpoint is idempotent — same requestId resets the row', async () => {
    const mod = await loadFresh()
    mod.createCheckpoint(makeCreate())
    mod.updateCheckpoint('req-1', {
      step: 7,
      turns: [{ role: 'user', content: 'partway' }],
      invocations: []
    })
    // Re-create with the same requestId — replaces the row, resetting step to 0.
    // This protects against a runaway resume that re-enters create() with
    // an existing requestId.
    mod.createCheckpoint(makeCreate())
    const cp = mod.getCheckpoint('req-1')
    expect(cp!.step).toBe(0)
    expect(cp!.status).toBe('running')
  })

  it('safely degrades when persisted JSON is corrupt', async () => {
    const mod = await loadFresh()
    // Force a corrupt invocations_json on disk to simulate a torn write
    // or a future schema mismatch. The reader should not crash; the row
    // should still be returned with an empty invocations array.
    const { db } = await import('./db')
    mod.createCheckpoint(makeCreate())
    db()
      .prepare(`UPDATE agent_checkpoints SET invocations_json = 'not json' WHERE request_id = 'req-1'`)
      .run()
    const cp = mod.getCheckpoint('req-1')
    expect(cp).not.toBeNull()
    expect(cp!.invocations).toEqual([])
  })
})
