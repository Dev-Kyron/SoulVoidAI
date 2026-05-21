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
