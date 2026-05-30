/**
 * Tests for v2.0 Phase 4 taught-click pure logic.
 *
 * `normalizeDescription` is the lookup key — any drift between teach
 * time and click time silently misses, so the rules need test
 * coverage. `saveTaughtClick` + `findTaughtByDescription` +
 * `recordTaughtHit` + `removeTaughtClick` round-trip is also tested
 * with a clean module reset per case so the JsonStore in-memory
 * cache doesn't leak between tests.
 *
 * `resolveTaughtClick` needs UIA + PowerShell + a real Windows host
 * to test meaningfully; integration coverage lives in the bench
 * report and `npm run dev` smoke testing.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock — `electron` is unavailable in vitest's environment;
// JsonStore in `storage/store.ts` calls `app.getPath('userData')`
// during construction, which we redirect to an isolated tmp dir per
// test run.
const USERDATA = '/tmp/voidsoul-taught-test'
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA }
}))

// Re-import inside each test so the JsonStore module-level cache
// resets. Without this, test 2's read returns test 1's writes from
// memory even after we delete the file.
async function freshModule(): Promise<typeof import('./taughtClicks')> {
  vi.resetModules()
  return import('./taughtClicks')
}

beforeEach(() => {
  // Nuke prior state — both file AND module cache get reset.
  if (existsSync(USERDATA)) rmSync(USERDATA, { recursive: true, force: true })
  mkdirSync(USERDATA, { recursive: true })
})
afterEach(() => {
  if (existsSync(USERDATA)) rmSync(USERDATA, { recursive: true, force: true })
})

describe('normalizeDescription', () => {
  it('lowercases', async () => {
    const { normalizeDescription } = await freshModule()
    expect(normalizeDescription('Send Button')).toBe('send button')
  })
  it('collapses internal whitespace', async () => {
    const { normalizeDescription } = await freshModule()
    expect(normalizeDescription('send   the   message')).toBe('send the message')
  })
  it('trims leading/trailing whitespace', async () => {
    const { normalizeDescription } = await freshModule()
    expect(normalizeDescription('  send  ')).toBe('send')
  })
  it('returns empty string for empty input', async () => {
    const { normalizeDescription } = await freshModule()
    expect(normalizeDescription('')).toBe('')
    expect(normalizeDescription('   ')).toBe('')
  })
  it('treats tabs and newlines as whitespace', async () => {
    const { normalizeDescription } = await freshModule()
    expect(normalizeDescription('send\tthe\nmessage')).toBe('send the message')
  })
})

describe('taught-click store round-trip', () => {
  it('saves and finds a click by normalized description', async () => {
    const { saveTaughtClick, findTaughtByDescription } = await freshModule()
    saveTaughtClick({
      rawDescription: 'Send Button',
      name: 'Send',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Slack'
    })
    const found = findTaughtByDescription('SEND  button', 'Slack')
    expect(found).not.toBeNull()
    expect(found?.name).toBe('Send')
    expect(found?.inWindow).toBe('Slack')
  })

  it('honours inWindow scope — entry taught for Slack does not match a global lookup', async () => {
    // CRITICAL regression guard. Pre-polish, findTaughtByDescription
    // matched by description alone, so a taught entry for inWindow=Slack
    // would silently click Discord when the AI's call lacked
    // in_window. After polish, the lookup keys on (description, inWindow)
    // together — global lookup → match only entries taught without
    // a window scope.
    const { saveTaughtClick, findTaughtByDescription } = await freshModule()
    saveTaughtClick({
      rawDescription: 'send',
      name: 'Send',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Slack'
    })
    expect(findTaughtByDescription('send', null)).toBeNull()
    expect(findTaughtByDescription('send', 'Slack')?.inWindow).toBe('Slack')
    expect(findTaughtByDescription('send', 'Discord')).toBeNull()
    // Case-insensitive on window name.
    expect(findTaughtByDescription('send', 'slack')?.inWindow).toBe('Slack')
  })

  it('returns null for unknown descriptions', async () => {
    const { saveTaughtClick, findTaughtByDescription } = await freshModule()
    saveTaughtClick({
      rawDescription: 'send',
      name: 'Send',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    expect(findTaughtByDescription('publish', null)).toBeNull()
    expect(findTaughtByDescription('', null)).toBeNull()
  })

  it('throws when description is empty', async () => {
    const { saveTaughtClick } = await freshModule()
    expect(() =>
      saveTaughtClick({
        rawDescription: '   ',
        name: 'Send',
        automationId: '',
        controlType: 'ControlType.Button',
        inWindow: null
      })
    ).toThrow(/Description is required/)
  })

  it('throws when neither name nor automationId present', async () => {
    const { saveTaughtClick } = await freshModule()
    expect(() =>
      saveTaughtClick({
        rawDescription: 'send',
        name: '',
        automationId: '',
        controlType: 'ControlType.Button',
        inWindow: null
      })
    ).toThrow(/Name or AutomationId/)
  })

  it('overwrites a duplicate description+inWindow rather than accumulating', async () => {
    const { saveTaughtClick, listTaughtClicks } = await freshModule()
    saveTaughtClick({
      rawDescription: 'send',
      name: 'OldSend',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Slack'
    })
    saveTaughtClick({
      rawDescription: 'send',
      name: 'NewSend',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Slack'
    })
    const list = listTaughtClicks()
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('NewSend')
  })

  it('treats same description in different windows as distinct entries', async () => {
    const { saveTaughtClick, listTaughtClicks } = await freshModule()
    saveTaughtClick({
      rawDescription: 'send',
      name: 'A',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Slack'
    })
    saveTaughtClick({
      rawDescription: 'send',
      name: 'B',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: 'Discord'
    })
    expect(listTaughtClicks().length).toBe(2)
  })

  it('records a hit and updates lastUsedAt + hitCount', async () => {
    const { saveTaughtClick, recordTaughtHit, findTaughtByDescription } = await freshModule()
    const saved = saveTaughtClick({
      rawDescription: 'send',
      name: 'Send',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    expect(saved.hitCount).toBe(0)
    expect(saved.lastUsedAt).toBeNull()
    recordTaughtHit(saved.id)
    const found = findTaughtByDescription('send', null)
    expect(found?.hitCount).toBe(1)
    expect(found?.lastUsedAt).not.toBeNull()
  })

  it('record-hit on unknown id is a no-op (silent)', async () => {
    const { recordTaughtHit } = await freshModule()
    expect(() => recordTaughtHit('does-not-exist')).not.toThrow()
  })

  it('removes by id', async () => {
    const { saveTaughtClick, removeTaughtClick, listTaughtClicks } = await freshModule()
    const a = saveTaughtClick({
      rawDescription: 'send',
      name: 'A',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    saveTaughtClick({
      rawDescription: 'close',
      name: 'B',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    removeTaughtClick(a.id)
    const list = listTaughtClicks()
    expect(list.length).toBe(1)
    expect(list[0].rawDescription).toBe('close')
  })

  it('list is sorted most-recent-first by lastUsedAt fallback capturedAt', async () => {
    const { saveTaughtClick, recordTaughtHit, listTaughtClicks } = await freshModule()
    const a = saveTaughtClick({
      rawDescription: 'first',
      name: 'A',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    await new Promise((r) => setTimeout(r, 10))
    saveTaughtClick({
      rawDescription: 'second',
      name: 'B',
      automationId: '',
      controlType: 'ControlType.Button',
      inWindow: null
    })
    await new Promise((r) => setTimeout(r, 10))
    recordTaughtHit(a.id)
    const list = listTaughtClicks()
    // `a` was just hit, so its lastUsedAt > b's capturedAt → ranks first.
    expect(list[0].rawDescription).toBe('first')
    expect(list[1].rawDescription).toBe('second')
  })
})
