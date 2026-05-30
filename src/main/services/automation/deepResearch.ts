/**
 * v2.0 — Deep Research mode.
 *
 * One-shot multi-step research orchestrator the agent invokes as a
 * single tool call. Internally runs:
 *
 *   1. PLAN — break the topic into N sub-queries via a small LLM call.
 *   2. SEARCH — fire each query through the existing web-search action
 *      (Tavily preferred, DDG fallback) in parallel.
 *   3. FETCH — pick the top results per query (deduped by URL) and
 *      pull their readable text via the existing web-fetch action.
 *   4. SYNTHESISE — feed the fetched content + the original topic into
 *      a larger LLM call with instructions to emit markdown with
 *      `[^N]` footnote citations + a numbered Sources list.
 *
 * Returns one ActionResult whose `output` is the synthesised markdown
 * answer. From the agent's perspective this is a single tool call;
 * the internal search + fetch steps don't surface as separate
 * toolInvocations on the assistant bubble (they ARE logged in the
 * structured log store for debugging).
 *
 * Scope notes:
 *   - No live progress events (v2.1 UI work). The tool blocks until
 *     synthesis completes, which is acceptable because the existing
 *     "pendingTool" indicator in chat says "Deep research…" the whole
 *     time.
 *   - Sub-LLM calls go to the user's currently-active provider/model
 *     (no separate research-model config). v2.1 could add a pin.
 *   - Citations are extracted from the synthesis output via the `[^N]`
 *     marker the model is asked to emit. We don't validate that every
 *     marker has a matching source — the model occasionally invents
 *     `[^7]` when only 6 sources exist. The Sources list still shows
 *     the 6 we actually fed it.
 */
import { log } from '../logger'
import { getConfig } from '../storage/config'
import { invokeCompletion } from '../ai'
import { runWebSearch } from './search'
import { extractFromHtml } from './readability'
import { checkUrlSafe } from './urlSafety'
import { getSecret } from '../storage/keys'
// v2.0 round 10 — promoted to src/shared so the renderer's bio + fact
// extractors can share the balanced-brace scanner. They were using a
// greedy /\{[\s\S]*\}/ regex that silently failed on chatty providers.
import { extractFirstBalancedJsonObject } from '@shared/jsonExtract'
import type { ActionResult, ChatTurn, ProviderId } from '@shared/types'

/** Returns the active provider id + model, or null when no model is
 *  configured. The keyed-vs-local check is performed by the caller of
 *  invokeCompletion (which surfaces the missing-key error to the user
 *  via the deep-research output). Reads main's `providers` map keyed
 *  by ProviderId, not the renderer's array-shaped ProviderRuntime[]. */
function activeProvider(): { id: ProviderId; model: string } | null {
  const config = getConfig()
  const settings = config.providers[config.activeProvider]
  if (!settings || !settings.model) return null
  return { id: config.activeProvider, model: settings.model }
}

/** Per-depth tuning. `quick` is fast (sub-30s), `standard` is the
 *  default Cursor-feeling result, `deep` is for "really go look this
 *  up" research where the user is OK waiting a minute. */
const DEPTH: Record<'quick' | 'standard' | 'deep', { queries: number; perQuery: number }> = {
  quick: { queries: 2, perQuery: 1 },
  standard: { queries: 3, perQuery: 2 },
  deep: { queries: 5, perQuery: 2 }
}

/** Hard cap on per-fetch content so a single page can't blow out the
 *  synthesis prompt window. 8000 chars ≈ 2k tokens — comfortably fits
 *  10 sources alongside the user's question in any provider's context. */
const PER_FETCH_CHAR_CAP = 8_000

/** Cumulative budget across all fetched content. Even with the per-
 *  fetch cap, 10 deep-research fetches × 8000 = 80k chars which is
 *  cramped for smaller models. This trims the LATER fetches when the
 *  budget is near exhausted so the synthesis prompt stays sane. */
const TOTAL_CONTENT_CAP = 48_000

interface FetchedSource {
  /** Sequential 1-based index used as the `[^N]` marker. */
  index: number
  url: string
  title: string
  /** Snippet from the search hit — used in the Sources list under
   *  each numbered entry as a one-line description. */
  snippet: string
  /** Readable body text extracted from the page (capped). Empty
   *  string when fetch failed; the synthesis still gets the search
   *  snippet so the citation has SOMETHING to ground on. */
  text: string
  /** Set when fetch threw or returned non-ok; surfaced in the
   *  research summary so the user knows which sources are weaker. */
  fetchError?: string
}

/**
 * Public entry point — wired into the dispatcher in actions.ts under
 * the `deep-research` case. Signal threads through every sub-step so
 * the user's Stop button kills the whole pipeline, not just one call.
 */
export async function runDeepResearch(args: {
  topic: string
  depth?: 'quick' | 'standard' | 'deep'
  signal?: AbortSignal
}): Promise<ActionResult> {
  const topic = args.topic.trim()
  if (!topic) {
    return { ok: false, type: 'deep-research', error: 'No research topic supplied.' }
  }
  const depth = args.depth && DEPTH[args.depth] ? args.depth : 'standard'
  const tuning = DEPTH[depth]
  const provider = activeProvider()
  if (!provider) {
    return {
      ok: false,
      type: 'deep-research',
      error: 'No active AI provider configured — deep research needs an LLM.'
    }
  }
  log('info', 'system', `deep_research: starting "${topic}" (depth=${depth})`)

  // ---- PHASE 1: PLAN -----------------------------------------------------
  const queries = await planQueries(topic, tuning.queries, provider, args.signal)
  if (queries.length === 0) {
    return {
      ok: false,
      type: 'deep-research',
      error:
        'Could not generate sub-queries for this topic — the active model returned no usable plan.'
    }
  }
  log('info', 'system', `deep_research: planned ${queries.length} queries`)

  // ---- PHASE 2: SEARCH --------------------------------------------------
  // All queries fire in parallel; one failure doesn't sink the whole
  // run because Promise.allSettled lets the survivors through.
  const tavilyKey = getSecret('tavily')
  const searchResults = await Promise.allSettled(
    queries.map((q) => runWebSearch(q, tuning.perQuery + 1, tavilyKey, args.signal))
  )

  // ---- PHASE 3: PICK + FETCH --------------------------------------------
  // Flatten hits, dedupe by URL, cap to total budget, then fetch each
  // in parallel. URL safety check happens here AND inside web-fetch
  // (defence in depth — the deep-research path should never even
  // attempt an SSRF target).
  const picked: Array<{ url: string; title: string; snippet: string }> = []
  const seen = new Set<string>()
  for (let i = 0; i < searchResults.length; i++) {
    const result = searchResults[i]
    if (result.status !== 'fulfilled') {
      log(
        'warn',
        'system',
        `deep_research: query "${queries[i]}" failed`,
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      )
      continue
    }
    const hits = result.value.results.slice(0, tuning.perQuery)
    for (const hit of hits) {
      if (seen.has(hit.url)) continue
      if (!checkUrlSafe(hit.url).ok) continue
      seen.add(hit.url)
      picked.push({ url: hit.url, title: hit.title, snippet: hit.snippet })
    }
  }

  if (picked.length === 0) {
    return {
      ok: false,
      type: 'deep-research',
      error: 'Search returned no usable sources for this topic.'
    }
  }

  const fetched = await Promise.all(picked.map(async (p, i) => fetchSource(i + 1, p, args.signal)))

  // Apply the cumulative content cap from oldest-fetched onwards
  // (oldest = first in the picked array = most relevant per search
  // ranking). Sources past the cap keep their snippet but their
  // body is zeroed out — citation still works, the text just doesn't
  // pad the synthesis prompt.
  let runningSize = 0
  for (const src of fetched) {
    if (runningSize >= TOTAL_CONTENT_CAP) {
      src.text = ''
      continue
    }
    const remaining = TOTAL_CONTENT_CAP - runningSize
    if (src.text.length > remaining) src.text = src.text.slice(0, remaining)
    runningSize += src.text.length
  }
  log(
    'info',
    'system',
    `deep_research: fetched ${fetched.length} source${fetched.length === 1 ? '' : 's'} (${runningSize.toLocaleString()} chars)`
  )

  // ---- PHASE 4: SYNTHESISE ----------------------------------------------
  const synthesis = await synthesiseAnswer(topic, fetched, provider, args.signal)
  const sourceList = renderSourceList(fetched)
  const output = `${synthesis}\n\n---\n\n**Sources**\n${sourceList}`

  return {
    ok: true,
    type: 'deep-research',
    output,
    data: {
      topic,
      depth,
      queriesUsed: queries,
      sourceCount: fetched.length,
      sources: fetched.map((s) => ({ index: s.index, url: s.url, title: s.title }))
    }
  }
}

/* -------------------------- internal helpers -------------------------- */

async function planQueries(
  topic: string,
  count: number,
  provider: { id: ProviderId; model: string },
  signal: AbortSignal | undefined
): Promise<string[]> {
  const system =
    'You are a research planner. Given a topic, output exactly the requested ' +
    'number of distinct web search queries that together cover the topic well. ' +
    'Return JSON only: {"queries": ["query 1", "query 2", ...]}. ' +
    'Each query: 3-10 words, specific, search-engine friendly, no quote marks.'
  const user =
    `Topic: ${topic}\n\nProduce exactly ${count} sub-queries. Cover different angles ` +
    `(definitional, current/news, comparative, technical). Return JSON only.`
  const turns: ChatTurn[] = [{ role: 'user', content: user }]
  const effectiveSignal = signal ?? new AbortController().signal
  const result = await invokeCompletion(
    {
      requestId: `deep-research-plan-${Date.now()}`,
      provider: provider.id,
      model: provider.model,
      system,
      messages: turns
    },
    effectiveSignal
  )
  if (result.error || !result.text) return []
  // v2.0 polish — extractFirstBalancedObject instead of greedy regex.
  // The previous /\{[\s\S]*\}/ would swallow EVERYTHING between the
  // first '{' and the last '}', so a perfectly valid response like
  //   "Sure — I'll plan {\"queries\":[\"x\"]}. Note: braces {} elsewhere."
  // joined into one un-parseable blob and planner silently failed.
  const block = extractFirstBalancedJsonObject(result.text)
  if (!block) return []
  try {
    const parsed = JSON.parse(block) as { queries?: unknown }
    if (!Array.isArray(parsed.queries)) return []
    return parsed.queries
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, count)
  } catch {
    return []
  }
}

async function fetchSource(
  index: number,
  hit: { url: string; title: string; snippet: string },
  signal: AbortSignal | undefined
): Promise<FetchedSource> {
  const base: FetchedSource = {
    index,
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
    text: ''
  }
  try {
    // Mini-timeout per fetch so one slow page doesn't stall the
    // whole research run. The caller's request-wide signal also
    // wins if Stop is pressed.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort)
    // v2.0 polish — addEventListener doesn't synchronously fire for an
    // ALREADY-aborted signal. If the user hit Stop just before the
    // fetch phase, the per-fetch wouldn't bail until the 12s internal
    // timeout — wasting bandwidth × N picked sources. Explicit re-
    // check ensures a pre-aborted upstream signal aborts immediately.
    if (signal?.aborted) controller.abort()
    const response = await fetch(hit.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Mirror what web-fetch sends so the same UAs are happy here.
        'user-agent': 'Mozilla/5.0 (compatible; VoidSoulResearch/2.0; +https://voidsoulstudio.com)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }).finally(() => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    })
    if (!response.ok) {
      base.fetchError = `HTTP ${response.status}`
      return base
    }
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (!contentType.includes('html')) {
      base.text = text.slice(0, PER_FETCH_CHAR_CAP)
      return base
    }
    const extracted = extractFromHtml(text, hit.url)
    base.title = extracted.title || base.title
    base.text = extracted.text.slice(0, PER_FETCH_CHAR_CAP)
    return base
  } catch (err) {
    base.fetchError = err instanceof Error ? err.message : String(err)
    return base
  }
}

async function synthesiseAnswer(
  topic: string,
  sources: FetchedSource[],
  provider: { id: ProviderId; model: string },
  signal: AbortSignal | undefined
): Promise<string> {
  const usable = sources.filter((s) => s.text.length > 0 || s.snippet.length > 0)
  if (usable.length === 0) {
    return '_Could not retrieve any source content for this topic._'
  }
  const sourcesBlock = usable
    .map(
      (s) =>
        `[^${s.index}] ${s.title} — ${s.url}\n${s.text || `(only snippet available: ${s.snippet})`}`
    )
    .join('\n\n---\n\n')

  const system =
    'You write thorough, source-grounded research answers in markdown. ' +
    'Use `[^N]` footnote markers inline to cite the numbered sources provided. ' +
    'Every non-trivial factual claim should carry a citation. ' +
    "If a source doesn't actually support a claim, do not cite it for that claim. " +
    'Open with a 1-2 sentence overview, then organise by sub-topic with ## headings. ' +
    "End with a one-paragraph synthesis. Do NOT include a 'Sources' section yourself — " +
    'the caller appends one.'

  const user =
    `Research question: ${topic}\n\n` +
    `You have ${usable.length} source${usable.length === 1 ? '' : 's'} below. ` +
    `Write the answer using markdown with [^N] citations.\n\n` +
    `=== SOURCES ===\n${sourcesBlock}`

  const turns: ChatTurn[] = [{ role: 'user', content: user }]
  const result = await invokeCompletion(
    {
      requestId: `deep-research-synth-${Date.now()}`,
      provider: provider.id,
      model: provider.model,
      system,
      messages: turns
    },
    signal ?? new AbortController().signal
  )
  if (result.error) {
    return `_Synthesis failed: ${result.error}_`
  }
  return result.text.trim() || '_The model returned an empty synthesis._'
}

function renderSourceList(sources: FetchedSource[]): string {
  return sources
    .map((s) => {
      const status = s.fetchError ? ` _(fetch error: ${s.fetchError})_` : ''
      const desc = s.snippet ? `\n   ${s.snippet}` : ''
      return `${s.index}. [${s.title || s.url}](${s.url})${status}${desc}`
    })
    .join('\n')
}
