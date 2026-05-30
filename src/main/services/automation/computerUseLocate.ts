/**
 * Anthropic Sonnet computer-use locate.
 *
 * Single source of truth for the API call shape — both the production
 * click pipeline (`performVisualClick`) and the bench strategy
 * (`sonnetComputerUseStrategy`) route through this so the numbers in
 * the report match the numbers the user actually experiences when
 * they click in chat.
 *
 * Returns LOGICAL display pixels (window origin already added back in
 * for windowed shots) or null when the model didn't emit a click.
 *
 * Failure modes return null + a trail string instead of throwing.
 * Hard errors (no key, HTTP 5xx) come back as `{ predicted: null,
 * trail: 'reason' }` — same contract as `locateVisionRefined`.
 */
import { getApiKey } from '../storage/keys'
import { resolveBaseUrl } from '../storage/config'
import type { CapturedScreen } from './screenCapture'

/**
 * Model ids that ship with native computer-use. List kept narrow on
 * purpose — we'd rather refuse a borderline model than route one that
 * ignores the tool and emits a text-only refusal. Prefix match because
 * the dated suffix (`-20250929` etc) changes every few months without
 * breaking compatibility.
 */
const COMPUTER_USE_MODEL_PREFIXES = [
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet'
]

/** True iff the given Anthropic model id supports the computer-use tool. */
export function modelSupportsComputerUse(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return COMPUTER_USE_MODEL_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * Provider + model capability gate. Exported so the production pipeline
 * and the Settings UI can both check before showing a "force Sonnet"
 * option.
 */
export function isSonnetComputerUseCapable(providerId: string, modelId: string): boolean {
  if (providerId !== 'anthropic') return false
  return modelSupportsComputerUse(modelId)
}

interface ComputerUseToolUse {
  type: 'tool_use'
  name: string
  input: {
    action?: string
    coordinate?: [number, number]
  }
}

interface AnthropicMessageResponse {
  content?: Array<ComputerUseToolUse | { type: string; text?: string }>
  stop_reason?: string
  error?: { message?: string }
}

export interface ComputerUseLocateResult {
  /** Predicted click point in LOGICAL display pixels (with window origin
   *  already added back), or null when the model didn't commit. */
  predicted: { x: number; y: number } | null
  /** One-line diagnostic for the trail. */
  trail: string
  /** Latency of the underlying fetch call. */
  msElapsed: number
}

/**
 * Issue one computer-use call to Anthropic and project the resulting
 * click coordinate back to logical display space.
 *
 * `modelId` is supplied by the caller so the production pipeline can
 * honour the user's pinned model, while the bench harness can hardcode
 * the latest Sonnet to avoid measuring an unfair comparison when the
 * user happens to be on a smaller model.
 */
export async function locateViaComputerUse(args: {
  shot: CapturedScreen
  description: string
  modelId: string
  /** Abort signal from the agent's request — undefined when the call
   *  isn't tied to a per-request abort (e.g. the bench harness uses its
   *  own dedicated signal, but the production visualClick path passes
   *  through whatever the agent registered, which can be undefined for
   *  proactive turns). */
  signal?: AbortSignal
}): Promise<ComputerUseLocateResult> {
  const start = Date.now()
  const apiKey = getApiKey('anthropic')
  if (!apiKey) {
    return {
      predicted: null,
      trail: 'no anthropic key',
      msElapsed: Date.now() - start
    }
  }
  const baseUrl = resolveBaseUrl('anthropic') || 'https://api.anthropic.com'
  const base64Match = /^data:(.+?);base64,(.*)$/s.exec(args.shot.dataUrl)
  if (!base64Match) {
    return {
      predicted: null,
      trail: 'bad screenshot encoding',
      msElapsed: Date.now() - start
    }
  }
  const mediaType = base64Match[1]
  const imageData = base64Match[2]

  // Computer-use tool spec for Sonnet 3.7 / 4 / 4.5. display_width_px and
  // display_height_px declare the coordinate space the model emits clicks
  // in — we set them to the screenshot pixel dimensions so the returned
  // coords are directly indexable into the captured PNG, then project to
  // logical display space.
  const body = {
    model: args.modelId,
    max_tokens: 1024,
    tools: [
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: args.shot.width,
        display_height_px: args.shot.height,
        display_number: 1
      }
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageData }
          },
          {
            type: 'text',
            text: `Use the computer tool's left_click action to click: ${args.description}. Return only the tool call, no commentary.`
          }
        ]
      }
    ]
  }

  const fetchStart = Date.now()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: args.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2025-01-24'
      },
      body: JSON.stringify(body)
    })
  } catch (err) {
    return {
      predicted: null,
      trail: `anthropic fetch threw: ${err instanceof Error ? err.message : String(err)}`,
      msElapsed: Date.now() - start
    }
  }
  const fetchMs = Date.now() - fetchStart

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      predicted: null,
      trail: `anthropic ${res.status} in ${fetchMs}ms: ${text.slice(0, 200)}`,
      msElapsed: Date.now() - start
    }
  }
  const payload = (await res.json().catch(() => null)) as AnthropicMessageResponse | null
  if (!payload) {
    return {
      predicted: null,
      trail: `anthropic returned non-JSON in ${fetchMs}ms`,
      msElapsed: Date.now() - start
    }
  }
  if (payload.error?.message) {
    return {
      predicted: null,
      trail: `anthropic error: ${payload.error.message}`,
      msElapsed: Date.now() - start
    }
  }

  // v2.0 polish — only accept an actual left_click action. Sonnet
  // also emits mouse_move, left_click_drag, right_click etc. with a
  // `coordinate` set — those are NOT clicks, and treating them as
  // such silently fires the wrong action (a drag intent collapses
  // to a click at the drag start; a right-click intent becomes a
  // left-click). The click_on_screen tool's contract is a left
  // click at a point; refuse anything else and let the baseline
  // pipeline handle the case.
  const click = (payload.content ?? []).find(
    (b): b is ComputerUseToolUse =>
      b.type === 'tool_use' &&
      'name' in b &&
      b.name === 'computer' &&
      (b as ComputerUseToolUse).input?.action === 'left_click' &&
      !!(b as ComputerUseToolUse).input?.coordinate
  )
  if (!click?.input?.coordinate) {
    // The model sometimes emits a screenshot action first instead of
    // clicking — counts as a "won't commit" for our purposes (we
    // already gave it the screenshot, after all).
    return {
      predicted: null,
      trail: `model returned ${payload.content?.length ?? 0} blocks, no click (stop_reason: ${payload.stop_reason ?? 'unknown'}) in ${fetchMs}ms`,
      msElapsed: Date.now() - start
    }
  }
  const [scrX, scrY] = click.input.coordinate
  // v2.0 polish — reject hallucinated coordinates BEFORE projection.
  // Sonnet occasionally emits negative or far-out-of-bounds points
  // after a complex prompt; without this guard they pass through
  // moveMouse, the OS clips them silently, and the click lands at a
  // wrong-but-plausible position (the screen edge). Refusing here
  // surfaces the issue clearly and lets the baseline pipeline try.
  if (
    !Number.isFinite(scrX) ||
    !Number.isFinite(scrY) ||
    scrX < 0 ||
    scrY < 0 ||
    scrX >= args.shot.width ||
    scrY >= args.shot.height
  ) {
    return {
      predicted: null,
      trail: `sonnet computer-use returned out-of-bounds coord (${scrX}, ${scrY}) on ${args.shot.width}×${args.shot.height} screenshot in ${fetchMs}ms`,
      msElapsed: Date.now() - start
    }
  }
  // v2.0 polish — project each axis with ITS OWN ratio. The previous
  // single-ratio code assumed uniform scaling between screenshot and
  // logical window, but a clamped windowed capture (window extending
  // past the screen edge) can have width/displayWidth ≠ height/displayHeight
  // — applying the X ratio to Y left the Y coordinate skewed proportionally
  // to the axis-aspect mismatch. With the screenCapture fix above this
  // usually evens out, but keeping per-axis projection is defence in
  // depth against any future capture path with non-uniform scaling.
  const ratioX = args.shot.width / Math.max(1, args.shot.displayWidth)
  const ratioY = args.shot.height / Math.max(1, args.shot.displayHeight)
  const displayX = Math.round(scrX / ratioX) + args.shot.windowOriginX
  const displayY = Math.round(scrY / ratioY) + args.shot.windowOriginY

  return {
    predicted: { x: displayX, y: displayY },
    trail: `sonnet computer-use clicked (${scrX}, ${scrY}) → display (${displayX}, ${displayY}) in ${fetchMs}ms`,
    msElapsed: Date.now() - start
  }
}
