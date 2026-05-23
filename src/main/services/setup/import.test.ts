/**
 * Tests for the setup importers. The functions under test orchestrate two
 * dependencies — `addServer` / `listServers` (MCP) and `setApiKey` (keys)
 * — plus a re-run of `runSetupDetection()` to pull fresh data. We mock
 * the dependencies so each test exercises just the import logic:
 * collision detection, idempotent re-runs, failure capture, env-var alias
 * walking, etc.
 *
 * Why not test through the real `addServer`? It spawns subprocesses for
 * MCP and writes to disk — neither is appropriate for a unit-test cycle.
 * The import functions are thin enough that mocking is exactly the right
 * weight here; behaviour of `addServer` itself is covered elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the dependencies that have side effects. The mock factories must
// match the module's actual export shape — addServer is async, listServers
// is sync, setApiKey is sync.
vi.mock('../mcp/manager', () => ({
  addServer: vi.fn(async (input: { name: string }) => ({
    id: `id-${input.name}`,
    name: input.name,
    enabled: true,
    connected: true,
    error: null,
    tools: []
  })),
  listServers: vi.fn(() => [])
}))

vi.mock('../storage/keys', () => ({
  setApiKey: vi.fn()
}))

vi.mock('../logger', () => ({
  log: vi.fn()
}))

// runSetupDetection is mocked per-test so individual cases can stub a
// specific set of detected servers without touching the filesystem.
vi.mock('./detect', () => ({
  runSetupDetection: vi.fn()
}))

import { addServer, listServers } from '../mcp/manager'
import { setApiKey } from '../storage/keys'
import { runSetupDetection } from './detect'
import {
  importClaudeDesktopServers,
  importCursorServers,
  importEnvKey
} from './import'
import type { SetupReport } from '@shared/types'

const addServerMock = vi.mocked(addServer)
const listServersMock = vi.mocked(listServers)
const setApiKeyMock = vi.mocked(setApiKey)
const detectMock = vi.mocked(runSetupDetection)

function fakeReport(overrides: Partial<SetupReport> = {}): SetupReport {
  return {
    claudeDesktop: { installed: false, mcpServers: [] },
    cursor: { installed: false, mcpServers: [] },
    chatgptDesktop: { installed: false },
    envKeys: [],
    localProviders: [],
    generatedAt: new Date().toISOString(),
    ...overrides
  }
}

beforeEach(() => {
  addServerMock.mockClear()
  listServersMock.mockReset().mockReturnValue([])
  setApiKeyMock.mockClear()
  detectMock.mockReset()
})

afterEach(() => {
  // Restore env vars stubbed inside individual tests.
  vi.unstubAllEnvs()
})

/* ----------------------- importClaudeDesktopServers ------------------ */

describe('importClaudeDesktopServers', () => {
  it('imports each named server via addServer', async () => {
    detectMock.mockReturnValue(
      fakeReport({
        claudeDesktop: {
          installed: true,
          path: '/fake',
          mcpServers: [
            {
              name: 'filesystem',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
              env: {},
              source: 'claude-desktop',
              missingEnv: []
            },
            {
              name: 'github',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              env: { GITHUB_TOKEN: 'ghp_x' },
              source: 'claude-desktop',
              missingEnv: []
            }
          ]
        }
      })
    )
    const result = await importClaudeDesktopServers(['filesystem', 'github'])
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.failures).toEqual([])
    expect(addServerMock).toHaveBeenCalledTimes(2)
    expect(addServerMock).toHaveBeenCalledWith({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: {}
    })
  })

  it('skips names that already exist in VoidSoul (idempotent)', async () => {
    listServersMock.mockReturnValue([
      {
        id: 'existing',
        name: 'filesystem',
        enabled: true,
        connected: true,
        error: null,
        tools: []
      }
    ])
    detectMock.mockReturnValue(
      fakeReport({
        claudeDesktop: {
          installed: true,
          path: '/fake',
          mcpServers: [
            {
              name: 'filesystem',
              command: 'npx',
              args: [],
              env: {},
              source: 'claude-desktop',
              missingEnv: []
            }
          ]
        }
      })
    )
    const result = await importClaudeDesktopServers(['filesystem'])
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.failures).toEqual([])
    expect(addServerMock).not.toHaveBeenCalled()
  })

  it('reports failure when a name is missing from the source config', async () => {
    detectMock.mockReturnValue(fakeReport()) // empty mcpServers
    const result = await importClaudeDesktopServers(['ghost'])
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].name).toBe('ghost')
    expect(result.failures[0].reason).toMatch(/not found/i)
  })

  it('captures addServer throws as failures, continues with the rest', async () => {
    detectMock.mockReturnValue(
      fakeReport({
        claudeDesktop: {
          installed: true,
          path: '/fake',
          mcpServers: [
            { name: 'a', command: 'echo', args: [], env: {}, source: 'claude-desktop', missingEnv: [] },
            { name: 'b', command: 'echo', args: [], env: {}, source: 'claude-desktop', missingEnv: [] }
          ]
        }
      })
    )
    addServerMock.mockRejectedValueOnce(new Error('boom'))
    const result = await importClaudeDesktopServers(['a', 'b'])
    expect(result.imported).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toEqual({ name: 'a', reason: 'boom' })
  })

  it('treats two requests for the same name as one — second skips', async () => {
    // The Set in importMcpFromSource deduplicates the input list, but we
    // also lock-in newly-added names so a second-time addServer can't
    // explode if the user double-clicked import.
    detectMock.mockReturnValue(
      fakeReport({
        claudeDesktop: {
          installed: true,
          path: '/fake',
          mcpServers: [
            { name: 'twice', command: 'echo', args: [], env: {}, source: 'claude-desktop', missingEnv: [] }
          ]
        }
      })
    )
    const result = await importClaudeDesktopServers(['twice', 'twice'])
    // Set dedups → only one addServer call, only one "imported" count.
    expect(result.imported).toBe(1)
    expect(addServerMock).toHaveBeenCalledTimes(1)
  })
})

describe('importCursorServers', () => {
  it('reads the cursor branch of the report, not the claude branch', async () => {
    // Same name lives in both branches with different commands — the cursor
    // importer must pick the cursor one.
    detectMock.mockReturnValue(
      fakeReport({
        claudeDesktop: {
          installed: true,
          path: '/c',
          mcpServers: [
            { name: 'fs', command: 'claude-cmd', args: [], env: {}, source: 'claude-desktop', missingEnv: [] }
          ]
        },
        cursor: {
          installed: true,
          path: '/cur',
          mcpServers: [
            { name: 'fs', command: 'cursor-cmd', args: [], env: {}, source: 'cursor', missingEnv: [] }
          ]
        }
      })
    )
    const result = await importCursorServers(['fs'])
    expect(result.imported).toBe(1)
    expect(addServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'cursor-cmd' })
    )
  })
})

/* ------------------------------ env-key ------------------------------ */

describe('importEnvKey', () => {
  it('writes the key from ANTHROPIC_API_KEY into the keychain', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-real-key-value')
    const result = importEnvKey('anthropic')
    expect(result.success).toBe(true)
    expect(setApiKeyMock).toHaveBeenCalledWith('anthropic', 'sk-ant-real-key-value')
  })

  it('walks aliases — GOOGLE_API_KEY then GEMINI_API_KEY for gemini', () => {
    vi.stubEnv('GOOGLE_API_KEY', '')          // empty — skip
    vi.stubEnv('GEMINI_API_KEY', 'AIza-real') // populated — use this one
    const result = importEnvKey('gemini')
    expect(result.success).toBe(true)
    expect(setApiKeyMock).toHaveBeenCalledWith('gemini', 'AIza-real')
  })

  it('returns failure when no alias is set', () => {
    // No vi.stubEnv calls — all aliases come back undefined.
    const result = importEnvKey('mistral')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no env var set/i)
    expect(setApiKeyMock).not.toHaveBeenCalled()
  })

  it('returns failure for a provider with no env convention (local)', () => {
    const result = importEnvKey('ollama')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no env-var convention/i)
  })

  it('trims whitespace before storing', () => {
    vi.stubEnv('OPENAI_API_KEY', '   sk-spaced-out   ')
    const result = importEnvKey('openai')
    expect(result.success).toBe(true)
    expect(setApiKeyMock).toHaveBeenCalledWith('openai', 'sk-spaced-out')
  })

  it('captures setApiKey throws as an error', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-x')
    setApiKeyMock.mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })
    const result = importEnvKey('anthropic')
    expect(result.success).toBe(false)
    expect(result.error).toBe('keychain locked')
  })
})
