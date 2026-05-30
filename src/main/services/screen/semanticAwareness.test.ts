/**
 * v2.0 polish — coverage for semanticAwareness's debounce, dedup, in-flight
 * guard, and the "user toggled off mid-OCR" race. The full screenshot →
 * OCR → broadcast pipeline is heavy (Electron + tesseract.js WASM); we
 * fake captureScreen + extractText + isGranted + broadcast at the module
 * boundary so the tests stay sub-second.
 *
 * What we lock in:
 *  - Debounce coalesces rapid alt-tab into one capture.
 *  - In-flight guard drops overlapping requests.
 *  - Toggle-off mid-OCR fires a null broadcast + drops the late snapshot.
 *  - OCR failure still emits a snapshot (with empty text) so the renderer
 *    knows the window changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks with permissive signatures — the production callers pass varied
// argument shapes (event name + payload, log level + scope + message,
// etc) and we don't care about the shape, only the call count + the args.
const broadcastMock = vi.fn<(...args: unknown[]) => void>()
const captureScreenMock = vi.fn<(...args: unknown[]) => unknown>()
const extractTextMock = vi.fn<(...args: unknown[]) => unknown>()
const isGrantedMock = vi.fn<(...args: unknown[]) => boolean>(() => true)
const logMock = vi.fn<(...args: unknown[]) => void>()

vi.mock('../../events', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }))
vi.mock('../permissions/permissions', () => ({
  isGranted: (...args: unknown[]) => isGrantedMock(...args)
}))
vi.mock('../logger', () => ({ log: (...args: unknown[]) => logMock(...args) }))
vi.mock('./screenshot', () => ({
  captureScreen: (...args: unknown[]) => captureScreenMock(...args)
}))
vi.mock('./ocr', () => ({ extractText: (...args: unknown[]) => extractTextMock(...args) }))

// Import AFTER mocks so the module picks up the fakes.
import {
  _resetForTests,
  isSemanticAwarenessEnabled,
  noteWindowChange,
  setSemanticAwareness
} from './semanticAwareness'

const DEBOUNCE_MS = 3000

function defaultShot(): { path: string; dataUrl: string; width: number; height: number } {
  return { path: '', dataUrl: 'data:image/png;base64,xxx', width: 1920, height: 1080 }
}

beforeEach(() => {
  vi.useFakeTimers()
  broadcastMock.mockReset()
  captureScreenMock.mockReset()
  extractTextMock.mockReset()
  isGrantedMock.mockReset().mockReturnValue(true)
  logMock.mockReset()
  _resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('setSemanticAwareness', () => {
  it('refuses when screenCapture permission is not granted', () => {
    isGrantedMock.mockReturnValueOnce(false)
    const result = setSemanticAwareness(true)
    expect(result).toBe(false)
    expect(isSemanticAwarenessEnabled()).toBe(false)
  })

  it('clears the snapshot on disable so the renderer drops stale OCR', () => {
    setSemanticAwareness(true)
    broadcastMock.mockClear()
    setSemanticAwareness(false)
    expect(broadcastMock).toHaveBeenCalledWith('screen:snapshot', null)
  })

  it('is idempotent — second enable does not re-log', () => {
    setSemanticAwareness(true)
    logMock.mockClear()
    setSemanticAwareness(true)
    expect(logMock).not.toHaveBeenCalled()
  })
})

describe('noteWindowChange', () => {
  it('debounces rapid window changes into one capture', async () => {
    captureScreenMock.mockResolvedValue(defaultShot())
    extractTextMock.mockResolvedValue({ text: 'hello', confidence: 92 })
    setSemanticAwareness(true)

    noteWindowChange({ title: 'A', process: 'a.exe' })
    noteWindowChange({ title: 'B', process: 'b.exe' })
    noteWindowChange({ title: 'C', process: 'c.exe' })

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    // Drain microtasks for the OCR resolution.
    await vi.runAllTimersAsync()

    expect(captureScreenMock).toHaveBeenCalledTimes(1)
    // The final title is what the user rested on, so it should win.
    const lastBroadcast = broadcastMock.mock.calls.find((c) => c[0] === 'screen:snapshot')
    expect(lastBroadcast?.[1]).toMatchObject({ title: 'C', process: 'c.exe' })
  })

  it('does nothing when semantic awareness is off', async () => {
    noteWindowChange({ title: 'A', process: 'a.exe' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    expect(captureScreenMock).not.toHaveBeenCalled()
  })

  it('skips capture entirely when both title and process are empty', async () => {
    setSemanticAwareness(true)
    noteWindowChange({ title: '', process: '' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    expect(captureScreenMock).not.toHaveBeenCalled()
  })

  it('drops the snapshot when semantic awareness is toggled off mid-OCR', async () => {
    // Hold the OCR open so we can flip the toggle while it's running.
    let resolveOcr: (v: { text: string; confidence: number }) => void = () => {}
    captureScreenMock.mockResolvedValue(defaultShot())
    extractTextMock.mockImplementation(
      () =>
        new Promise<{ text: string; confidence: number }>((r) => {
          resolveOcr = r
        })
    )
    setSemanticAwareness(true)
    noteWindowChange({ title: 'Slow', process: 'slow.exe' })

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    // Capture is now in flight, awaiting our manual OCR resolve.
    expect(captureScreenMock).toHaveBeenCalledTimes(1)
    // No broadcast yet — OCR hasn't resolved and we haven't toggled off.
    expect(broadcastMock).not.toHaveBeenCalled()

    // User toggles off mid-capture → null broadcast fires to clear the
    // renderer's cached snapshot; the in-flight capture should NOT emit
    // a snapshot when it finishes.
    setSemanticAwareness(false)
    expect(broadcastMock).toHaveBeenCalledWith('screen:snapshot', null)
    broadcastMock.mockClear()

    resolveOcr({ text: 'late', confidence: 90 })
    await vi.runAllTimersAsync()

    // No additional snapshot from the late OCR — the post-OCR enabled
    // check should have short-circuited it.
    expect(
      broadcastMock.mock.calls.filter((c) => c[0] === 'screen:snapshot' && c[1] !== null)
    ).toHaveLength(0)
  })

  it('still broadcasts a snapshot (with empty text) when OCR throws', async () => {
    captureScreenMock.mockResolvedValue(defaultShot())
    extractTextMock.mockRejectedValue(new Error('tesseract cold-start failed'))
    setSemanticAwareness(true)
    noteWindowChange({ title: 'NoOCR', process: 'broken.exe' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    await vi.runAllTimersAsync()

    const snap = broadcastMock.mock.calls.find(
      (c) => c[0] === 'screen:snapshot' && c[1] !== null
    )?.[1]
    expect(snap).toMatchObject({
      title: 'NoOCR',
      process: 'broken.exe',
      text: '',
      confidence: 0
    })
  })

  it('drops a new capture while a prior one is in flight', async () => {
    let resolveOcr: (v: { text: string; confidence: number }) => void = () => {}
    captureScreenMock.mockResolvedValue(defaultShot())
    extractTextMock.mockImplementationOnce(
      () =>
        new Promise<{ text: string; confidence: number }>((r) => {
          resolveOcr = r
        })
    )
    setSemanticAwareness(true)

    // First capture — will hang awaiting our manual OCR resolve.
    noteWindowChange({ title: 'First', process: 'first.exe' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    expect(captureScreenMock).toHaveBeenCalledTimes(1)

    // Second capture queued + fires while first is still in flight.
    noteWindowChange({ title: 'Second', process: 'second.exe' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)
    // The in-flight guard means captureScreen is NOT called again.
    expect(captureScreenMock).toHaveBeenCalledTimes(1)

    resolveOcr({ text: 'first ocr', confidence: 95 })
    await vi.runAllTimersAsync()
  })
})
