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

async function duckduckgoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal
): Promise<SearchResults> {
  // The HTML-only endpoint returns server-rendered results with stable class
  // names — much easier to scrape than the JS-driven main page.
  const url = `${ENDPOINTS.duckduckgoHtml}?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    signal,
    headers: {
      // DDG returns an empty page to clients without a real UA. A common
      // desktop Firefox UA gets the full HTML reliably.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      Accept: 'text/html'
    }
  })
  if (!res.ok) {
    throw new Error(`DuckDuckGo ${res.status}`)
  }
  const html = await res.text()

  // Each result block has the shape:
  //   <a class="result__a" href="...">TITLE</a>
  //   ...
  //   <a class="result__snippet" ...>SNIPPET</a>
  // We extract title+url+snippet in one regex pass per pair.
  const titleRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a\s+[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

  const titles: Array<{ url: string; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = titleRe.exec(html))) {
    const unwrapped = unwrapDdgUrl(m[1])
    if (!unwrapped) continue // skip non-http(s) targets entirely
    titles.push({ url: unwrapped, title: stripTags(m[2]) })
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html))) {
    snippets.push(stripTags(m[1]))
  }

  // The two streams are emitted in document order, so zip them positionally —
  // any missing snippet just becomes empty (no fake correlation).
  const results: SearchHit[] = []
  for (let i = 0; i < titles.length && results.length < maxResults; i++) {
    const t = titles[i]
    if (!t.title || !t.url) continue
    results.push({
      title: t.title,
      url: t.url,
      snippet: snippets[i] ?? ''
    })
  }

  return { results, source: 'duckduckgo' }
}
