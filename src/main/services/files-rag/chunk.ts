/**
 * Pure-function text chunker for the file RAG pipeline. Splits a document into
 * roughly token-sized windows with overlap so semantic queries can hit
 * boundary-spanning passages.
 *
 * Tokens are estimated as `chars/3.5` (the same rough heuristic the cost
 * tracker uses). Chunk sizes are tuned for `text-embedding-3-small`:
 *  - target ~400 tokens (~1400 chars) per chunk
 *  - 80-token (~280-char) overlap between consecutive chunks
 *  - prefers paragraph + line boundaries when one falls inside the window
 *
 * The chunker is exported separately so it can be unit-tested without any
 * filesystem or database dependencies.
 */
export interface Chunk {
  index: number
  text: string
  /** Character offset of the chunk's start within the original document. */
  start: number
}

export interface ChunkOptions {
  /** Target chunk size in characters. Default 1400. */
  size?: number
  /** Overlap between consecutive chunks in characters. Default 280. */
  overlap?: number
}

const DEFAULT_SIZE = 1400
const DEFAULT_OVERLAP = 280

/**
 * Splits `text` into overlapping windows. When possible, the window end is
 * pulled back to the nearest paragraph or newline within the last ~20% of the
 * window, so chunks don't slice mid-sentence.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return []
  const size = options.size ?? DEFAULT_SIZE
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.floor(size / 2))

  if (trimmed.length <= size) {
    return [{ index: 0, text: trimmed, start: 0 }]
  }

  const chunks: Chunk[] = []
  let cursor = 0
  let index = 0
  // 20% lookback for paragraph/line boundary snapping.
  const snapWindow = Math.floor(size * 0.2)

  while (cursor < trimmed.length) {
    const target = Math.min(cursor + size, trimmed.length)
    let end = target
    if (target < trimmed.length) {
      const snapFrom = Math.max(target - snapWindow, cursor + 1)
      const slice = trimmed.slice(snapFrom, target)
      const paragraph = slice.lastIndexOf('\n\n')
      const newline = slice.lastIndexOf('\n')
      const period = slice.lastIndexOf('. ')
      const boundary = paragraph >= 0 ? paragraph : newline >= 0 ? newline : period
      if (boundary >= 0) end = snapFrom + boundary + 1
    }
    const chunk = trimmed.slice(cursor, end).trim()
    if (chunk) chunks.push({ index, text: chunk, start: cursor })
    index++
    if (end >= trimmed.length) break
    cursor = Math.max(end - overlap, cursor + 1)
  }
  return chunks
}
