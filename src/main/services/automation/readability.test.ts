import { describe, expect, it } from 'vitest'
import { extractFromHtml } from './readability'

// `extractFromHtml` is the security-adjacent surface that turns arbitrary
// model-driven `web_fetch` responses into text the agent quotes. Locking
// the contract here means a regex regression can't quietly start letting
// <script> blocks through into the chat context.

describe('extractFromHtml', () => {
  it('extracts a plain document title and body', () => {
    const html = `<html><head><title>Hello world</title></head><body><p>This is the body.</p></body></html>`
    const out = extractFromHtml(html, 'https://example.com/x')
    expect(out.title).toBe('Hello world')
    expect(out.text).toContain('This is the body.')
    expect(out.url).toBe('https://example.com/x')
    expect(out.truncated).toBe(false)
  })

  it('falls back to the first <h1> when <title> is missing', () => {
    const html = `<body><h1>Headline</h1><p>body text</p></body>`
    expect(extractFromHtml(html, 'u').title).toBe('Headline')
  })

  it('returns an empty title when neither <title> nor <h1> exist', () => {
    const html = `<body><p>nothing else</p></body>`
    expect(extractFromHtml(html, 'u').title).toBe('')
  })

  it('strips <script>, <style>, <nav>, <header>, <footer>, <aside>, <form>, <svg>, <iframe>', () => {
    const html = `
      <html><head><title>T</title></head><body>
        <nav>NAV CONTENTS</nav>
        <header>HEADER CONTENTS</header>
        <script>alert('xss')</script>
        <style>body { color: red }</style>
        <aside>SIDEBAR</aside>
        <footer>FOOTER</footer>
        <form>FORM</form>
        <svg>SVG</svg>
        <iframe>IFRAME</iframe>
        <p>real content</p>
      </body></html>
    `
    const text = extractFromHtml(html, 'u').text
    for (const noise of [
      'NAV CONTENTS',
      'HEADER CONTENTS',
      'alert',
      'color: red',
      'SIDEBAR',
      'FOOTER',
      'FORM',
      'SVG',
      'IFRAME'
    ]) {
      expect(text).not.toContain(noise)
    }
    expect(text).toContain('real content')
  })

  it('strips HTML comments', () => {
    const html = `<body><p>visible</p><!-- secret comment --></body>`
    expect(extractFromHtml(html, 'u').text).not.toContain('secret comment')
  })

  it('decodes named entities', () => {
    const html = `<body><p>Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#39;single&#39;</p></body>`
    expect(extractFromHtml(html, 'u').text).toBe(`Tom & Jerry <3 "quotes" 'single'`)
  })

  it('decodes numeric and hex character references', () => {
    const html = `<body><p>&#65;&#x42;C</p></body>`
    expect(extractFromHtml(html, 'u').text).toBe('ABC')
  })

  it('preserves paragraph breaks via block-level tag mapping', () => {
    const html = `<body><p>first</p><p>second</p><div>third</div></body>`
    const out = extractFromHtml(html, 'u').text
    // After tag stripping the block closers become newlines so paragraphs
    // remain visually distinct in the agent's transcript.
    expect(out).toMatch(/first\s+second\s+third/)
  })

  it('collapses runs of whitespace and blank lines', () => {
    const html = `<body><p>line1\n\n\n\n\nline2     line3</p></body>`
    const out = extractFromHtml(html, 'u').text
    // Three+ blank lines collapse to a single blank; multiple spaces collapse to one.
    expect(out).not.toMatch(/\n{3,}/)
    expect(out).not.toMatch(/ {2,}/)
  })

  it('marks oversized output as truncated and caps content length', () => {
    const big = 'A'.repeat(33_000)
    const html = `<body><p>${big}</p></body>`
    const out = extractFromHtml(html, 'u')
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith('[…content truncated…]')).toBe(true)
    // Below the cap-plus-suffix length — sanity check on the truncation point.
    expect(out.text.length).toBeLessThan(33_000)
  })

  it('handles self-closing strip targets', () => {
    const html = `<body><iframe src="x"/><p>ok</p></body>`
    const out = extractFromHtml(html, 'u').text
    expect(out).toBe('ok')
  })
})
