/**
 * Sentiment scheduler — counts exchanges + fires the classifier.
 *
 * Not actually a cron-style scheduler (the existing scheduled-tasks
 * subsystem is overkill for "every N user messages"). This is just a
 * counter that gets bumped from the chat-store side after each saved
 * exchange; when it crosses the threshold it kicks off a classify
 * call in the background and persists the result.
 *
 * Idempotent + non-blocking: callers should fire-and-forget
 * `maybeClassify()`; the function returns immediately with a Promise
 * that's safe to ignore. Errors are logged but never propagate.
 */
import { classifySentimentCached } from './sentiment'
import { recordSentiment, getCurrentSentiment, recentSentiments } from './sentimentStore'
import { getConfig } from '../storage/config'
import { getMemory } from '../storage/memory'
import { log } from '../logger'
import type {
  ChatTurn,
  EmotionalContextSnapshot,
  SessionSentiment
} from '@shared/types'

/** Fire the classifier once every N user messages. 5 is the default
 *  — frequent enough to catch shifting moods, sparse enough that the
 *  cost stays trivial across a long session. */
const EXCHANGES_PER_CLASSIFICATION = 5

/**
 * Per-thread message counter. Persists across module loads via the
 * thread-id key. Bumped from the chat store on each user-message save.
 * When a counter ticks past EXCHANGES_PER_CLASSIFICATION, classification
 * fires and the counter resets.
 */
const userMessageCounts = new Map<string, number>()

/**
 * Increment the counter for `threadId` and return whether we should
 * classify now. Caller is responsible for invoking maybeClassify() if so.
 */
function shouldClassify(threadId: string): boolean {
  const next = (userMessageCounts.get(threadId) ?? 0) + 1
  if (next >= EXCHANGES_PER_CLASSIFICATION) {
    userMessageCounts.set(threadId, 0)
    return true
  }
  userMessageCounts.set(threadId, next)
  return false
}

/**
 * Background classification fire. Caller passes the recent message
 * window; we classify + persist + log. Never throws.
 *
 * The returned promise is for tests / explicit awaits — production
 * callers should fire-and-forget so the chat stream isn't blocked on
 * a model round-trip.
 */
export async function classifyAndPersist(
  messages: ChatTurn[]
): Promise<SessionSentiment | null> {
  const config = getConfig()
  if (!config.memory.emotionalContext) return null
  if (config.chat.private) return null // Private mode: no classification

  const result = await classifySentimentCached({ messages })
  if (!result) return null

  try {
    const stored = recordSentiment({
      sentiment: result.sentiment,
      intensity: result.intensity,
      summary: result.summary || null
    })
    log(
      'info',
      'memory',
      `[sentiment] ${result.sentiment} (intensity ${result.intensity}): ${result.summary || '—'}`
    )
    return stored
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('warn', 'system', `[sentiment] persist failed: ${msg}`)
    return null
  }
}

/**
 * Chat-store hook: call after a user message lands. Bumps the per-thread
 * counter, fires `classifyAndPersist()` when the threshold trips. Pass
 * the recent message window so we don't re-fetch from the DB. Fire and
 * forget — return value (the in-flight promise) is for tests.
 */
export function onUserMessage(
  threadId: string,
  recentMessages: ChatTurn[]
): Promise<SessionSentiment | null> | null {
  if (!shouldClassify(threadId)) return null
  // Don't await — let the classification happen on its own clock so
  // chat streaming isn't blocked on a model round-trip.
  return classifyAndPersist(recentMessages)
}

/**
 * Snapshot for the system-prompt builder + Settings panel — current
 * session sentiment plus the most-recent "win" and "friction" memory
 * facts. Returns nulls when there's nothing to report.
 */
export function getEmotionalContext(): EmotionalContextSnapshot {
  const current = getCurrentSentiment()
  const facts = getMemory().facts
  // Most-recent fact tagged 'win' / 'friction'. Walk from newest to
  // oldest; assume facts are in insertion order (newest last).
  let lastWin: { text: string; createdAt: string } | null = null
  let lastFriction: { text: string; createdAt: string } | null = null
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i]
    if (!lastWin && f.emotionalTag === 'win') {
      lastWin = { text: f.text, createdAt: f.createdAt }
    }
    if (!lastFriction && f.emotionalTag === 'friction') {
      lastFriction = { text: f.text, createdAt: f.createdAt }
    }
    if (lastWin && lastFriction) break
  }
  return { current, lastWin, lastFriction }
}

/* ----------------------------- prompt block ----------------------------- */

/**
 * Pretty-prints the emotional-context snapshot into a system-prompt
 * block. Empty string when there's nothing meaningful to surface —
 * the system-prompt builder skips the section in that case.
 */
export function buildSentimentPromptBlock(): string {
  const ctx = getEmotionalContext()
  if (!ctx.current && !ctx.lastWin && !ctx.lastFriction) return ''

  const lines: string[] = ['<sentiment>']
  if (ctx.current) {
    const label = ctx.current.sentiment
    const intensity = ctx.current.intensity
    const summary = ctx.current.summary?.trim()
    lines.push(
      `Current session: ${label} (intensity ${intensity}/5)` +
        (summary ? `. ${summary}` : '.')
    )
  }
  if (ctx.lastWin) {
    lines.push(`Last win: ${ctx.lastWin.text} (${relativeAgo(ctx.lastWin.createdAt)})`)
  }
  if (ctx.lastFriction) {
    lines.push(
      `Last friction: ${ctx.lastFriction.text} (${relativeAgo(ctx.lastFriction.createdAt)})`
    )
  }
  lines.push(
    'Read this context as background — it informs how you respond, but',
    'you should never quote it verbatim or break the fourth wall about it.'
  )
  lines.push('</sentiment>')
  return lines.join('\n')
}

/** Cheap "12 min ago" / "3 hr ago" / "2 d ago" formatter. */
function relativeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  return `${d} d ago`
}

/* ----------------------------- exported helpers ------------------------- */

export function getRecentSentimentHistory(limit = 10): SessionSentiment[] {
  return recentSentiments(limit)
}
