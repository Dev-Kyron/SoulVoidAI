/**
 * Google Gemini provider (Generative Language API, SSE streaming).
 */
import { readSSE, httpError, invokeAbortSignal, rethrowAsTimeout } from './stream'
import { ProviderError } from './types'
import type { AIProvider, CompletionOptions, CompletionResult, InvokeOptions } from './types'
import type { ChatTurn } from '@shared/types'

interface InlineData {
  inline_data: { mime_type: string; data: string }
}

function inlineData(dataUrl: string): InlineData {
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new ProviderError('Unsupported image attachment format.')
  return { inline_data: { mime_type: match[1], data: match[2] } }
}

/**
 * JSON Schema meta-fields that Gemini's OpenAPI-subset tool validator rejects.
 * MCP servers commonly emit these in their `inputSchema` (especially `$schema`
 * at the root and `additionalProperties` in objects). OpenAI and Anthropic
 * silently accept them; only Gemini hard-fails with "Unknown name 'schema'"
 * style 400 errors. Strip recursively before sending.
 *
 * Keep this list conservative — stripping fields Gemini DOES support breaks
 * legitimate schemas. Source: Gemini Function Calling docs, "Supported
 * OpenAPI subset" section.
 */
const GEMINI_DISALLOWED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$comment',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  // Newer JSON Schema draft constructs Gemini doesn't recognise yet.
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas'
])

/**
 * Recursively strip Gemini-unsupported JSON Schema meta-fields from a parameters
 * object. Pure — returns a new object, never mutates the input (the input may
 * be re-used by Anthropic / OpenAI calls in the same request batch).
 */
function cleanGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanGeminiSchema)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (GEMINI_DISALLOWED_KEYS.has(key)) continue
      out[key] = cleanGeminiSchema(val)
    }
    return out
  }
  return value
}

/** Maps the provider-agnostic turn list to Gemini `contents`. */
function toContents(turns: ChatTurn[]): unknown[] {
  const out: unknown[] = []
  for (const turn of turns) {
    if (turn.role === 'tool') {
      out.push({
        role: 'user',
        parts: (turn.toolResults ?? []).map((r) => ({
          functionResponse: { name: r.name, response: { result: r.content } }
        }))
      })
    } else if (turn.role === 'assistant') {
      const parts: unknown[] = []
      if (turn.content) parts.push({ text: turn.content })
      for (const tc of turn.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.args } })
      }
      if (parts.length === 0) parts.push({ text: '' })
      out.push({ role: 'model', parts })
    } else {
      out.push({
        role: 'user',
        parts: [...(turn.images ?? []).map(inlineData), { text: turn.content }]
      })
    }
  }
  return out
}

export const geminiProvider: AIProvider = {
  id: 'gemini',

  async complete(opts: CompletionOptions): Promise<string> {
    if (!opts.apiKey) throw new ProviderError('Gemini API key is not set.')

    const contents = opts.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [...(m.images ?? []).map(inlineData), { text: m.content }]
    }))

    const url = `${opts.baseUrl}/v1beta/models/${opts.model}:streamGenerateContent?alt=sse`
    const res = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': opts.apiKey
      },
      body: JSON.stringify({
        contents,
        systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
        generationConfig: { temperature: opts.temperature ?? 0.7 }
      })
    })

    if (!res.ok || !res.body) throw await httpError(res, 'Gemini')

    let full = ''
    for await (const data of readSSE(res.body)) {
      try {
        const json = JSON.parse(data)
        const parts: Array<{ text?: string }> = json.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) {
            full += part.text
            opts.onDelta(part.text)
          }
        }
      } catch {
        // Partial frame — ignore.
      }
    }
    return full
  },

  async invoke(opts: InvokeOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new ProviderError('Gemini API key is not set.')

    const body: Record<string, unknown> = {
      contents: toContents(opts.messages),
      systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
      generationConfig: { temperature: opts.temperature ?? 0.7 }
    }
    if (opts.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: opts.tools.map((t) => {
            const decl: Record<string, unknown> = { name: t.name, description: t.description }
            const cleaned = cleanGeminiSchema(t.parameters)
            const props = (cleaned as { properties?: Record<string, unknown> }).properties
            if (props && Object.keys(props).length > 0) decl.parameters = cleaned
            return decl
          })
        }
      ]
    }

    const res = await fetch(`${opts.baseUrl}/v1beta/models/${opts.model}:generateContent`, {
      method: 'POST',
      // 120s wall-clock cap combined with the user's Stop signal —
      // matches Anthropic + OpenAI invoke behaviour. rethrowAsTimeout
      // turns the cryptic AbortError into a clear message.
      signal: invokeAbortSignal(opts.signal),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(body)
    }).catch((err) => rethrowAsTimeout(err, 'Gemini'))
    if (!res.ok) throw await httpError(res, 'Gemini')

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string
            functionCall?: { name: string; args?: Record<string, unknown> }
          }>
        }
        finishReason?: string
      }>
    }
    const candidate = json.candidates?.[0]
    // Gemini finishReason — 'STOP' / 'TOOL_USE' (or 'TOOL_CALLS' in
    // some variants) are clean exits. 'MAX_TOKENS' truncated the
    // response; 'SAFETY' / 'RECITATION' blocked it outright. Surface
    // these as ProviderError so the agent loop doesn't treat a
    // half-thought or empty body as a final answer.
    const finish = candidate?.finishReason
    if (finish === 'MAX_TOKENS') {
      throw new ProviderError(
        'Gemini response truncated (finishReason: MAX_TOKENS). The conversation may exceed the model context window — try a shorter prompt or a larger-context model.'
      )
    }
    if (finish === 'SAFETY' || finish === 'RECITATION') {
      throw new ProviderError(
        `Gemini blocked the response (finishReason: ${finish}). Rephrase the request or switch providers.`
      )
    }
    const parts = candidate?.content?.parts ?? []
    let text = ''
    const toolCalls = []
    let index = 0
    for (const part of parts) {
      if (part.text) {
        text += part.text
      } else if (part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name}-${index++}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {}
        })
      }
    }
    return { text, toolCalls }
  },

  async listModels(apiKey: string | null, baseUrl: string): Promise<string[]> {
    if (!apiKey) return []
    const res = await fetch(`${baseUrl}/v1beta/models`, {
      headers: { 'x-goog-api-key': apiKey }
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>
    }
    return (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini'))
  }
}
