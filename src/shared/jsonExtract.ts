/**
 * Shared utilities for pulling JSON out of LLM responses that mix prose
 * and structured payloads. Lifted from the deep-research module in v2.0
 * round 10 — the original site was the only consumer, but the passive
 * biographical extractor and the manual fact extractor were both using
 * a greedy `/\{[\s\S]*\}/` regex that spans the FIRST `{` to the LAST
 * `}` in the reply. Any chatty provider (Ollama, Gemini Flash, sometimes
 * gpt-4o-mini) wraps the JSON in prose ("Sure, here is the JSON: {…}.
 * Note: …") or fences it in ```json …```; the greedy regex grabs all of
 * it, JSON.parse throws, and the extractor silently records zero
 * entries. The user sees passive memory simply never accruing.
 *
 * `extractFirstBalancedJsonObject` scans for balanced braces with
 * string-aware skipping (a `}` inside `"…"` doesn't close the object),
 * returning the first complete object including its outer braces.
 *
 * Lives in src/shared/ so both main-process (deepResearch.ts) and
 * renderer (biographicalExtractor.ts, factExtractor.ts) can import it
 * without duplicating the implementation.
 */

/**
 * Find the first top-level `{ ... }` object in a string by scanning
 * for balanced braces. Returns the matched substring (including the
 * outer braces) or null. Respects double-quoted strings so a `}`
 * inside `"key": "value with }"` doesn't close the object early.
 *
 * @example
 *   extractFirstBalancedJsonObject('here is your JSON: {"a": 1}. cheers!')
 *     === '{"a": 1}'
 *   extractFirstBalancedJsonObject('```json\n{"updates": []}\n```')
 *     === '{"updates": []}'
 *   extractFirstBalancedJsonObject('no braces here')
 *     === null
 */
export function extractFirstBalancedJsonObject(text: string): string | null {
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}
