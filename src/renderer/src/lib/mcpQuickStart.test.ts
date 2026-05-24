/**
 * v1.12.0 — Quick Start profile resolution tests. The resolver filters
 * marketplace entries against the eligibility rules and matches profile
 * IDs against what's actually loaded. Both paths are easy to break with
 * a small refactor — the test pins them.
 */
import { describe, it, expect } from 'vitest'
import type { McpRegistryEntry } from '@shared/types'
import {
  filterZeroConfigEntries,
  resolveProfileEntries,
  QUICK_START_PROFILES,
  type QuickStartProfile
} from './mcpQuickStart'

/** Minimal McpRegistryEntry factory. Defaults make a zero-config curated
 *  entry; override fields per test to flip eligibility. */
function makeEntry(overrides: Partial<McpRegistryEntry> = {}): McpRegistryEntry {
  return {
    id: 'test',
    name: 'Test server',
    description: 'Test',
    category: 'utility',
    tags: [],
    command: 'npx',
    args: [],
    env: {},
    argPrompts: [],
    envPrompts: [],
    source: 'curated',
    ...overrides
  } as McpRegistryEntry
}

describe('filterZeroConfigEntries', () => {
  it('keeps curated entries with no prompts and no requires', () => {
    const entries = [
      makeEntry({ id: 'a' }),
      makeEntry({ id: 'b' })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('drops entries with arg prompts (needs a file path / value)', () => {
    const entries = [
      makeEntry({ id: 'keep' }),
      makeEntry({
        id: 'drop',
        argPrompts: [{ key: 'PATH', label: 'Folder', description: '', type: 'folder' }]
      })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['keep'])
  })

  it('drops entries with env prompts (needs an API key)', () => {
    const entries = [
      makeEntry({ id: 'keep' }),
      makeEntry({
        id: 'drop',
        envPrompts: [{ key: 'TOKEN', label: 'Token', description: '', secret: true }]
      })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['keep'])
  })

  it('drops entries with a system requires (uv/docker/etc)', () => {
    const entries = [
      makeEntry({ id: 'keep' }),
      makeEntry({ id: 'drop', requires: 'uv' })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['keep'])
  })

  it('drops discovery-only entries (no install command)', () => {
    const entries = [
      makeEntry({ id: 'keep' }),
      makeEntry({ id: 'drop', discoveryOnly: true })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['keep'])
  })

  it('drops community-source entries (only curated qualifies for bulk install)', () => {
    const entries = [
      makeEntry({ id: 'curated-keep', source: 'curated' }),
      makeEntry({ id: 'pulse-drop', source: 'pulsemcp' }),
      makeEntry({ id: 'smithery-drop', source: 'smithery' }),
      makeEntry({ id: 'glama-drop', source: 'glama' })
    ]
    expect(filterZeroConfigEntries(entries).map((e) => e.id)).toEqual(['curated-keep'])
  })
})

describe('resolveProfileEntries', () => {
  it('returns entries in the order listed by the profile, not registry order', () => {
    const profile: QuickStartProfile = {
      id: 'test',
      name: 'Test',
      tagline: '',
      description: '',
      entryIds: ['b', 'a']
    }
    const loaded = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]
    expect(resolveProfileEntries(profile, loaded).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('silently drops profile IDs not present in the loaded set', () => {
    const profile: QuickStartProfile = {
      id: 'test',
      name: 'Test',
      tagline: '',
      description: '',
      entryIds: ['a', 'missing', 'b']
    }
    const loaded = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]
    expect(resolveProfileEntries(profile, loaded).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('all-zero-config returns every eligible entry', () => {
    const profile = QUICK_START_PROFILES.find((p) => p.id === 'everything')!
    const loaded = [
      makeEntry({ id: 'a' }),
      makeEntry({ id: 'b' }),
      makeEntry({ id: 'needs-key', envPrompts: [{ key: 'K', label: '', description: '', secret: true }] })
    ]
    expect(resolveProfileEntries(profile, loaded).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('honours eligibility — never returns an entry that fails the filter', () => {
    const profile: QuickStartProfile = {
      id: 'test',
      name: 'Test',
      tagline: '',
      description: '',
      entryIds: ['needs-key']
    }
    const loaded = [
      makeEntry({
        id: 'needs-key',
        envPrompts: [{ key: 'K', label: '', description: '', secret: true }]
      })
    ]
    expect(resolveProfileEntries(profile, loaded)).toEqual([])
  })
})

describe('QUICK_START_PROFILES catalogue', () => {
  it('has unique profile ids', () => {
    const ids = QUICK_START_PROFILES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the Essentials and Everything profiles by id', () => {
    const ids = QUICK_START_PROFILES.map((p) => p.id)
    expect(ids).toContain('essentials')
    expect(ids).toContain('everything')
  })
})
