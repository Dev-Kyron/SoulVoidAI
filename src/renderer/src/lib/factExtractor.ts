/**
 * Long-term memory extractor. After a conversation turn, this asks the
 * configured model to pull durable user facts ("solo-dev of Spiritless in
 * UE5", "prefers concise answers") from the recent transcript and persists
 * them through the memory store so they're injected into future sessions.
 *
 * Each fact may optionally be scoped to one or more workflow modes — so an
 * "Indie Dev" detail doesn't bloat the system prompt while you're in Writer
 * mode. The extractor decides per fact, given the currently active mode.
 *
 * Best-effort: failures are swallowed silently — extraction must never
 * interrupt the user's primary conversation.
 */
import { vs } from './bridge'
import { uid, createLock } from './utils'
import { useConfigStore } from '../store/useConfigStore'
import { useMemoryStore } from '../store/useMemoryStore'
import { MODES } from '@shared/modes'
import type { ChatMessage, ChatTurn, ModeId } from '@shared/types'

const KNOWN_MODE_IDS = new Set<ModeId>(MODES.map((m) => m.id))

function buildSystemPrompt(activeMode: ModeId): string {
  const modeList = MODES.map((m) => `  - "${m.id}" (${m.name})`).join('\n')
  return (
    'You extract durable user facts from conversation snippets for an AI assistant\'s long-term memory.\n' +
    'Output JSON only, with this exact shape:\n' +
    '  {"facts": [{"text": "fact one", "modes": ["indie-dev"]}, {"text": "fact two", "modes": null}]}\n\n' +
    'Include only facts worth remembering ACROSS future sessions:\n' +
    '- User identity, role, ongoing projects\n' +
    '- Stable preferences (e.g. "prefers concise replies", "wants Aussie spelling")\n' +
    '- Tools or tech they regularly use\n' +
    '- Recurring tasks or goals\n\n' +
    'EXCLUDE: transient questions, one-off tasks, generic chit-chat, facts already known.\n\n' +
    `The user is currently in "${activeMode}" mode. Tag each fact with the modes it stays useful in. ` +
    'Available modes:\n' +
    modeList +
    '\n\nRules for `modes`:\n' +
    '- Use `null` (or an empty array) for facts that apply universally ("prefers concise replies").\n' +
    `- Use just the current mode ("${activeMode}") for context-specific facts ("uses VS Code", "edits in OBS").\n` +
    '- Include multiple modes only when the fact genuinely applies to several (e.g. an identity fact relevant in both Creator and Streamer).\n\n' +
    'Keep each fact short (under 20 words), declarative, third-person ("user is…", "prefers…").\n' +
    'Return {"facts": []} when nothing new is worth remembering. Output JSON only — no prose.'
  )
}

/** Builds the snippet shown to the extractor model. */
function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-6) // recent context only — keeps token cost low
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
}

/** Coerces unknown modes input from the model into a clean ModeId[] (or undefined). */
function parseModes(raw: unknown): ModeId[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const filtered = raw.filter(
    (m): m is ModeId => typeof m === 'string' && KNOWN_MODE_IDS.has(m as ModeId)
  )
  return filtered.length > 0 ? filtered : undefined
}

const lock = createLock()

/**
 * Runs an extraction pass over the latest exchange. Concurrency-guarded so a
 * burst of replies only triggers one call. Returns the number of new facts
 * added (0 on no-op or failure).
 *
 * Pass `{ force: true }` for an explicit user-triggered extraction (the
 * "Remember this" composer button); that bypasses the auto-extract toggle.
 */
export async function extractFacts(
  messages: ChatMessage[],
  options: { force?: boolean } = {}
): Promise<number> {
  if (lock.isLocked) return 0
  const config = useConfigStore.getState().config
  if (!config) return 0
  // Respect the user's "auto-remember" preference — when off, only manual
  // facts (or an explicit force) get into long-term memory.
  if (!options.force && !config.chat.autoMemory) return 0
  const provider = config.providers.find((p) => p.id === config.activeProvider)
  if (!provider) return 0
  if (provider.needsKey && !provider.hasKey) return 0

  const transcript = buildTranscript(messages)
  if (!transcript) return 0

  const knownFacts = useMemoryStore.getState().data?.facts ?? []
  const known = knownFacts.length
    ? '\n\nAlready known (do NOT repeat these):\n' +
      knownFacts
        .map((f) => {
          const scope = f.modes && f.modes.length ? ` [${f.modes.join(', ')}]` : ''
          return `- ${f.text}${scope}`
        })
        .join('\n')
    : ''

  if (!lock.tryAcquire()) return 0
  try {
    const result = await vs.ai.invoke({
      requestId: uid(),
      provider: provider.id,
      model: provider.model,
      system: buildSystemPrompt(config.activeMode) + known,
      messages: [{ role: 'user', content: transcript }] as ChatTurn[]
    })
    if (result.error) {
      void vs.logs.write(
        'warn',
        'memory',
        'Fact extraction call failed',
        result.error
      )
      return 0
    }
    if (!result.text) {
      void vs.logs.write('warn', 'memory', 'Fact extractor returned no text')
      return 0
    }
    const match = result.text.match(/\{[\s\S]*\}/)
    if (!match) {
      void vs.logs.write(
        'warn',
        'memory',
        'Fact extractor reply lacked JSON',
        result.text.slice(0, 200)
      )
      return 0
    }
    let parsed: { facts?: unknown }
    try {
      parsed = JSON.parse(match[0]) as { facts?: unknown }
    } catch (err) {
      void vs.logs.write(
        'warn',
        'memory',
        'Fact extractor JSON parse failed',
        err instanceof Error ? err.message : String(err)
      )
      return 0
    }
    if (!Array.isArray(parsed.facts)) {
      void vs.logs.write(
        'warn',
        'memory',
        'Fact extractor reply missing `facts` array'
      )
      return 0
    }

    const add = useMemoryStore.getState().addFact
    let added = 0
    for (const raw of parsed.facts) {
      let text = ''
      let modes: ModeId[] | undefined
      // Accept both shapes — bare string (older payloads) or { text, modes }.
      if (typeof raw === 'string') {
        text = raw
      } else if (raw && typeof raw === 'object' && 'text' in raw) {
        const entry = raw as { text?: unknown; modes?: unknown }
        if (typeof entry.text !== 'string') continue
        text = entry.text
        modes = parseModes(entry.modes)
      } else {
        continue
      }
      const trimmed = text.trim()
      if (!trimmed || trimmed.length > 240) continue
      await add(trimmed, modes)
      added++
    }
    if (added > 0) {
      void vs.logs.write(
        'success',
        'memory',
        `Remembered ${added} new fact${added === 1 ? '' : 's'}`
      )
    }
    return added
  } catch (err) {
    void vs.logs.write(
      'warn',
      'memory',
      'Fact extraction threw',
      err instanceof Error ? err.message : String(err)
    )
    return 0
  } finally {
    lock.release()
  }
}
