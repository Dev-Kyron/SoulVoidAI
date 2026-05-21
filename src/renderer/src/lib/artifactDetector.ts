/**
 * Streaming-artifact detector. Watches the assistant's in-progress text for
 * a fenced code block long enough to warrant the Canvas dialog, and surfaces
 * the block's content + language. Once detected we keep pushing updates as
 * the model writes more so the user sees the code grow live, Claude-style.
 *
 * Heuristics (intentionally conservative so casual snippets don't pop the
 * dialog on every reply):
 *  - Block must have a language tag (` ```python `, ` ```html `) — avoids
 *    triggering on prose fenced as inline `code`.
 *  - Block must be ≥ 200 chars OR ≥ 8 lines to be considered "artifact-
 *    worthy". Below that it's a snippet and the inline bubble is fine.
 *  - We track the LAST block in the buffer (the one the model is currently
 *    writing). When that block closes (` ``` ` line), the artifact is
 *    finalised; further deltas don't update it.
 */

export interface ArtifactCandidate {
  /** Language tag from the fence (e.g. `python`, `html`, `tsx`). */
  language: string
  /** The block's current code body — may grow as the stream continues. */
  code: string
  /** Whether the closing ` ``` ` has been seen — true once the artifact is final. */
  closed: boolean
}

const MIN_CHARS = 200
const MIN_LINES = 8

/**
 * Locates the LAST fenced code block in `text` and returns it if it meets
 * the artifact threshold. Returns null when there's no qualifying block —
 * e.g. only inline ` `code` ` or short snippets.
 */
export function detectArtifact(text: string): ArtifactCandidate | null {
  // Scan for fence-opens with a non-empty language tag. The `\n` after the
  // lang prevents matching `\`\`\`x` mid-line (commonly used in prose).
  const opens: Array<{ index: number; lang: string; bodyStart: number }> = []
  const fenceRe = /(^|\n)```([a-zA-Z][\w+.#-]*)\n/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text))) {
    opens.push({
      index: m.index + (m[1] ? 1 : 0),
      lang: m[2].toLowerCase(),
      bodyStart: m.index + m[0].length
    })
  }
  if (opens.length === 0) return null

  // Use the last open — that's the block the model is currently writing if
  // the stream is in progress, or the most recent one if it's finished.
  const last = opens[opens.length - 1]
  const after = text.slice(last.bodyStart)
  const closeIdx = after.indexOf('\n```')
  const body = closeIdx === -1 ? after : after.slice(0, closeIdx)
  const closed = closeIdx !== -1

  // Threshold gate: only surface to the canvas if substantial.
  const lineCount = (body.match(/\n/g)?.length ?? 0) + 1
  if (body.length < MIN_CHARS && lineCount < MIN_LINES) return null

  return { language: last.lang, code: body, closed }
}
