import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWebSearch } from './search'

// Realistic-shape DuckDuckGo HTML — class names and the `/l/?uddg=` redirect
// pattern are stable, so the parser shouldn't drift even if surrounding markup
// changes. This fixture exercises both: result extraction AND URL unwrapping.
const DDG_FIXTURE = `
<html><body>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; result</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">A snippet with <b>highlight</b> and &quot;quotes&quot;.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Second result</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Another snippet.</a>
</div>
</body></html>
`

describe('runWebSearch', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(DDG_FIXTURE, { status: 200, headers: { 'Content-Type': 'text/html' } })
      )
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = originalFetch
  })

  it('parses DuckDuckGo HTML and unwraps the redirect URLs', async () => {
    const out = await runWebSearch('test query', 5, null)
    expect(out.source).toBe('duckduckgo')
    expect(out.results).toHaveLength(2)
    expect(out.results[0]).toEqual({
      title: 'First & result',
      url: 'https://example.com/one',
      snippet: 'A snippet with highlight and "quotes".'
    })
    expect(out.results[1].url).toBe('https://example.com/two')
  })

  it('caps the result count at the supplied max', async () => {
    const out = await runWebSearch('test query', 1, null)
    expect(out.results).toHaveLength(1)
  })

  it('falls back to DuckDuckGo when Tavily throws', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        callCount++
        if (url.startsWith('https://api.tavily.com')) {
          return new Response('rate limited', { status: 429 })
        }
        return new Response(DDG_FIXTURE, { status: 200 })
      })
    )
    const out = await runWebSearch('test', 5, 'fake-key')
    expect(out.source).toBe('duckduckgo')
    expect(out.results.length).toBeGreaterThan(0)
    // Both Tavily (failed) and DDG (succeeded) should have been called.
    expect(callCount).toBe(2)
  })

  it('uses Tavily when a key is supplied and it succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            answer: 'The quick answer.',
            results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    const out = await runWebSearch('q', 5, 'fake-key')
    expect(out.source).toBe('tavily')
    expect(out.answer).toBe('The quick answer.')
    expect(out.results[0].url).toBe('https://t.example')
  })
})
