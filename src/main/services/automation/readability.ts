/**
 * Minimal HTML → readable-text extractor for the `web_fetch` agent tool.
 * Inspired by Mozilla Readability but tiny enough to avoid a dependency:
 *  - strips <script>, <style>, <nav>, <header>, <footer>, <aside>, <form>
 *  - decodes the most common HTML entities
 *  - collapses whitespace and trims aggressively
 *  - returns a title + body, capped at MAX_CHARS so the model isn't drowned
 *
 * Not bulletproof — for sites that ship JS-rendered content there's nothing
 * to extract — but for static pages, docs, blog posts and READMEs it's
 * enough to let the agent quote and summarise without a Headless browser.
 */
const MAX_CHARS = 32_000

const REMOVE_TAGS = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'iframe']

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) return decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ')
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1Match) return decodeEntities(h1Match[1].replace(/<[^>]+>/g, '')).trim()
  return ''
}

function stripChrome(html: string): string {
  let out = html
  for (const tag of REMOVE_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
    out = out.replace(re, ' ')
    // Self-closing variants.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  }
  // HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  return out
}

function preserveBlocks(html: string): string {
  // Convert common block-level closing tags into newlines so paragraphs and
  // list items don't get glued together when the angle brackets disappear.
  return html
    .replace(/<\/(p|div|li|h[1-6]|tr|br|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
}

function htmlToText(html: string): string {
  const stripped = stripChrome(html)
  const blocked = preserveBlocks(stripped)
  const noTags = blocked.replace(/<[^>]+>/g, '')
  const decoded = decodeEntities(noTags)
  return decoded
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ExtractedPage {
  url: string
  title: string
  text: string
  truncated: boolean
}

/** Extracts a readable representation of an HTML document. */
export function extractFromHtml(html: string, url: string): ExtractedPage {
  const title = extractTitle(html)
  const fullText = htmlToText(html)
  const truncated = fullText.length > MAX_CHARS
  const text = truncated ? `${fullText.slice(0, MAX_CHARS)}\n\n[…content truncated…]` : fullText
  return { url, title, text, truncated }
}
