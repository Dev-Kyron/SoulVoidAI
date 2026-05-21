/**
 * Per-extension text extractor for file RAG. The actual file I/O + parsing
 * (PDF, DOCX, plain text) is delegated to the RAG worker thread; this module
 * keeps the supported-extension table and the public `extractFile` shape so
 * callers (and tests) don't see the worker plumbing.
 *
 * Extraction errors are caught and surfaced as null — a single bad file
 * never aborts a folder scan.
 */
import { extname } from 'node:path'
import { log } from '../logger'
import { extractFileViaWorker } from '../rag-worker'
import { isSupportedExtension } from './extensions'

export function isSupportedFile(path: string): boolean {
  return isSupportedExtension(extname(path))
}

export interface FileMetadata {
  size: number
  mtime: string
  sha: string
}

export interface ExtractedFile {
  path: string
  text: string
  meta: FileMetadata
}

/**
 * Extracts text + content fingerprint for a single file. The heavy lifting
 * (file read, PDF/DOCX parsing) runs in the RAG worker thread so a folder
 * scan never blocks the UI on a slow PDF.
 */
export async function extractFile(path: string): Promise<ExtractedFile | null> {
  if (!isSupportedFile(path)) return null
  try {
    const result = await extractFileViaWorker({ path })
    if (!result) return null
    return {
      path: result.path,
      text: result.text,
      meta: { size: result.size, mtime: result.mtime, sha: result.sha }
    }
  } catch (err) {
    log(
      'warn',
      'files-rag',
      `Could not extract text from ${path}`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}
