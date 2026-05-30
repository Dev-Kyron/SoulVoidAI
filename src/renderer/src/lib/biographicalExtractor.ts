/**
 * v2.0 — passive biographical profile extractor.
 *
 * Sibling to `factExtractor.ts`. Differences:
 *
 *  - **Runs every successful streaming reply** (debounced + locked),
 *    not only when the user types "remember this". Passive memory is
 *    the whole point.
 *  - **Categorized output** — the model emits one of six fixed
 *    categories per observation (identity / projects / preferences /
 *    relationships / tools / work-patterns) so the system-prompt
 *    injection can render readable grouped blocks instead of a flat
 *    bullet list.
 *  - **Storage applies confidence merge semantics**, not the renderer.
 *    The IPC shape only carries `(category, text)` — main owns the
 *    confidence / observations / timestamps so a buggy extractor
 *    can't backdate or over-confidence an entry through the wire.
 *
 * Cost: one LLM call per successful streaming reply. The module-level
 * lock de-dupes a CONCURRENT burst (e.g. rapid sends while a prior
 * extraction is in flight) but does NOT throttle sequential turns —
 * each completed reply pays. The same 6-message tail the fact extractor
 * uses keeps the token budget small (~150-300 tokens per pass), so the
 * recurring cost is bounded; for users on premium provider models the
 * total can still add up over a long session and `memory.extractionModel`
 * is the deferred follow-up to let them pin a cheap model just for
 * extraction (mirroring `memory.sentimentModel`).
 *
 * Best-effort everywhere: failures are swallowed and logged at warn
 * level so a wonky provider response can't interrupt the user's
 * primary conversation.
 */
import { vs } from './bridge'
import { uid, createLock } from './utils'
import { useConfigStore } from '../store/useConfigStore'
import { useMemoryStore } from '../store/useMemoryStore'
import type { BiographicalCategory, ChatMessage, ChatTurn } from '@shared/types'

/** Mirrors the storage cap in main/services/storage/memory.ts. Bumped
 *  here as the gate the renderer applies BEFORE writing to IPC so a
 *  burst of new observations during a long session can't blow past
 *  the cap on the way to the eviction logic. */
const RENDERER_BIO_HARD_CAP = 100

/**
 * Confidence floor for system-prompt injection. Entries below this stay
 * in the store (so a future mention CAN raise them past the threshold)
 * but are excluded from the active context so a single mis-extraction
 * can't bias the model. With INITIAL_BIO_CONFIDENCE = 0.5 and
 * BIO_CONFIDENCE_STEP = 0.125 (both in main/services/storage/memory.ts):
 *   - 1 mention  → 0.500 (hidden)
 *   - 2 mentions → 0.625 (still hidden)
 *   - 3 mentions → 0.750 (NOW visible — equals MIN_BIO_CONFIDENCE)
 * Tuned so quirks need three distinct mentions (one initial sighting
 * + two re-confirmations) before they shape the assistant's behaviour.
 */
export const MIN_BIO_CONFIDENCE = 0.75

const KNOWN_CATEGORIES = new Set<BiographicalCategory>([
  'identity',
  'projects',
  'preferences',
  'relationships',
  'tools',
  'work-patterns'
])

/** Render the curated category enum as a JSON-friendly list for the prompt. */
const CATEGORY_GLOSS = [
  '- "identity": user\'s role, title, location, anything stable about who they are',
  '- "projects": ongoing projects, codebases, codenames they reference repeatedly',
  '- "preferences": stable taste / style preferences ("concise replies", "Aussie spelling", "dark theme")',
  '- "relationships": named people / pets / team members they refer to',
  '- "tools": tools or tech they use regularly (VS Code, OBS, Unreal, Figma)',
  '- "work-patterns": when / how they work ("codes late evenings", "solo dev", "async-first")'
].join('\n')

function buildSystemPrompt(): string {
  return (
    'You build a passive, categorized biographical profile of the user from conversation snippets.\n' +
    'Output JSON only, with this exact shape:\n' +
    '  {"updates": [{"category": "projects", "text": "Working on Spiritless, a UE5 indie game"}, ...]}\n\n' +
    'Categories (use these exact strings):\n' +
    CATEGORY_GLOSS +
    '\n\nRules:\n' +
    '- Include only durable observations worth remembering ACROSS future sessions.\n' +
    '- Each `text` is one short declarative third-person statement, under 25 words.\n' +
    '- Skip one-off questions, transient mood, generic chit-chat, anything you already see in the "Already known" list.\n' +
    "- Skip uncertain inferences — if you're not >70% sure, leave it out.\n" +
    '- Return {"updates": []} when nothing new is worth recording. Do NOT pad.\n' +
    'Output JSON only — no prose, no markdown fences.'
  )
}

function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
}

interface RawUpdate {
  category?: unknown
  text?: unknown
}

function coerceCategory(raw: unknown): BiographicalCategory | null {
  if (typeof raw !== 'string') return null
  return KNOWN_CATEGORIES.has(raw as BiographicalCategory) ? (raw as BiographicalCategory) : null
}

const lock = createLock()

/**
 * Run one extraction pass over the tail. Returns the number of updates
 * applied (0 on no-op / failure / disabled). Concurrency-guarded so a
 * burst of streaming completions (e.g. the user spamming Enter) only
 * fires one extraction call.
 */
export async function extractBiographical(messages: ChatMessage[]): Promise<number> {
  if (lock.isLocked) return 0
  const config = useConfigStore.getState().config
  if (!config) return 0
  // Master switch — passive memory ON by default but the user can turn
  // it off in Settings → Memory. The field is optional on the persisted
  // shape (pre-2.0 configs don't have it), so `!== false` treats both
  // `undefined` and `true` as ON. The Settings UI defaults the toggle
  // visual the same way (`?? true`); any other comparison here would
  // make the toggle show "on" while the extractor silently sits idle
  // until the user toggled it.
  if (config.memory.biographical === false) return 0
  // Honour private mode — this thread has explicitly opted OUT of leaving
  // any trace on disk, so the extractor has to stay silent too.
  if (config.chat.private) return 0
  const provider = config.providers.find((p) => p.id === config.activeProvider)
  if (!provider) return 0
  if (provider.needsKey && !provider.hasKey) return 0

  const transcript = buildTranscript(messages)
  if (!transcript) return 0

  // Sentiment-aware skip — mirrors factExtractor's behaviour. Stuck /
  // stressed sessions shouldn't bake frustration into the long-term
  // profile. Honoured ONLY when `sentimentPruning` is also on; the
  // user already opted into that policy for facts and applying it
  // consistently here is what they expect.
  if (config.memory.sentimentPruning && config.memory.emotionalContext) {
    try {
      const snapshot = await vs.memory.emotionalContext()
      const current = snapshot.current
      if (
        current &&
        (current.sentiment === 'stressed' || current.sentiment === 'stuck') &&
        current.intensity >= 3
      ) {
        void vs.logs.write(
          'info',
          'memory',
          `Skipped biographical extraction — session sentiment is "${current.sentiment}" (intensity ${current.intensity}).`
        )
        return 0
      }
    } catch {
      /* IPC hiccup is not a reason to skip — fall through */
    }
  }

  // Hand the model what we already believe so it can avoid re-emitting
  // entries that would just bump confidence on something obvious. The
  // store may have entries below the injection-confidence threshold —
  // we STILL include them in this dedup list so a second observation
  // can promote them via the storage-layer merge, but won't waste
  // tokens re-emitting them as fresh updates.
  const known = useMemoryStore.getState().data?.biographical ?? []
  const knownBlock = known.length
    ? '\n\nAlready known (skip these — do not re-emit them):\n' +
      known.map((e) => `- [${e.category}] ${e.text}`).join('\n')
    : ''

  if (!lock.tryAcquire()) return 0
  try {
    const result = await vs.ai.invoke({
      requestId: uid(),
      provider: provider.id,
      model: provider.model,
      system: buildSystemPrompt() + knownBlock,
      messages: [{ role: 'user', content: transcript }] as ChatTurn[]
    })
    if (result.error || !result.text) return 0
    const match = result.text.match(/\{[\s\S]*\}/)
    if (!match) return 0

    let parsed: { updates?: unknown }
    try {
      parsed = JSON.parse(match[0]) as { updates?: unknown }
    } catch {
      return 0
    }
    if (!Array.isArray(parsed.updates)) return 0

    const updates: { category: BiographicalCategory; text: string }[] = []
    for (const raw of parsed.updates as RawUpdate[]) {
      if (!raw || typeof raw !== 'object') continue
      const category = coerceCategory(raw.category)
      if (!category) continue
      if (typeof raw.text !== 'string') continue
      const text = raw.text.trim()
      if (!text || text.length > 240) continue
      updates.push({ category, text })
      if (updates.length >= RENDERER_BIO_HARD_CAP) break
    }
    if (updates.length === 0) return 0

    const next = await vs.memory.bioMerge(updates)
    // Patch the renderer store so subsequent buildSystemPrompt calls
    // see the fresh entries without a full memory reload.
    //
    // `next` is main's authoritative post-merge view. If the user
    // happened to delete an entry from the Settings panel during the
    // ~LLM call window AND that entry was also re-observed in the
    // current batch, `next` contains the re-merged entry while the
    // delete already landed in the on-disk store. We treat main as
    // the source of truth — the re-observation effectively "won" —
    // so the deleted entry resurfaces here briefly. It will stay
    // gone if the user deletes it again (or if the next extraction
    // pass doesn't re-emit it), and the disk state is consistent.
    // Accepted v1 race; a stricter semantics would need a per-delete
    // tombstone the extractor consults before merging.
    useMemoryStore.setState((s) => (s.data ? { data: { ...s.data, biographical: next } } : s))
    void vs.logs.write(
      'success',
      'memory',
      `Biographical extractor merged ${updates.length} observation${updates.length === 1 ? '' : 's'}`
    )
    return updates.length
  } catch (err) {
    void vs.logs.write(
      'warn',
      'memory',
      'Biographical extraction threw',
      err instanceof Error ? err.message : String(err)
    )
    return 0
  } finally {
    lock.release()
  }
}
