/**
 * Integration test for the persistent Python kernel. Spins up a real
 * `python` / `python3` subprocess and exercises the JSON protocol end
 * to end. Skipped when Python isn't on PATH (CI without Python set up
 * would otherwise red-flag every run).
 *
 * The test deliberately uses the same kernel across multiple runCode
 * calls to verify state persists — which is the whole point of v2.0's
 * sandbox versus the v1 ephemeral exec.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PythonKernel } from './kernel'

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3'

function pythonAvailable(): boolean {
  try {
    const result = spawnSync(PYTHON_CMD, ['--version'], { encoding: 'utf-8' })
    return result.status === 0
  } catch {
    return false
  }
}

const HAS_PYTHON = pythonAvailable()

// Electron's `app.getPath('userData')` only works inside the Electron
// runtime — vitest runs in plain Node, so we mock the module to point
// at a temp dir for the duration of the suite. Matches the pattern
// used in storage/db.test.ts + storage/history.test.ts.
const dataRoot = HAS_PYTHON ? mkdtempSync(join(tmpdir(), 'voidsoul-python-test-')) : ''

vi.mock('electron', () => ({
  app: {
    getPath: () => dataRoot
  }
}))

// Throwaway threadId for the test — the kernel will create
// dataRoot/voidsoul-data/python-workspaces/<id>/ which we clean up in
// afterAll alongside the whole temp root.
const TEST_THREAD = `__test-${Date.now()}`

let sharedKernel: PythonKernel | null = null

afterAll(async () => {
  if (sharedKernel) {
    await sharedKernel.kill()
  }
  if (dataRoot) {
    try {
      rmSync(dataRoot, { recursive: true, force: true })
    } catch {
      /* ignore cleanup races on Windows */
    }
  }
})

describe.skipIf(!HAS_PYTHON)('PythonKernel (integration)', () => {
  it('boots and reports its Python version', async () => {
    sharedKernel = await PythonKernel.spawn(TEST_THREAD)
    expect(sharedKernel.ready.python).toMatch(/^\d+\.\d+/)
    expect(sharedKernel.workspaceDir).toContain(TEST_THREAD)
    expect(sharedKernel.isAlive()).toBe(true)
  }, 15_000)

  it('captures stdout from a simple print', async () => {
    if (!sharedKernel) throw new Error('shared kernel not booted')
    const result = await sharedKernel.runCode('print("hello voidsoul")')
    expect(result.error).toBeNull()
    expect(result.stdout).toContain('hello voidsoul')
    expect(result.stderr).toBe('')
  }, 10_000)

  it('persists variables across runCode calls (the whole point)', async () => {
    if (!sharedKernel) throw new Error('shared kernel not booted')
    const first = await sharedKernel.runCode('x = 41\ny = x + 1')
    expect(first.error).toBeNull()
    // x and y should still be in scope here — that's what proves the
    // Jupyter-style state model is actually working.
    const second = await sharedKernel.runCode('print(y * 2)')
    expect(second.error).toBeNull()
    expect(second.stdout.trim()).toBe('84')
  }, 10_000)

  it('captures stderr separately from stdout', async () => {
    if (!sharedKernel) throw new Error('shared kernel not booted')
    const result = await sharedKernel.runCode(
      'import sys\nprint("normal")\nprint("oops", file=sys.stderr)'
    )
    expect(result.error).toBeNull()
    expect(result.stdout.trim()).toBe('normal')
    expect(result.stderr.trim()).toBe('oops')
  }, 10_000)

  it('returns the traceback string on a user-code exception, kernel survives', async () => {
    if (!sharedKernel) throw new Error('shared kernel not booted')
    const result = await sharedKernel.runCode('raise ValueError("boom")')
    expect(result.error).toContain('ValueError')
    expect(result.error).toContain('boom')
    // Crucially, the kernel didn't die.
    expect(sharedKernel.isAlive()).toBe(true)
    const recovery = await sharedKernel.runCode('print("still alive")')
    expect(recovery.error).toBeNull()
    expect(recovery.stdout.trim()).toBe('still alive')
  }, 10_000)

  it('rejects concurrent runCode against the same kernel', async () => {
    if (!sharedKernel) throw new Error('shared kernel not booted')
    const slow = sharedKernel.runCode('import time\ntime.sleep(0.5)\nprint("first")')
    await expect(sharedKernel.runCode('print("second")')).rejects.toThrow(/already executing/)
    // Drain the slow one so subsequent tests see a clean kernel.
    const slowResult = await slow
    expect(slowResult.stdout.trim()).toBe('first')
  }, 10_000)
})
