/**
 * Optical character recognition. Wraps tesseract.js (pure WASM, no native
 * dependencies). The library and English language data are downloaded and
 * cached on first use, so the very first OCR call needs network access.
 */
import type { OcrResult } from '@shared/types'

export async function extractText(imagePathOrDataUrl: string): Promise<OcrResult> {
  // Imported lazily so the ~megabyte WASM bundle is only loaded on demand.
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng')
  try {
    const { data } = await worker.recognize(imagePathOrDataUrl)
    return { text: data.text.trim(), confidence: Math.round(data.confidence) }
  } finally {
    await worker.terminate()
  }
}
