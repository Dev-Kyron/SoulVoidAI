/**
 * Ollama provider — local models served by an Ollama daemon. No API key; the
 * stream is newline-delimited JSON rather than SSE.
 */
import { readLines, httpError, parseToolArgs } from './stream'
import { ProviderError } from './types'
import type { AIProvider, CompletionOptions, CompletionResult, InvokeOptions } from './types'
import type { ChatTurn } from '@shared/types'

/** Ollama expects raw base64 image data, without the `data:` URL prefix. */
function rawBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** Maps the provider-agnostic turn list to Ollama chat messages. */
function toMessages(system: string, turns: ChatTurn[]): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const turn of turns) {
    if (turn.role === 'tool') {
      for (const r of turn.toolResults ?? []) {
        out.push({ role: 'tool', content: r.content })
      }
    } else if (turn.role === 'assistant') {
      const message: Record<string, unknown> = { role: 'assistant', content: turn.content }
      if (turn.toolCalls?.length) {
        message.tool_calls = turn.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.args }
        }))
      }
      out.push(message)
    } else {
      const message: Record<string, unknown> = { role: 'user', content: turn.content }
      if (turn.images?.length) message.images = turn.images.map(rawBase64)
      out.push(message)
    }
  }
  return out
}

export const ollamaProvider: AIProvider = {
  id: 'ollama',

  async complete(opts: CompletionOptions): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images.map(rawBase64) } : {})
      }))
    ]

    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: true,
        options: { temperature: opts.temperature ?? 0.7 }
      })
    })

    if (!res.ok || !res.body) throw await httpError(res, 'Ollama')

    let full = ''
    for await (const line of readLines(res.body)) {
      if (!line.trim()) continue
      try {
        const json = JSON.parse(line)
        if (json.error) throw new ProviderError(json.error)
        const delta: string | undefined = json.message?.content
        if (delta) {
          full += delta
          opts.onDelta(delta)
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err
        // Partial line — ignore.
      }
    }
    return full
  },

  async invoke(opts: InvokeOptions): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: toMessages(opts.system, opts.messages),
      stream: false,
      options: { temperature: opts.temperature ?? 0.7 }
    }
    if (opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw await httpError(res, 'Ollama')

    const json = (await res.json()) as {
      message?: {
        content?: string
        tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
      }
    }
    const message = json.message
    return {
      text: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((tc, i) => ({
        id: `call-${i}`,
        name: tc.function.name,
        args: parseToolArgs(tc.function.arguments)
      }))
    }
  },

  async listModels(_apiKey: string | null, baseUrl: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/tags`)
    if (!res.ok) return []
    const json = (await res.json()) as { models?: Array<{ name: string }> }
    return (json.models ?? []).map((m) => m.name)
  }
}
