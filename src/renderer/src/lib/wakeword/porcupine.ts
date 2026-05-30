/**
 * Picovoice Porcupine wake-word engine. The "upgrade" backend — runs when the
 * user has a Picovoice access key configured. Lower CPU than the Whisper
 * default and tuned for the wake-word task, but needs an account at
 * console.picovoice.ai (free for personal use) plus optional custom .ppn
 * keyword files for "Hey Void" / "Hey Soul". Without .ppn files, falls back
 * to built-in keywords ("computer" / "jarvis") so the user can still test.
 *
 * **Code-splitting:** both SDKs land in a lazy chunk via dynamic `import()`
 * — the Porcupine WASM payload only fetches if this engine is actually
 * selected by the router (Picovoice key present).
 */
import type { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web'
import { vs } from '../bridge'
import type { WakeDetectCallback, WakeEngine } from './types'
import type { VoicePersona } from '@shared/types'

interface PorcupineModules {
  PorcupineWorker: (typeof import('@picovoice/porcupine-web'))['PorcupineWorker']
  BuiltInKeyword: (typeof import('@picovoice/porcupine-web'))['BuiltInKeyword']
  WebVoiceProcessor: (typeof import('@picovoice/web-voice-processor'))['WebVoiceProcessor']
}

let modulesPromise: Promise<PorcupineModules> | null = null

function loadPorcupineModules(): Promise<PorcupineModules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('@picovoice/porcupine-web'),
      import('@picovoice/web-voice-processor')
    ]).then(([porcupine, processor]) => ({
      PorcupineWorker: porcupine.PorcupineWorker,
      BuiltInKeyword: porcupine.BuiltInKeyword,
      WebVoiceProcessor: processor.WebVoiceProcessor
    }))
  }
  return modulesPromise
}

interface KeywordSlot {
  persona: VoicePersona
  label: string
  customBase64: string | null
}

export function createPorcupineWakeEngine(
  accessKey: string,
  onDetect: WakeDetectCallback
): WakeEngine {
  let worker: PorcupineWorker | null = null

  async function start(): Promise<void> {
    if (worker) return // idempotent

    const slots: KeywordSlot[] = [
      { persona: 'void', label: 'Hey Void', customBase64: await vs.wakeWord.keywordBytes('void') },
      { persona: 'soul', label: 'Hey Soul', customBase64: await vs.wakeWord.keywordBytes('soul') }
    ]

    const modules = await loadPorcupineModules()

    // Per-persona built-in fallback when the user hasn't trained a .ppn file.
    const fallback: Record<VoicePersona, BuiltInKeyword> = {
      void: modules.BuiltInKeyword.Computer,
      soul: modules.BuiltInKeyword.Jarvis
    }
    const keywords = slots.map((slot) =>
      slot.customBase64
        ? { base64: slot.customBase64, label: slot.label, sensitivity: 0.55 }
        : { builtin: fallback[slot.persona], label: slot.label, sensitivity: 0.5 }
    )

    const created = await modules.PorcupineWorker.create(
      accessKey,
      keywords,
      (detection) => {
        const slot = slots.find((s) => s.label === detection.label)
        const persona = slot?.persona ?? 'void'
        onDetect(persona, detection.label)
      },
      { publicPath: undefined }
    )
    await modules.WebVoiceProcessor.subscribe(created)
    worker = created
  }

  async function stop(): Promise<void> {
    const local = worker
    if (!local) return
    worker = null
    try {
      // Only unsubscribe if the SDK module promise actually resolved — if
      // start() failed mid-way the promise might still be pending.
      if (modulesPromise) {
        const { WebVoiceProcessor } = await modulesPromise
        await WebVoiceProcessor.unsubscribe(local)
      }
      await local.release()
      local.terminate()
    } catch (err) {
      // The mic might already be released, the worker may have crashed —
      // either way the engine's gone. Log so a wedged WASM teardown
      // doesn't disappear into the void.
      void vs.logs.write(
        'warn',
        'system',
        'Porcupine engine stop() failed',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  return { start, stop }
}
