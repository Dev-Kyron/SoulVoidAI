/**
 * Tests for the persona bundle round-trip. The bundle format is the
 * shared contract a future community gallery / friend's export will
 * land on disk as; locking it down here prevents a silent field-rename
 * from corrupting bundles that other people have already shipped.
 */
import { describe, expect, it } from 'vitest'
import { bundleFilename, bundleToTemplate, builtInModeToBundle, toPersonaBundle } from './personas'
import type { PersonaBundle, PersonaTemplate } from './types'

const SAMPLE_TEMPLATE: PersonaTemplate = {
  id: 'persona-game-designer-abc',
  name: 'Game Designer (UE5)',
  tagline: 'Unreal-focused dev',
  accent: 'violet',
  prompt: 'You are assisting a Unreal Engine 5 game designer...',
  recommendedProvider: 'anthropic',
  recommendedModel: 'claude-sonnet-4-5',
  samplePrompts: [
    'Help me set up a new C++ actor class',
    'Profile this UE5 scene and find perf hotspots'
  ],
  baseMode: 'indie-dev',
  createdBy: 'Kyron',
  createdAt: '2026-05-28T12:34:56.000Z'
}

describe('toPersonaBundle', () => {
  it('omits the runtime-only id and keeps every populated field', () => {
    const bundle = toPersonaBundle(SAMPLE_TEMPLATE)
    expect(bundle.kind).toBe('voidsoul-persona')
    expect(bundle.version).toBe(1)
    expect(bundle).not.toHaveProperty('id')
    expect(bundle.name).toBe(SAMPLE_TEMPLATE.name)
    expect(bundle.tagline).toBe(SAMPLE_TEMPLATE.tagline)
    expect(bundle.accent).toBe(SAMPLE_TEMPLATE.accent)
    expect(bundle.prompt).toBe(SAMPLE_TEMPLATE.prompt)
    expect(bundle.recommendedProvider).toBe('anthropic')
    expect(bundle.recommendedModel).toBe('claude-sonnet-4-5')
    expect(bundle.samplePrompts).toEqual(SAMPLE_TEMPLATE.samplePrompts)
    expect(bundle.baseMode).toBe('indie-dev')
    expect(bundle.createdBy).toBe('Kyron')
    expect(bundle.createdAt).toBe(SAMPLE_TEMPLATE.createdAt)
  })

  it('drops empty optional fields so the bundle stays tight', () => {
    const minimal: PersonaTemplate = {
      id: 'x',
      name: 'Bare',
      prompt: 'Just the prompt.',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    const bundle = toPersonaBundle(minimal)
    expect(bundle).not.toHaveProperty('tagline')
    expect(bundle).not.toHaveProperty('accent')
    expect(bundle).not.toHaveProperty('samplePrompts')
    expect(bundle).not.toHaveProperty('recommendedModel')
    expect(bundle).not.toHaveProperty('baseMode')
  })

  it('drops samplePrompts when present but empty', () => {
    const template: PersonaTemplate = {
      ...SAMPLE_TEMPLATE,
      samplePrompts: []
    }
    const bundle = toPersonaBundle(template)
    expect(bundle).not.toHaveProperty('samplePrompts')
  })
})

describe('bundleToTemplate', () => {
  it('round-trips: template → bundle → template preserves payload (minus id)', () => {
    const bundle = toPersonaBundle(SAMPLE_TEMPLATE)
    const reborn = bundleToTemplate(bundle)
    // id is regenerated from the bundle's name + a timestamp suffix; we
    // don't compare it to the source template, only assert the shape.
    expect(reborn.id).toMatch(/^persona-game-designer-ue5-/)
    expect(reborn.name).toBe(SAMPLE_TEMPLATE.name)
    expect(reborn.prompt).toBe(SAMPLE_TEMPLATE.prompt)
    expect(reborn.recommendedModel).toBe(SAMPLE_TEMPLATE.recommendedModel)
    expect(reborn.samplePrompts).toEqual(SAMPLE_TEMPLATE.samplePrompts)
    expect(reborn.baseMode).toBe(SAMPLE_TEMPLATE.baseMode)
    expect(reborn.createdBy).toBe(SAMPLE_TEMPLATE.createdBy)
    expect(reborn.createdAt).toBe(SAMPLE_TEMPLATE.createdAt)
  })

  it('mints an id slug derived from the persona name', () => {
    const bundle = toPersonaBundle(SAMPLE_TEMPLATE)
    const generated = bundleToTemplate(bundle)
    // Format: `persona-${slug}-${msTimestamp}-${rand4}`. The trailing
    // random suffix (added in v2.0 polish) makes two same-millisecond
    // imports yield distinct ids so the storage upsert lands two rows
    // instead of overwriting the first.
    expect(generated.id).toMatch(/^persona-game-designer-ue5-[a-z0-9]+-[a-z0-9]{4}$/)
  })

  it('mints distinct ids for synchronous bundleToTemplate calls', () => {
    // Pre-polish, two synchronous imports could share the millisecond
    // timestamp and collide on id; the storage upsert would then merge
    // them silently. The 4-char base36 random suffix (~1.7M combinations)
    // closes that — vanishingly rare to collide twice in the same
    // millisecond. Asserted here so a future refactor that strips the
    // suffix breaks loudly.
    const bundle = toPersonaBundle(SAMPLE_TEMPLATE)
    const a = bundleToTemplate(bundle)
    const b = bundleToTemplate(bundle)
    expect(a.id).not.toBe(b.id)
  })

  it('trims sample prompts and drops empty strings', () => {
    const bundle: PersonaBundle = {
      kind: 'voidsoul-persona',
      version: 1,
      name: 'Trimmer',
      prompt: 'p',
      samplePrompts: ['  real prompt  ', '', '   ', 'another']
    }
    const template = bundleToTemplate(bundle)
    expect(template.samplePrompts).toEqual(['real prompt', 'another'])
  })

  it('uses now() for createdAt when the bundle omits it', () => {
    const bundle: PersonaBundle = {
      kind: 'voidsoul-persona',
      version: 1,
      name: 'No date',
      prompt: 'p'
    }
    const template = bundleToTemplate(bundle)
    expect(template.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('builtInModeToBundle', () => {
  it('produces a valid bundle from a built-in mode shape', () => {
    const bundle = builtInModeToBundle({
      id: 'researcher',
      name: 'Researcher',
      tagline: 'Search, read, capture.',
      accent: 'green',
      prompt: 'You are assisting research.'
    })
    expect(bundle.kind).toBe('voidsoul-persona')
    expect(bundle.baseMode).toBe('researcher')
    expect(bundle.createdBy).toBe('VoidSoul (built-in)')
    expect(bundle.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('bundleFilename', () => {
  it('slugifies the name into a .voidsoul-persona.json filename', () => {
    expect(
      bundleFilename({
        kind: 'voidsoul-persona',
        version: 1,
        name: 'Game Designer (UE5)',
        prompt: 'p'
      })
    ).toBe('game-designer-ue5.voidsoul-persona.json')
  })

  it('falls back to "persona" when the name has no alphanumerics', () => {
    expect(
      bundleFilename({
        kind: 'voidsoul-persona',
        version: 1,
        name: '!!! ???',
        prompt: 'p'
      })
    ).toBe('persona.voidsoul-persona.json')
  })
})
