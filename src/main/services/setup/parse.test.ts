/**
 * Tests for the pure config parsers used by setup detection. Filesystem
 * + env-var paths are exercised by integration in detect.ts; the parsers
 * here are kept pure so a malformed-config fixture is a one-line test.
 *
 * Why parse.ts gets its own test suite rather than testing through
 * detect.ts: parser bugs would otherwise hide behind "did the file exist
 * on this machine?" — the report is empty either way. Pure tests rule
 * out parser regressions independently of platform-specific filesystem
 * state.
 */
import { describe, expect, it } from 'vitest'
import { ENV_KEY_PROVIDERS, keyPreview, parseMcpServersBlock } from './parse'

describe('parseMcpServersBlock', () => {
  it('returns empty for non-object input', () => {
    expect(parseMcpServersBlock(null, 'claude-desktop')).toEqual([])
    expect(parseMcpServersBlock(undefined, 'claude-desktop')).toEqual([])
    expect(parseMcpServersBlock(42, 'claude-desktop')).toEqual([])
    expect(parseMcpServersBlock('string', 'claude-desktop')).toEqual([])
  })

  it('returns empty when mcpServers key is missing or wrong type', () => {
    expect(parseMcpServersBlock({}, 'cursor')).toEqual([])
    expect(parseMcpServersBlock({ mcpServers: null }, 'cursor')).toEqual([])
    expect(parseMcpServersBlock({ mcpServers: 'oops' }, 'cursor')).toEqual([])
  })

  it('parses a well-formed Claude Desktop config', () => {
    const config = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/x/code']
        },
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' }
        }
      }
    }
    const out = parseMcpServersBlock(config, 'claude-desktop')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/x/code'],
      env: {},
      source: 'claude-desktop',
      missingEnv: []
    })
    expect(out[1].env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' })
    expect(out[1].missingEnv).toEqual([])
  })

  it('captures empty env values as missingEnv', () => {
    const config = {
      mcpServers: {
        notion: {
          command: 'npx',
          args: ['-y', '@notionhq/notion-mcp-server'],
          // User set up the entry but left the token blank — flag it so
          // the import dialog can prompt them.
          env: { NOTION_API_KEY: '' }
        }
      }
    }
    const out = parseMcpServersBlock(config, 'claude-desktop')
    expect(out[0].missingEnv).toEqual(['NOTION_API_KEY'])
  })

  it('drops rows with no command', () => {
    const config = {
      mcpServers: {
        broken: { args: ['x'] },
        empty: { command: '' },
        nullcmd: { command: null },
        valid: { command: 'echo' }
      }
    }
    const out = parseMcpServersBlock(config, 'cursor')
    expect(out.map((r) => r.name)).toEqual(['valid'])
  })

  it('drops rows whose name has shell-suspect characters', () => {
    const config = {
      mcpServers: {
        'rm -rf /': { command: 'echo' },
        'good-name': { command: 'echo' },
        '../../etc/passwd': { command: 'echo' },
        'also_ok.123': { command: 'echo' }
      }
    }
    const out = parseMcpServersBlock(config, 'cursor')
    expect(out.map((r) => r.name).sort()).toEqual(['also_ok.123', 'good-name'])
  })

  it('coerces non-array args to empty list, non-object env to empty dict', () => {
    const config = {
      mcpServers: {
        weird: { command: 'echo', args: 'not-an-array', env: 'also-not-a-dict' }
      }
    }
    const out = parseMcpServersBlock(config, 'claude-desktop')
    expect(out[0].args).toEqual([])
    expect(out[0].env).toEqual({})
  })

  it('skips non-string args entries (mixed array)', () => {
    const config = {
      mcpServers: {
        mix: { command: 'npx', args: ['-y', 42, '@scope/pkg', null, 'arg2'] }
      }
    }
    const out = parseMcpServersBlock(config, 'claude-desktop')
    expect(out[0].args).toEqual(['-y', '@scope/pkg', 'arg2'])
  })

  it('preserves source tag for each row', () => {
    const config = { mcpServers: { x: { command: 'npx' } } }
    expect(parseMcpServersBlock(config, 'claude-desktop')[0].source).toBe('claude-desktop')
    expect(parseMcpServersBlock(config, 'cursor')[0].source).toBe('cursor')
  })

  it('preserves iteration order of source object', () => {
    const config = {
      mcpServers: {
        zulu: { command: 'a' },
        alpha: { command: 'b' },
        mike: { command: 'c' }
      }
    }
    const out = parseMcpServersBlock(config, 'cursor')
    expect(out.map((r) => r.name)).toEqual(['zulu', 'alpha', 'mike'])
  })
})

describe('keyPreview', () => {
  it('redacts short strings entirely', () => {
    expect(keyPreview('short')).toBe('••••••')
    expect(keyPreview('')).toBe('••••••')
    // Boundary: 13 chars (under threshold) → fully redacted.
    expect(keyPreview('1234567890123')).toBe('••••••')
  })

  it('shows first 8 + last 4 for normal keys', () => {
    // Boundary: 14 chars (at threshold) → preview format.
    expect(keyPreview('12345678901234')).toBe('12345678…1234')
    expect(keyPreview('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-xyz9')).toBe('sk-ant-a…xyz9')
  })

  it('trims surrounding whitespace before measuring', () => {
    expect(keyPreview('   short   ')).toBe('••••••')
    expect(keyPreview('  sk-ant-api03-abcdefghijklmnop-z9z9  ')).toBe('sk-ant-a…z9z9')
  })

  it('never leaks the middle of the key', () => {
    const secret = 'sk-MIDDLE_SECRET_PORTION_SHOULD_NEVER_APPEAR_HERE_xyz9'
    const preview = keyPreview(secret)
    expect(preview).not.toContain('MIDDLE')
    expect(preview).not.toContain('SECRET')
  })
})

describe('ENV_KEY_PROVIDERS map', () => {
  it('covers every cloud provider that uses an API key', () => {
    const cloudProviders = [
      'anthropic',
      'openai',
      'gemini',
      'groq',
      'xai',
      'openrouter',
      'deepseek',
      'mistral'
    ]
    const covered = new Set(Object.values(ENV_KEY_PROVIDERS))
    for (const p of cloudProviders) {
      expect(covered.has(p as never)).toBe(true)
    }
  })

  it('does NOT include local-only providers', () => {
    const covered = new Set(Object.values(ENV_KEY_PROVIDERS))
    for (const local of ['ollama', 'lmstudio', 'llamacpp', 'custom']) {
      expect(covered.has(local as never)).toBe(false)
    }
  })

  it('maps both Google env-var aliases to gemini', () => {
    expect(ENV_KEY_PROVIDERS.GOOGLE_API_KEY).toBe('gemini')
    expect(ENV_KEY_PROVIDERS.GEMINI_API_KEY).toBe('gemini')
  })
})
