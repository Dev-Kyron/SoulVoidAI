/**
 * Anthropic Claude provider (Messages API, streaming).
 */
import { readSSE, httpError, invokeAbortSignal } from './stream'
import { ProviderError } from './types'
import type { AIProvider, CompletionOptions, CompletionResult, InvokeOptions } from './types'
import type { ChatTurn } from '@shared/types'

interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

function imageBlock(dataUrl: string): ImageBlock {
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new ProviderError('Unsupported image attachment format.')
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
}

function content(turn: ChatTurn): unknown {
  if (!turn.images?.length) return turn.content
  return [...turn.images.map(imageBlock), { type: 'text', text: turn.content }]
}

/**
 * Models where Anthropic has deprecated the `temperature` parameter — the
 * API now rejects requests that send it with a 400. Currently the
 * extended-thinking-flavoured Opus models. Keep this list narrow — most
 * models still accept temperature and silently clamp it; we only want to
 * strip it for the ones that actively error.
 */
const TEMPERATURE_DEPRECATED = new Set<string>(['claude-opus-4-7'])

function modelAcceptsTemperature(model: string): boolean {
  if (TEMPERATURE_DEPRECATED.has(model)) return false
  // Substring guard for the "thinking" family — Anthropic's pattern is to
  // disable temperature on extended-thinking models; catching the suffix
  // means we don't have to add every future variant to the set above.
  if (/thinking/i.test(model)) return false
  return true
}

/** Maps the provider-agnostic turn list to Anthropic messages. */
function toMessages(turns: ChatTurn[]): unknown[] {
  const out: unknown[] = []
  for (const turn of turns) {
    if (turn.role === 'tool') {
      out.push({
        role: 'user',
        content: (turn.toolResults ?? []).map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content
        }))
      })
    } else if (turn.role === 'assistant' && turn.toolCalls?.length) {
      const blocks: unknown[] = []
      if (turn.content) blocks.push({ type: 'text', text: turn.content })
      for (const tc of turn.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      }
      out.push({ role: 'assistant', content: blocks })
    } else if (turn.role === 'assistant') {
      out.push({ role: 'assistant', content: turn.content })
    } else {
      out.push({ role: 'user', content: content(turn) })
    }
  }
  return out
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',

  async complete(opts: CompletionOptions): Promise<string> {
    if (!opts.apiKey) throw new ProviderError('Anthropic API key is not set.')

    const messages = opts.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: content(m)
    }))

    const streamBody: Record<string, unknown> = {
      model: opts.model,
      max_tokens: 4096,
      system: opts.system || undefined,
      messages,
      stream: true
    }
    if (modelAcceptsTemperature(opts.model)) {
      streamBody.temperature = opts.temperature ?? 0.7
    }
    const res = await fetch(`${opts.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(streamBody)
    })

    if (!res.ok || !res.body) throw await httpError(res, 'Anthropic')

    let full = ''
    for await (const data of readSSE(res.body)) {
      try {
        const json = JSON.parse(data)
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          full += json.delta.text
          opts.onDelta(json.delta.text)
        } else if (json.type === 'error') {
          throw new ProviderError(json.error?.message ?? 'Anthropic stream error.')
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err
        // Non-text event (ping, message_start, …) — ignore.
      }
    }
    return full
  },

  async invoke(opts: InvokeOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new ProviderError('Anthropic API key is not set.')

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: 4096,
      system: opts.system || undefined,
      messages: toMessages(opts.messages)
    }
    if (modelAcceptsTemperature(opts.model)) {
      body.temperature = opts.temperature ?? 0.7
    }
    if (opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }))
    }

    const res = await fetch(`${opts.baseUrl}/v1/messages`, {
      method: 'POST',
      // Combines the user's Stop signal with a 120s wall-clock cap so a
      // hung provider can't lock up the agent loop. AbortSignal.timeout
      // emits an `AbortError` named TimeoutError if it fires solo.
      signal: invokeAbortSignal(opts.signal),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw await httpError(res, 'Anthropic')

    const json = (await res.json()) as {
      content?: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
      stop_reason?: string
    }
    let text = ''
    const toolCalls = []
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text) {
        text += block.text
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} })
      }
    }
    // Anthropic's stop_reason tells us WHY the assistant stopped. 'end_turn'
    // and 'tool_use' are clean exits; 'max_tokens' means the response was
    // truncated mid-thought (context exhausted or max_tokens hit). Surfacing
    // this prevents the agent loop from treating a truncated response as a
    // final answer and silently exiting with half the work done.
    if (json.stop_reason === 'max_tokens') {
      throw new ProviderError(
        'Anthropic response truncated (stop_reason: max_tokens). The conversation may exceed the model context window — try a shorter prompt or a larger-context model.'
      )
    }
    return { text, toolCalls }
  },

  async listModels(apiKey: string | null, baseUrl: string): Promise<string[]> {
    if (!apiKey) return []
    const res = await fetch(`${baseUrl}/v1/models?limit=100`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data ?? []).map((m) => m.id)
  }
}
