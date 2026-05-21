/**
 * Conversation summarizer. When a chat grows past the model's context window,
 * the older turns are rolled into a compact "story so far" recap that gets
 * prepended to the system prompt — so the assistant keeps continuity without
 * us silently dropping turns off the front.
 *
 * Best-effort: failures return null and the caller falls back to truncation.
 */
import { vs } from './bridge'
import { uid, createLock } from './utils'
import { useConfigStore } from '../store/useConfigStore'
import { capabilitiesOf } from '@shared/modelCapabilities'
import { WELCOME_MESSAGE_ID, type ChatMessage, type ChatTurn } from '@shared/types'

const SYSTEM_PROMPT =
  'You compress the earlier portion of a conversation between a user and an AI assistant ' +
  'into a compact recap so the assistant can keep continuity in a long chat.\n\n' +
  'Output prose only, under ~250 words. Cover:\n' +
  '- What the user is working on (projects, goals, ongoing tasks)\n' +
  '- Key decisions, agreements or open questions\n' +
  '- Important code paths, file names, tools or commands referenced\n' +
  '- The user\'s preferences and constraints surfaced in this chat\n\n' +
  'Skip greetings, pleasantries, and minor back-and-forth. Be specific and factual; ' +
  'omit speculation. Write in third person ("the user", "the assistant"). No headings — ' +
  'one flowing recap paragraph is fine.'

const lock = createLock()

/** Cheap conservative token estimate so we know when to summarize. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.id === WELCOME_MESSAGE_ID) continue
    chars += m.content.length
    for (const a of m.attachments ?? []) {
      if (a.kind === 'text' && a.text) chars += a.text.length
    }
  }
  // ~3.5 chars/token is a safe over-estimate for English prose.
  return Math.round(chars / 3.5)
}

/**
 * Hard cap on the transcript we send to the summariser. Most provider
 * context windows are 128k tokens; at ~3.5 chars/token that's ~450k chars,
 * but the summariser needs room for its own prompt AND its output. Capping
 * at 120k chars (~34k tokens) leaves comfortable headroom for the prompt,
 * a reasonable recap output, and provider-specific overhead.
 *
 * When the conversation actually exceeds this, we keep the OLDER portion
 * (which is what the summariser cares about) and add a marker noting that
 * we dropped material — so the recap doesn't pretend to cover what it
 * couldn't see.
 */
const MAX_TRANSCRIPT_CHARS = 120_000

function buildTranscript(messages: ChatMessage[]): string {
  const full = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => {
      const role = m.role === 'user' ? 'USER' : 'ASSISTANT'
      // Trim tool-call noise that's already collapsed in the message body.
      return `${role}: ${m.content.trim()}`
    })
    .join('\n\n')
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full
  // Keep the END of the transcript (most recent older messages) — the
  // beginning is least relevant to the running conversation. Drop the
  // front and stamp a marker so the model knows the recap is partial.
  const tail = full.slice(full.length - MAX_TRANSCRIPT_CHARS)
  return `[…earlier turns omitted due to length…]\n\n${tail}`
}

/**
 * Produces a summary of the supplied older messages. Returns null when the
 * configured provider is unavailable or the call fails.
 */
export async function summarizeOlderTurns(messages: ChatMessage[]): Promise<string | null> {
  if (lock.isLocked) return null
  const config = useConfigStore.getState().config
  if (!config) return null
  const provider = config.providers.find((p) => p.id === config.activeProvider)
  if (!provider) return null
  if (provider.needsKey && !provider.hasKey) return null

  const transcript = buildTranscript(messages)
  if (!transcript.trim()) return null

  if (!lock.tryAcquire()) return null
  try {
    const result = await vs.ai.invoke({
      requestId: uid(),
      provider: provider.id,
      model: provider.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }] as ChatTurn[]
    })
    if (result.error) {
      void vs.logs.write(
        'warn',
        'summarizer',
        'Conversation summary call failed',
        result.error
      )
      return null
    }
    if (!result.text) {
      void vs.logs.write('warn', 'summarizer', 'Conversation summary returned empty text')
      return null
    }
    void vs.logs.write(
      'info',
      'summarizer',
      `Compressed older turns into a ${result.text.trim().length}-char recap`
    )
    return result.text.trim()
  } catch (err) {
    void vs.logs.write(
      'warn',
      'summarizer',
      'Conversation summarizer threw',
      err instanceof Error ? err.message : String(err)
    )
    return null
  } finally {
    lock.release()
  }
}

/* ============================================================================
 *                       MID-LOOP AGENT-TURN COMPACTION
 *
 * Lets the agent loop survive runs that exceed the model's context window. On
 * every step the loop calls `compactTurnsIfNeeded` with the current turns
 * array; if the estimated token count crosses 60% of the model's reported
 * context window, the older portion gets compressed into a single "STORY SO
 * FAR" turn, the recent K turns stay verbatim, and the loop continues with
 * the slimmed-down array.
 *
 * Why 60%, not 95%: the next provider call needs room for the assistant's
 * REPLY plus any tool-result we'll append next step. Aggressive compaction
 * leaves comfortable headroom before context overflow surfaces as a hard
 * `stop_reason: length` from the provider.
 *
 * The recap is generated by the same summariser used for between-message
 * compaction (which already has the right prompt + lock + provider-fallback
 * behaviour). When the summariser declines (no usable provider, lock
 * contention, transient error) we return the original turns and let the
 * loop continue — better to risk one context-overflow than to deadlock.
 * ============================================================================
 */

/** Recent turns kept verbatim after a compaction — too few and the model
 *  loses local context, too many and the compaction barely buys anything. */
const KEEP_RECENT_TURNS = 6

/** Trigger compaction when estimated tokens crosses 60% of the model's
 *  reported context window. Leaves 40% headroom for reply + next-step
 *  tool output growth. */
const COMPACTION_TRIGGER_FRACTION = 0.6

/**
 * Conservative token estimate over the agent loop's ChatTurn[] array.
 * Counts character bytes (content + tool args + tool results) and divides
 * by 3.5 — the same ratio the message-level estimator uses. Cheap enough
 * to call once per step.
 */
export function estimateTurnTokens(turns: ChatTurn[]): number {
  let chars = 0
  for (const turn of turns) {
    if (typeof turn.content === 'string') chars += turn.content.length
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        chars += tc.name.length
        chars += JSON.stringify(tc.args).length
      }
    }
    if (turn.toolResults) {
      for (const tr of turn.toolResults) {
        chars += tr.content.length
      }
    }
    // Images count as ~1k tokens each per Anthropic's documented heuristic —
    // treat the renderer-side estimate conservatively at 4k chars/image.
    if (turn.images) chars += turn.images.length * 4_000
  }
  return Math.round(chars / 3.5)
}

/** Builds a plain-text transcript from a ChatTurn[] for the summariser. */
function buildTurnTranscript(turns: ChatTurn[]): string {
  return turns
    .map((turn) => {
      if (turn.role === 'user') return `USER: ${turn.content || '(no text)'}`
      if (turn.role === 'assistant') {
        const tools = turn.toolCalls?.length
          ? ` [+${turn.toolCalls.length} tool call(s)]`
          : ''
        return `ASSISTANT: ${turn.content || '(thinking)'}${tools}`
      }
      // Tool result turn — collapse to a one-line summary so the recap
      // doesn't drown in raw output.
      if (turn.role === 'tool') {
        const names = (turn.toolResults ?? []).map((t) => t.name).join(', ')
        return `TOOL RESULTS: ${names}`
      }
      return `${(turn.role as string).toUpperCase()}: ${turn.content ?? ''}`
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Drop the older portion of `turns` into a compressed STORY-SO-FAR summary,
 * keep the recent K turns verbatim, return the slimmed-down array.
 *
 * Behaviour:
 *   - Returns `{ turns, compacted: false }` when the array is already small
 *     enough, OR when the model's context window doesn't warrant compaction,
 *     OR when there aren't enough turns to be worth compacting.
 *   - Returns `{ turns: [recap, ...recent], compacted: true }` after a
 *     successful summarise-and-replace.
 *   - Returns the original turns (compacted: false) on summariser failure —
 *     better to let the next provider call risk overflow than to deadlock
 *     the agent on a transient summary error.
 *
 * @param turns      current agent loop turns array
 * @param modelId    the model the loop is talking to (drives the budget)
 * @param isLocal    whether the model runs locally (used for capability
 *                   resolution; doesn't affect context window choice)
 */
export async function compactTurnsIfNeeded(
  turns: ChatTurn[],
  modelId: string,
  isLocal: boolean
): Promise<{ turns: ChatTurn[]; compacted: boolean }> {
  if (turns.length <= KEEP_RECENT_TURNS) return { turns, compacted: false }

  const caps = capabilitiesOf(modelId, isLocal)
  const budget = caps.contextWindow * COMPACTION_TRIGGER_FRACTION
  const estimated = estimateTurnTokens(turns)
  if (estimated < budget) return { turns, compacted: false }

  const older = turns.slice(0, turns.length - KEEP_RECENT_TURNS)
  const recent = turns.slice(turns.length - KEEP_RECENT_TURNS)

  const recap = await summarizeAgentTurns(older)
  if (!recap) {
    // Summariser declined — pass through unchanged. The next provider call
    // may or may not overflow; if it does, the existing error surfaces.
    return { turns, compacted: false }
  }

  // The recap goes in as a "user" turn so it's part of the conversation
  // context the model is reasoning over, not a system-prompt override
  // (which different providers handle inconsistently when there's
  // already a system field set on the request).
  const recapTurn: ChatTurn = {
    role: 'user',
    content:
      '[STORY SO FAR — earlier turns compressed to fit the context window]\n\n' +
      recap +
      '\n\n[Recent turns continue below.]'
  }
  void vs.logs.write(
    'info',
    'summarizer',
    `Mid-loop compaction — ${older.length} older turns -> ~${recap.length} chars`
  )
  return { turns: [recapTurn, ...recent], compacted: true }
}

/**
 * Summarises agent-loop turns into a compact recap. Mirrors
 * `summarizeOlderTurns` but reads from ChatTurn[] (the agent's working
 * shape) rather than ChatMessage[] (the renderer's display shape).
 */
async function summarizeAgentTurns(turns: ChatTurn[]): Promise<string | null> {
  if (lock.isLocked) return null
  const config = useConfigStore.getState().config
  if (!config) return null
  const provider = config.providers.find((p) => p.id === config.activeProvider)
  if (!provider) return null
  if (provider.needsKey && !provider.hasKey) return null

  const transcript = buildTurnTranscript(turns)
  if (!transcript.trim()) return null
  // Respect the same per-call cap the message-level summariser uses so
  // we don't ship a 500k-character payload to the model.
  const bounded =
    transcript.length <= MAX_TRANSCRIPT_CHARS
      ? transcript
      : `[…earliest agent turns omitted due to length…]\n\n${transcript.slice(
          transcript.length - MAX_TRANSCRIPT_CHARS
        )}`

  if (!lock.tryAcquire()) return null
  try {
    const result = await vs.ai.invoke({
      requestId: uid(),
      provider: provider.id,
      model: provider.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: bounded }] as ChatTurn[]
    })
    if (result.error || !result.text) {
      void vs.logs.write(
        'warn',
        'summarizer',
        'Agent-loop summary call failed',
        result.error ?? 'empty response'
      )
      return null
    }
    return result.text.trim()
  } catch (err) {
    void vs.logs.write(
      'warn',
      'summarizer',
      'Agent-loop summariser threw',
      err instanceof Error ? err.message : String(err)
    )
    return null
  } finally {
    lock.release()
  }
}
