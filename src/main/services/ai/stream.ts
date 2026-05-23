/**
 * Streaming primitives shared by the AI providers: a line reader over a fetch
 * response body, an SSE `data:` extractor, and a helper to turn a failed HTTP
 * response into a readable error message.
 */
import { ProviderError } from './types'

/**
 * Default upper bound on a single non-streaming provider invoke. Local
 * Ollama on a slow CPU can take ~30-60s on a 14B-class model; reasoning
 * models (o1, extended-thinking) can take longer. 120s covers the
 * realistic worst case without leaving a truly hung provider blocking
 * the agent loop forever.
 */
export const INVOKE_TIMEOUT_MS = 120_000

/**
 * Combines an optional caller-supplied abort signal with a wall-clock
 * timeout. Returned signal aborts when EITHER source fires — the user
 * clicking Stop OR the timer expiring. Used by every invoke() in the
 * provider implementations so a hung HTTP call can't block the agent
 * loop indefinitely.
 *
 * Node 18.17+ / Electron 28+ ship AbortSignal.any + AbortSignal.timeout
 * natively; we're on Node 22 in CI and Electron 33 at runtime.
 */
export function invokeAbortSignal(userSignal: AbortSignal | undefined, ms = INVOKE_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return userSignal ? AbortSignal.any([userSignal, timeout]) : timeout
}

/**
 * Re-throws a friendlier message if the fetch error was caused by
 * `AbortSignal.timeout` rather than the user's Stop button. The native
 * error reads "signal is aborted without reason" which means nothing
 * to a user staring at a stuck agent run; this gives them an actionable
 * line. Pass-through for any other error.
 */
export function rethrowAsTimeout(err: unknown, providerLabel: string, ms = INVOKE_TIMEOUT_MS): never {
  // DOMException with name='TimeoutError' is the standard signal from
  // AbortSignal.timeout. A user-driven Stop produces name='AbortError'
  // instead, which we let bubble up unchanged.
  if (err instanceof Error && err.name === 'TimeoutError') {
    throw new Error(
      `${providerLabel} request timed out after ${Math.round(ms / 1000)}s — the provider may be overloaded or the model is too slow. Try a faster model or check the provider status.`
    )
  }
  throw err
}

/** Yields the response body one text line at a time (CRLF tolerant). */
export async function* readLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield buffer
}

/** Yields the payload of every `data:` line in a Server-Sent-Events stream. */
export async function* readSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  for await (const line of readLines(body)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('data:')) {
      yield trimmed.slice(5).trim()
    }
  }
}

/** Normalises tool-call arguments (a JSON string or an object) to an object. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const value = JSON.parse(raw)
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Parses a successful response body as JSON, but tolerates the misery of
 * captive-portal / CDN HTML pages that return 200 with `text/html`. Without
 * this guard, `await res.json()` throws `SyntaxError: Unexpected token <`
 * and the user sees a useless raw error. The wrapped `ProviderError`
 * gives them something actionable.
 */
export async function readJsonOrError<T>(res: Response, label: string): Promise<T> {
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  // Heuristic: if the body opens with `<` it's HTML/XML and json parse will
  // fail with a cryptic message. Surface the real cause instead.
  const trimmed = text.trimStart()
  if (
    !contentType.includes('json') &&
    (trimmed.startsWith('<') || /<html/i.test(trimmed))
  ) {
    throw new ProviderError(
      `${label} returned HTML instead of JSON — likely a captive portal, CDN error page, or wrong endpoint URL (${res.status}).`
    )
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ProviderError(`${label} returned a non-JSON response: ${detail}`)
  }
}

/** Reads an error response body and produces a concise message. */
export async function httpError(res: Response, label: string): Promise<ProviderError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message ?? json?.error ?? json?.message ?? text
    } catch {
      detail = text
    }
  } catch {
    detail = res.statusText
  }
  const trimmed = String(detail).slice(0, 300).trim()
  return new ProviderError(`${label} request failed (${res.status}): ${trimmed}`, res.status)
}
