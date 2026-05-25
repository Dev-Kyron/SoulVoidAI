/**
 * Web-search backends for the `web_search` agent tool. Two providers:
 *
 *  · **Tavily** — the user's preferred provider when an API key is configured.
 *    Returns clean ranked results plus an LLM-summarised quick answer.
 *  · **DuckDuckGo HTML** — the keyless fallback. Scrapes the no-JS HTML page,
 *    unwraps the redirect URLs and extracts titles + snippets.
 *
 * Both backends return the same `SearchResults` shape so the caller doesn't
 * care which one ran. The router (`runWebSearch`) picks Tavily if a key is
 * present, else DuckDuckGo — so the tool works out of the box with no setup.
 */

import { ENDPOINTS } from './endpoints'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchResults {
  /** Summarised quick answer — only Tavily provides this; DDG leaves it empty. */
  answer?: string
  results: SearchHit[]
  /** Which backend ran; surfaced in logs so users see why a search was fast/slow. */
  source: 'tavily' | 'duckduckgo'
}

/** Runs a web search via whichever backend is available, Tavily preferred. */
export async function runWebSearch(
  query: string,
  maxResults: number,
  tavilyKey: string | null,
  signal?: AbortSignal
): Promise<SearchResults> {
  if (tavilyKey) {
    try {
      return await tavilySearch(query, maxResults, tavilyKey, signal)
    } catch (err) {
      // If Tavily fails (rate limit, network blip, expired key), don't leave
      // the user stranded — fall back to DDG so the agent can still answer.
      // The error surfaces in the logs panel via the caller. EXCEPT when the
      // user aborted — in that case rethrow so we don't trigger a second
      // network call after Stop was clicked.
      if (signal?.aborted) throw err
      return await duckduckgoSearch(query, maxResults, signal)
    }
  }
  return await duckduckgoSearch(query, maxResults, signal)
}

/** ------------------------------- Tavily --------------------------------- */

async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal?: AbortSignal
): Promise<SearchResults> {
  const res = await fetch(ENDPOINTS.tavilySearch, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.min(maxResults, 10),
      include_answer: true,
      search_depth: 'basic'
    })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    answer?: string
    results?: Array<{ title: string; url: string; content: string }>
  }
  return {
    answer: data.answer,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content
    })),
    source: 'tavily'
  }
}

/** ----------------------------- DuckDuckGo ------------------------------- */

/**
 * DuckDuckGo wraps every result URL in a redirect through their own domain
 * (`//duckduckgo.com/l/?uddg=ENCODED_URL`). This unwraps that so the caller
 * gets the real destination and not a tracking hop.
 *
 * Returns null if the unwrapped target isn't a sane http(s) URL — a poisoned
 * DDG response could try to flow `javascript:`/`data:`/`file://` URLs into
 * the model context, and those would otherwise reach the agent's tool layer.
 */
function unwrapDdgUrl(href: string): string | null {
  try {
    // Absolute or protocol-relative — normalise to a URL we can parse.
    const url = new URL(href, 'https://duckduckgo.com')
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg')
      if (!target) return null
      const decoded = decodeURIComponent(target)
      // Only surface http(s) — the scheme check happens here, before the
      // string flows into the model context.
      try {
        const targetUrl = new URL(decoded)
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return null
        return targetUrl.toString()
      } catch {
        return null
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/** Decodes the small set of HTML entities DDG actually emits in result text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Strips HTML tags from a DDG result fragment, collapsing whitespace. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** v1.12.1 — default fetch budget for the DDG endpoint. The caller's
 *  `signal` (if any) wins on shorter deadlines; this protects against a
 *  hanging response from blocking the agent indefinitely. */
const DDG_TIMEOUT_MS = 15_000

async function duckduckgoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal
): Promise<SearchResults> {
  // The HTML-only endpoint returns server-rendered results with stable class
  // names — much easier to scrape than the JS-driven main page.
  const url = `${ENDPOINTS.duckduckgoHtml}?q=${encodeURIComponent(query)}`
  // v1.12.1 — wrap the caller's signal in a timeout-bounded controller so
  // a hanging DDG response can't block the agent forever. AbortSignal.any
  // (Node 20+) merges multiple signals; aborts on whichever fires first.
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(new Error('DuckDuckGo timed out')), DDG_TIMEOUT_MS)
  const merged: AbortSignal = signal ? AbortSignal.any([signal, timeoutCtl.signal]) : timeoutCtl.signal
  let res: Response
  try {
    res = await fetch(url, {
      signal: merged,
      headers: {
        // DDG returns an empty page to clients without a real UA. A common
        // desktop Firefox UA gets the full HTML reliably.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        Accept: 'text/html'
      }
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`DuckDuckGo ${res.status}`)
  }
  const html = await res.text()

  // v1.12.1 — parse per-result block so title/url/snippet stay paired even
  // when DDG omits the snippet for ads / news cards (the old positional
  // zip would desync in that case). Strategy: split the HTML on each
  // `<div class="result"` opener; each chunk is one result's content.
  // Nesting-depth-agnostic, immune to whatever wrapper tags DDG ships.
  const titleRe = /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  const snippetRe = /<a\s+[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/

  const results: SearchHit[] = []
  // The leading chunk (before the first result div) is header markup —
  // skip it with the [1..] slice. Each remaining chunk holds exactly
  // one result (everything up to the next result-div opener).
  const chunks = html.split(/<div\s+[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1)
  for (const chunk of chunks) {
    if (results.length >= maxResults) break
    const titleMatch = titleRe.exec(chunk)
    if (!titleMatch) continue
    const unwrapped = unwrapDdgUrl(titleMatch[1])
    if (!unwrapped) continue
    const title = stripTags(titleMatch[2])
    if (!title) continue
    const snippetMatch = snippetRe.exec(chunk)
    results.push({
      title,
      url: unwrapped,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : ''
    })
  }

  return { results, source: 'duckduckgo' }
}
