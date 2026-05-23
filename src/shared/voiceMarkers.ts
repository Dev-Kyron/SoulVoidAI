/**
 * Voice marker parser for the v1.3.0 split chat/voice pipeline.
 *
 * The model writes a normal chat reply with spoken segments wrapped in
 * XML-style markers:
 *
 *   Here's the refactored helper:
 *   ```ts
 *   function foo() { ... }
 *   ```
 *   <voice tone="focused">
 *   Pulled the recursion case out — that's where the edge case was hiding.
 *   </voice>
 *
 *   Want me to add a test for the empty-input branch?
 *
 *   <voice tone="casual">
 *   Want me to add a test for that?
 *   </voice>
 *
 * This module extracts:
 *   · `segments` — the voice layer, in document order, each tagged with a
 *     tone preset Piper uses to pick length_scale / noise_scale / noise_w
 *   · `stripped` — the chat layer, identical to the original with just
 *     the `<voice ...>` and `</voice>` tokens removed (content preserved
 *     inline so the chat reading is complete)
 *
 * Voice content appears in BOTH layers — the spoken portions stay visible
 * in chat, just also get spoken aloud with the appropriate tone. Non-voice
 * content is chat-only (silent).
 *
 * Streaming variant (StreamingVoiceExtractor) buffers tokens as the
 * provider streams them and emits complete segments as their closing
 * </voice> arrives — so voice can start playing before the whole reply
 * has landed, matching the current sentence-by-sentence feel but with
 * purpose-written content instead of mechanically chunked chat.
 */

/**
 * Tone presets the model chooses from. Each one maps in the Piper layer
 * to a (length_scale, noise_scale, noise_w) triple. Unknown attribute
 * values normalise to `casual` so a typo never silences voice.
 */
export type ToneTag = 'casual' | 'focused' | 'excited' | 'serious' | 'dry'

export const TONE_TAGS: readonly ToneTag[] = [
  'casual',
  'focused',
  'excited',
  'serious',
  'dry'
] as const

const TONE_SET = new Set<string>(TONE_TAGS)

/**
 * Normalise a raw tone attribute value (from the model's markup) into a
 * known ToneTag. Unknown or missing → `casual`. Case-insensitive because
 * a model writing `Casual` instead of `casual` shouldn't silently lose
 * the tone preset.
 */
export function normalizeTone(raw: string | null | undefined): ToneTag {
  if (!raw) return 'casual'
  const lower = raw.trim().toLowerCase()
  return TONE_SET.has(lower) ? (lower as ToneTag) : 'casual'
}

export interface VoiceSegment {
  tone: ToneTag
  text: string
}

export interface ParseResult {
  segments: VoiceSegment[]
  stripped: string
}

/**
 * Open-tag regex. Matches:
 *   <voice>                    → tone defaults to casual
 *   <voice tone="focused">     → double quotes
 *   <voice tone='dry'>         → single quotes
 *   <voice tone=excited>       → unquoted (some models drop quotes)
 *   <voice  tone = "casual" >  → loose whitespace
 *
 * The negative lookahead `(?![a-z])` after `voice` prevents matching
 * `<voicemail>` or other words that happen to start with `voice`.
 *
 * Tone value capture stops at whitespace, `>`, or matching quote so
 * unquoted attributes don't swallow the closing `>`.
 */
const OPEN_TAG_RE =
  /<voice(?![a-zA-Z])(?:\s+tone\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>'"]+)))?\s*>/i

/**
 * Same shape but global + non-greedy content match for the one-shot parser.
 * `[\s\S]*?` matches across newlines (default `.` doesn't include \n).
 */
const SEGMENT_RE =
  /<voice(?![a-zA-Z])(?:\s+tone\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>'"]+)))?\s*>([\s\S]*?)<\/voice>/gi

/** Strips nested `<voice>` open/close tokens from a segment's text — they
 *  can survive if the model accidentally wrote nested tags (we treat the
 *  outer as the span and lift inner content). */
function stripInnerVoiceMarkup(text: string): string {
  return text.replace(/<\/?voice(?:\s[^>]*)?>/gi, '')
}

/**
 * Single-shot parse. For the streaming case, use StreamingVoiceExtractor
 * instead — calling this on every token would re-scan the whole buffer.
 *
 * Returns segments in document order plus the chat-layer text with the
 * voice tags removed (content inside the tags is kept inline).
 */
export function parseVoiceSegments(text: string): ParseResult {
  const segments: VoiceSegment[] = []
  // Iterate matches via exec so we can read the named capture groups
  // without a callback gymnastic.
  const re = new RegExp(SEGMENT_RE.source, SEGMENT_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const content = stripInnerVoiceMarkup(match[4]).trim()
    if (content.length === 0) continue
    segments.push({ tone: normalizeTone(raw), text: content })
  }
  const stripped = stripVoiceTagsOnly(text)
  return { segments, stripped }
}

/**
 * Removes just the `<voice ...>` and `</voice>` tokens from `text`,
 * leaving the segment content inline. The chat layer is the original
 * reply minus only those markers.
 *
 * Whitespace cleanup: collapse runs of 3+ blank lines (which can appear
 * when a tag sits on its own line) down to 2, so a stripped block
 * doesn't leave a yawning gap.
 */
export function stripVoiceTagsOnly(text: string): string {
  return text
    .replace(/<\/?voice(?:\s[^>]*)?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Heuristic for the no-tags-emitted fallback. Returns the fraction of
 * the reply that's inside fenced code blocks (``` … ```). When the
 * model produces a code-heavy reply without any voice tags, the right
 * behaviour is silent — narrating raw code is worse than saying
 * nothing. Conversational replies without tags fall back to "speak
 * the first paragraph" instead.
 */
export function codeBlockDensity(text: string): number {
  if (text.length === 0) return 0
  let inside = 0
  const re = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    inside += m[0].length
  }
  return inside / text.length
}

/**
 * Soft fallback when a reply finished streaming with zero voice segments.
 * Returns a single casual-tone segment containing the reply's first
 * paragraph — or null when the reply is code-heavy enough that silence
 * is the right choice.
 *
 * The 0.4 density threshold is a starting point; if beta feedback says
 * Soul is silent too often or too rarely, raise/lower it.
 */
export function fallbackSegment(reply: string): VoiceSegment | null {
  if (codeBlockDensity(reply) >= 0.4) return null
  const stripped = stripVoiceTagsOnly(reply).trim()
  if (!stripped) return null
  // First paragraph — split on blank-line, take the first non-empty block,
  // cap at 400 chars so a paragraph-as-essay doesn't tie up the TTS queue.
  const firstPara = stripped.split(/\n\s*\n/).find((p) => p.trim().length > 0)
  if (!firstPara) return null
  const text = firstPara.trim().slice(0, 400)
  return { tone: 'casual', text }
}

/**
 * Incremental voice extractor for the streaming case. Buffer accumulates
 * provider tokens; each .feed() call returns segments whose closing
 * </voice> arrived in that chunk. Open tags without a matching close stay
 * buffered until the close shows up.
 *
 * Why a class and not a closure: tests want to peek at .totalChars for
 * the code-block-density check, and a stateful object is the natural
 * shape for a parser that survives across many small chunks.
 */
export class StreamingVoiceExtractor {
  private buffer = ''
  /** Index in `buffer` past which we've already extracted segments. */
  private consumedUpTo = 0

  /** Total characters fed so far — exposed for fallback heuristics. */
  get totalChars(): number {
    return this.buffer.length
  }

  /**
   * Feed a chunk of streamed text. Returns segments whose closing
   * `</voice>` token completed in this chunk. The same segment is never
   * returned twice.
   */
  feed(chunk: string): VoiceSegment[] {
    this.buffer += chunk
    const out: VoiceSegment[] = []
    while (true) {
      const open = this.findOpenTag(this.consumedUpTo)
      if (!open) break
      // Search for the close tag starting after the open tag ends.
      // indexOf returning -1 means we haven't seen </voice> yet — wait
      // for more chunks rather than emit a partial segment.
      const closeIdx = this.buffer.indexOf('</voice>', open.contentStart)
      if (closeIdx === -1) break
      const rawContent = this.buffer.slice(open.contentStart, closeIdx)
      const cleaned = stripInnerVoiceMarkup(rawContent).trim()
      if (cleaned.length > 0) {
        out.push({ tone: open.tone, text: cleaned })
      }
      this.consumedUpTo = closeIdx + '</voice>'.length
    }
    return out
  }

  /**
   * Final call after the stream ends. Drops any unclosed `<voice>` span
   * (better silent than half a sentence) and applies the no-tags
   * fallback if appropriate.
   *
   * Pass `fallbackOnNoTags: false` to disable the heuristic and accept
   * pure silence on reply with no markers — useful for fully agentic
   * replies that should never produce uncommanded speech.
   */
  flush(opts: { fallbackOnNoTags?: boolean } = {}): VoiceSegment[] {
    const fallback = opts.fallbackOnNoTags ?? true
    // If we never emitted a segment, optionally apply the fallback to
    // the full buffer.
    if (this.consumedUpTo === 0 && fallback) {
      const seg = fallbackSegment(this.buffer)
      if (seg) return [seg]
    }
    return []
  }

  /**
   * Returns the next open-tag occurrence at or after `from`, plus the
   * resolved tone and the index where the tag's content begins. Returns
   * null when no complete open tag is in the buffer yet — handles the
   * "chunk split mid-`<voice tone="`" case by returning null until the
   * closing `>` arrives.
   */
  private findOpenTag(
    from: number
  ): { tone: ToneTag; contentStart: number } | null {
    // Slice to the from-offset so the regex's lastIndex semantics don't
    // bite us. Cheap — the buffer is bounded by the reply size.
    const slice = this.buffer.slice(from)
    const m = OPEN_TAG_RE.exec(slice)
    if (!m) return null
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    const tagStart = from + (m.index ?? 0)
    const contentStart = tagStart + m[0].length
    return { tone: normalizeTone(raw), contentStart }
  }
}
