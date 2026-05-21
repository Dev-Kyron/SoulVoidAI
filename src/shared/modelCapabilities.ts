/**
 * Per-model capability hints. Used by the provider picker to flag which
 * models can actually accept images, and by the chat composer to warn
 * before sending an image to a text-only model.
 *
 * Pattern-based rather than exhaustive: model names from the same family
 * usually share capabilities (every `gpt-4o-*` is vision-capable), so a
 * regex list catches new variants without manual updates. Conservative —
 * when in doubt, we report `false` so the worst case is a missing
 * indicator, not a silent "image was discarded by the provider".
 */

export interface ModelCapabilities {
  vision: boolean
}

const VISION_PATTERNS: RegExp[] = [
  // OpenAI multimodal family
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-4-vision/,
  /^gpt-4-turbo/,
  /^o1/,
  /^o3/,
  // Anthropic — every Claude 3+ family is vision-capable.
  /^claude-3/,
  /^claude-sonnet/,
  /^claude-opus/,
  /^claude-haiku-4/,
  // Google Gemini
  /^gemini-1\.5/,
  /^gemini-2/,
  /^gemini-exp/,
  // Local Ollama vision models
  /llava/,
  /^bakllava/,
  /^moondream/,
  /llama-?3\.2.*vision/,
  /minicpm-?v/,
  // xAI Grok vision variants
  /grok.*vision/,
  /grok-2/,
  // OpenRouter namespacing — `openai/gpt-4o`, `anthropic/claude-3.5-...`
  /\/gpt-4o/,
  /\/claude-3/,
  /\/gemini/,
  /\/llava/
]

/**
 * Memoize per id — the ModelPickerPill calls this once per row on every
 * popover render, and 25+ regex tests per call adds up fast on a 40-model
 * local list. Keyed on the lowercased id; Map is fine for an unbounded but
 * effectively-small set of seen model names.
 */
const visionCache = new Map<string, boolean>()

export function modelHasVision(modelId: string): boolean {
  if (!modelId) return false
  const lower = modelId.toLowerCase()
  const cached = visionCache.get(lower)
  if (cached !== undefined) return cached
  const result = VISION_PATTERNS.some((rx) => rx.test(lower))
  visionCache.set(lower, result)
  return result
}

export function capabilitiesOf(modelId: string): ModelCapabilities {
  return { vision: modelHasVision(modelId) }
}
