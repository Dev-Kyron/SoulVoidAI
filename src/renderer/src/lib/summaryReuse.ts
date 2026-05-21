/**
 * Pure helper that decides whether a cached "story so far" recap can be
 * reused against the current message list, and where the verbatim tail
 * should start.
 *
 * The lookup is keyed on `coversUpToId`, the only authoritative anchor on
 * the summary. After a backup import, a `clear()`, or any other reshape,
 * message indices shift but the boundary message's id is stable.
 */
import type { ChatMessage, HistorySummary } from '@shared/types'

export interface SummaryReuseResult {
  /** Index inside `all` where the still-verbatim tail begins. */
  cutoffIdx: number
}

/**
 * Returns reuse info when the cached summary is still safe to use, or null
 * when it isn't. Reuse requires:
 *  - a cached summary exists with a non-empty `coversUpToId`
 *  - the boundary message is still in `all`
 *  - the boundary isn't the very last message (otherwise the verbatim tail
 *    would be empty)
 *  - the tail after the boundary contains at least `keepRecentMin` messages
 *    so the model still sees enough recent context.
 */
export function canReuseSummary(
  cached: HistorySummary | null,
  all: ChatMessage[],
  keepRecentMin: number
): SummaryReuseResult | null {
  if (!cached || !cached.coversUpToId) return null
  const boundaryIdx = all.findIndex((m) => m.id === cached.coversUpToId)
  if (boundaryIdx < 0) return null
  if (boundaryIdx >= all.length - 1) return null
  const cutoffIdx = boundaryIdx + 1
  if (all.length - cutoffIdx < keepRecentMin) return null
  return { cutoffIdx }
}
