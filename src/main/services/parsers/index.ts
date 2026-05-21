/**
 * Dynamic-import wrappers for the two document parsers we depend on:
 * `pdf-parse` and `mammoth`. Both modules ship without proper TypeScript
 * declarations, so the shape cast lives here in one place — earlier we had
 * two hand-typed copies (worker + IPC file-picker) that would drift the next
 * time either package's exports moved.
 *
 * Each helper takes a Buffer and returns plain text. Errors throw — callers
 * decide whether to swallow or log. Module-shape mismatches surface as a
 * single, clear Error instead of "returns null with no warning."
 */

/**
 * Extracts text from a PDF buffer.
 *
 * Both the v1 default-export API (`pdfParse(buffer).text`) and the v2 class
 * API (`new PDFParse({data}).getText()`) live in the wild; we use whichever
 * the installed `pdf-parse` exposes.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod = (await import('pdf-parse')) as unknown as {
    PDFParse?: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text: string }>
      destroy(): Promise<void>
    }
    default?: (data: Buffer) => Promise<{ text: string }>
  }
  if (mod.PDFParse) {
    const parser = new mod.PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return result.text ?? ''
    } finally {
      await parser.destroy().catch(() => {
        /* best-effort */
      })
    }
  }
  if (mod.default) {
    const result = await mod.default(buffer)
    return result.text ?? ''
  }
  throw new Error(
    'pdf-parse module shape unknown — neither PDFParse class nor default function found.'
  )
}

/** Hard cap for any extracted document text we hand to the model. */
const MAX_EXTRACTED_TEXT = 200_000

/**
 * `extractPdfText` wrapped with the same trim + friendly-error fallback both
 * IPC callers want — avoids two copies drifting if either changes.
 */
export async function extractPdfTextSafe(buffer: Buffer, name: string): Promise<string> {
  try {
    const raw = await extractPdfText(buffer)
    const text = raw.trim().slice(0, MAX_EXTRACTED_TEXT)
    return text || `(no text extractable from ${name})`
  } catch (err) {
    return `(could not read ${name}: ${err instanceof Error ? err.message : 'unknown error'})`
  }
}

/** Extracts text from a DOCX buffer via mammoth. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const mod = (await import('mammoth')) as unknown as {
    default?: {
      extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>
    }
    extractRawText?: (opts: { buffer: Buffer }) => Promise<{ value: string }>
  }
  const extract = mod.default?.extractRawText ?? mod.extractRawText
  if (!extract) {
    throw new Error(
      'mammoth.extractRawText not found — DOCX support is broken (module shape drift?)'
    )
  }
  const result = await extract({ buffer })
  return result.value ?? ''
}
