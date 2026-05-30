/**
 * SQLite read/write for the v1.4.0 emotional-context subsystem.
 *
 * Lives in `session_sentiment` (migration v8). One row per classifier
 * run — never updated in place. The "current session" is just the row
 * with `session_end IS NULL`; a new classification result writes a new
 * row and stamps the previous one's `session_end` when it represents a
 * different session window (>= SESSION_GAP_MS apart from the previous
 * computed_at).
 *
 * Why append-only over upsert: history is the feature. Rolling up
 * "stressed for the last 3 hours, productive for the 2 hours before
 * that" is the kind of thing the system prompt + the Settings panel
 * need to read. Mutating a single current-session row loses that.
 *
 * Privacy: the entire table is local SQLite under userData/voidsoul-
 * data/voidsoul.db. The "Forget last 7 days" Settings button calls
 * forgetRecentSentiment() which deletes by computed_at, no model
 * round-trip needed.
 */
import { db } from '../storage/db'
import type { SessionSentiment, SessionSentimentLabel } from '@shared/types'

/**
 * Gap that separates two "sessions". 30 min of silence between
 * classifications = the next one is a new session. Tweakable.
 */
const SESSION_GAP_MS = 30 * 60 * 1000

interface SentimentRow {
  id: number
  session_start: string
  session_end: string | null
  sentiment: SessionSentimentLabel
  intensity: number
  summary: string | null
  computed_at: string
}

function fromRow(row: SentimentRow): SessionSentiment {
  return {
    id: row.id,
    sessionStart: row.session_start,
    sessionEnd: row.session_end,
    sentiment: row.sentiment,
    intensity: row.intensity,
    summary: row.summary,
    computedAt: row.computed_at
  }
}

/**
 * Record a new classification result. Stamps the previous open-ended
 * session's `session_end` if the new classification falls outside the
 * SESSION_GAP_MS window — that's the only way we know one session ended
 * and another began.
 */
export function recordSentiment(input: {
  sentiment: SessionSentimentLabel
  intensity: number
  summary: string | null
}): SessionSentiment {
  const now = new Date().toISOString()
  const handle = db()

  // Find the currently-open session, if any.
  const current = handle
    .prepare<
      unknown[],
      SentimentRow
    >(`SELECT * FROM session_sentiment WHERE session_end IS NULL ORDER BY computed_at DESC LIMIT 1`)
    .get()

  let sessionStart = now
  if (current) {
    const elapsed = Date.parse(now) - Date.parse(current.computed_at)
    if (elapsed < SESSION_GAP_MS) {
      // Same session continues — inherit its start timestamp.
      sessionStart = current.session_start
    } else {
      // Session boundary crossed. Close the old session by stamping
      // its end at the previous computed_at (when we last had signal).
      handle
        .prepare(`UPDATE session_sentiment SET session_end = ? WHERE id = ?`)
        .run(current.computed_at, current.id)
    }
  }

  // Capture the previous label BEFORE the insert so we can detect a
  // genuine label shift below. Same query that finds `current` above
  // — already in scope. Use it before the new row replaces it.
  const previousLabel = current?.sentiment ?? null

  const result = handle
    .prepare(
      `INSERT INTO session_sentiment
         (session_start, session_end, sentiment, intensity, summary, computed_at)
       VALUES (?, NULL, ?, ?, ?, ?)`
    )
    .run(sessionStart, input.sentiment, input.intensity, input.summary, now)

  const id = Number(result.lastInsertRowid)

  // v1.5.0 — emit sentiment-shift ONLY when the label actually changed.
  // Earlier draft emitted on every classification + relied on the watch
  // task throttle (30 min default) to suppress noise; that's correct
  // semantics but bad signal — a productive→stuck→productive flicker
  // within the throttle window would fire on the first stuck without
  // surfacing the second. Now: real shifts only, watch task's own
  // params.to filter narrows further (e.g. "only when shifting TO stuck").
  // First-ever classification with no previous label also counts as a
  // shift — the user's first emotional state of the session is a signal
  // worth surfacing.
  const isShift = previousLabel !== input.sentiment
  if (isShift) {
    void import('../proactive/watchTasks')
      .then(({ onWatchEvent }) => {
        onWatchEvent({
          type: 'sentiment-shift',
          payload: { sentiment: input.sentiment }
        })
      })
      .catch(() => {
        /* proactive subsystem not loaded — non-fatal */
      })
  }

  return {
    id,
    sessionStart,
    sessionEnd: null,
    sentiment: input.sentiment,
    intensity: input.intensity,
    summary: input.summary,
    computedAt: now
  }
}

/**
 * The currently-open session row, or null if none yet. The system
 * prompt uses this to populate the `<sentiment>` block; Settings shows
 * the same data.
 */
export function getCurrentSentiment(): SessionSentiment | null {
  const row = db()
    .prepare<
      unknown[],
      SentimentRow
    >(`SELECT * FROM session_sentiment WHERE session_end IS NULL ORDER BY computed_at DESC LIMIT 1`)
    .get()
  return row ? fromRow(row) : null
}

/**
 * Recent sentiment history, newest first. Default 10 rows is enough for
 * a "last 7 days" rollup at ~1 classification per 30-min session.
 */
export function recentSentiments(limit = 10): SessionSentiment[] {
  const rows = db()
    .prepare<
      [number],
      SentimentRow
    >(`SELECT * FROM session_sentiment ORDER BY computed_at DESC LIMIT ?`)
    .all(limit)
  return rows.map(fromRow)
}

/**
 * Privacy escape hatch — wipe everything classified in the last N days
 * (default 7). Used by the Settings "Forget recent emotional context"
 * button. Doesn't touch the underlying chat history; only the sentiment
 * rollups vanish.
 */
export function forgetRecentSentiment(days = 7): { deleted: number } {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const result = db().prepare(`DELETE FROM session_sentiment WHERE computed_at >= ?`).run(cutoff)
  return { deleted: result.changes }
}
