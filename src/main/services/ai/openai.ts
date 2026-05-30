/**
 * OpenAI Chat Completions provider (also compatible with OpenAI-style
 * endpoints via a custom base URL).
 */
import {
  readSSE,
  httpError,
  parseToolArgs,
  readJsonOrError,
  invokeAbortSignal,
  rethrowAsTimeout
} from './stream'
import { ProviderError } from './types'
import type { AIProvider, CompletionOptions, CompletionResult, InvokeOptions } from './types'
import type { ChatTurn } from '@shared/types'

/**
 * The OpenAI Chat Completions implementation. It is also the shared engine for
 * every OpenAI-compatible provider (Groq, xAI, OpenRouter, DeepSeek, Mistral,
 * custom endpoints) — only the base URL and key differ.
 */

/** Builds request headers, attaching auth only when a key is present. */
function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function content(turn: ChatTurn): unknown {
  if (!turn.images?.length) return turn.content
  return [
    { type: 'text', text: turn.content },
    ...turn.images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ]
}

/** Maps the provider-agnostic turn list to OpenAI chat messages. */
function toMessages(system: string, turns: ChatTurn[]): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const turn of turns) {
    if (turn.role === 'tool') {
      for (const result of turn.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: result.id, content: result.content })
      }
    } else if (turn.role === 'assistant') {
      const message: Record<string, unknown> = {
        role: 'assistant',
        content: turn.content || null
      }
      if (turn.toolCalls?.length) {
        message.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        }))
      }
      out.push(message)
    } else {
      out.push({ role: 'user', content: content(turn) })
    }
  }
  return out
}

export const openaiProvider: AIProvider = {
  id: 'openai',

  async complete(opts: CompletionOptions): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...opts.messages.map((m) => ({ role: m.role, content: content(m) }))
    ]

    const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: opts.signal,
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify({ model: opts.model, messages, stream: true })
    })

    if (!res.ok || !res.body) throw await httpError(res, 'OpenAI')

    let full = ''
    for await (const data of readSSE(res.body)) {
      if (data === '[DONE]') break
      try {
        const json = JSON.parse(data)
        const delta: string | undefined = json.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          opts.onDelta(delta)
        }
      } catch {
        // Keep-alive comment or partial frame — ignore.
      }
    }
    return full
  },

  async invoke(opts: InvokeOptions): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: toMessages(opts.system, opts.messages)
    }
    if (opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      // 120s cap combined with the user's Stop signal — prevents a hung
      // provider from blocking the agent loop indefinitely. rethrowAsTimeout
      // turns the cryptic AbortError into a clear user-facing message.
      signal: invokeAbortSignal(opts.signal),
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify(body)
    }).catch((err) => rethrowAsTimeout(err, 'OpenAI'))
    if (!res.ok) throw await httpError(res, 'OpenAI')

    const json = await readJsonOrError<{
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
        }
        finish_reason?: string
      }>
    }>(res, 'OpenAI')
    const choice = json.choices?.[0]
    // OpenAI's finish_reason: 'stop' / 'tool_calls' are clean exits.
    // 'length' means the response was truncated — context window full
    // or max_tokens hit. Surface as a real error so the agent loop
    // doesn't silently treat a half-thought as a final answer.
    if (choice?.finish_reason === 'length') {
      throw new ProviderError(
        'OpenAI response truncated (finish_reason: length). The conversation may exceed the model context window — try a shorter prompt or a larger-context model.'
      )
    }
    const message = choice?.message
    return {
      text: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseToolArgs(tc.function.arguments)
      }))
    }
  },

  async listModels(apiKey: string | null, baseUrl: string): Promise<string[]> {
    if (!baseUrl) return []
    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders(apiKey) })
    } catch {
      return []
    }
    if (!res.ok) return []
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id) => !/embed|whisper|tts|dall-e|moderation|rerank|audio|image/i.test(id))
      .sort()
  }
}
