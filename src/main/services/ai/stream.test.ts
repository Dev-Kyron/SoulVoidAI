import { describe, expect, it } from 'vitest'
import {
  httpError,
  invokeAbortSignal,
  parseToolArgs,
  readJsonOrError,
  readLines,
  readSSE,
  rethrowAsTimeout
} from './stream'
import { ProviderError } from './types'

/**
 * Covers the streaming primitives every provider impl funnels through.
 * If `readLines` mis-splits, `readSSE` drops events, or `invokeAbortSignal`
 * never fires, the whole agent loop hangs or garbles tokens — exactly the
 * silent-failure class the test suite needs to lock down.
 */

/**
 * Builds a `ReadableStream<Uint8Array>` from a list of UTF-8 string chunks,
 * mirroring how a fetch response body delivers data in arbitrary slices.
 * Splitting across boundaries is the interesting case for `readLines` — the
 * decoder has to buffer partial lines without losing the trailing fragment.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]))
    }
  })
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe('readLines', () => {
  it('yields one line per LF and drops the CR before it (CRLF tolerance)', async () => {
    const stream = streamFromChunks(['alpha\r\nbeta\ngamma\r\n'])
    expect(await collect(readLines(stream))).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reassembles lines that straddle chunk boundaries', async () => {
    // 'alpha\nbeta' split mid-word — the decoder must buffer 'be' until
    // the next chunk delivers 'ta\n'.
    const stream = streamFromChunks(['alp', 'ha\nbe', 'ta\n'])
    expect(await collect(readLines(stream))).toEqual(['alpha', 'beta'])
  })

  it('yields the trailing fragment when the stream ends without a newline', async () => {
    const stream = streamFromChunks(['final-no-newline'])
    expect(await collect(readLines(stream))).toEqual(['final-no-newline'])
  })

  it('skips a blank trailing fragment (no spurious empty string at EOF)', async () => {
    const stream = streamFromChunks(['only\n'])
    expect(await collect(readLines(stream))).toEqual(['only'])
  })
})

describe('readSSE', () => {
  it('extracts the payload of every data: line and drops everything else', async () => {
    // Mixes event:/id:/comment lines + blank separators — only `data:` payloads
    // should come through. This is the SSE shape OpenAI / Anthropic both emit.
    const stream = streamFromChunks([
      'event: message\n',
      'data: {"delta":"hi"}\n',
      'id: 1\n',
      '\n',
      'data: [DONE]\n'
    ])
    expect(await collect(readSSE(stream))).toEqual(['{"delta":"hi"}', '[DONE]'])
  })

  it('tolerates leading whitespace on the data: prefix', async () => {
    const stream = streamFromChunks(['  data: payload\n'])
    expect(await collect(readSSE(stream))).toEqual(['payload'])
  })
})

describe('parseToolArgs', () => {
  it('returns the object unchanged when handed an object', () => {
    const raw = { path: '/tmp/x', mode: 'r' }
    expect(parseToolArgs(raw)).toBe(raw)
  })

  it('parses a JSON string into an object', () => {
    expect(parseToolArgs('{"path":"/tmp/x"}')).toEqual({ path: '/tmp/x' })
  })

  it('returns an empty object when the string is malformed', () => {
    // Providers occasionally stream a tool-call's `arguments` field as
    // partial JSON before the stream finishes; the parser must degrade
    // gracefully rather than throwing into the agent loop.
    expect(parseToolArgs('{"path":"/tm')).toEqual({})
  })

  it('returns an empty object when the string parses to a non-object', () => {
    expect(parseToolArgs('null')).toEqual({})
    expect(parseToolArgs('"just a string"')).toEqual({})
    expect(parseToolArgs('42')).toEqual({})
  })

  it('returns an empty object for null / undefined / empty input', () => {
    expect(parseToolArgs(null)).toEqual({})
    expect(parseToolArgs(undefined)).toEqual({})
    expect(parseToolArgs('')).toEqual({})
    expect(parseToolArgs('   ')).toEqual({})
  })
})

describe('readJsonOrError', () => {
  it('parses a JSON body into the declared shape', async () => {
    const res = new Response(JSON.stringify({ ok: true, n: 7 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
    expect(await readJsonOrError<{ ok: boolean; n: number }>(res, 'Provider')).toEqual({
      ok: true,
      n: 7
    })
  })

  it('throws a ProviderError when the body is HTML (captive portal / CDN page)', async () => {
    const html = '<!doctype html><html><body>Hotel WiFi Login</body></html>'
    const res = new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    })
    await expect(readJsonOrError(res, 'OpenAI')).rejects.toMatchObject({
      name: 'ProviderError',
      // Surfaces "returned HTML" so the user knows what actually happened.
      message: expect.stringContaining('returned HTML')
    })
  })

  it('throws a ProviderError with the parser detail when the body is non-JSON garbage', async () => {
    const res = new Response('not json at all', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
    await expect(readJsonOrError(res, 'Anthropic')).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('non-JSON response')
    })
  })
})

describe('httpError', () => {
  it('extracts error.message from a structured JSON error body', async () => {
    const body = JSON.stringify({ error: { message: 'Rate limited, try again later' } })
    const res = new Response(body, { status: 429 })
    const err = await httpError(res, 'OpenAI')
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('429')
    expect(err.message).toContain('Rate limited')
  })

  it('falls back to raw text when the body is not JSON', async () => {
    const res = new Response('Service Unavailable', { status: 503 })
    const err = await httpError(res, 'Anthropic')
    expect(err.status).toBe(503)
    expect(err.message).toContain('503')
    expect(err.message).toContain('Service Unavailable')
  })

  it('clamps overly long error bodies to keep toasts readable', async () => {
    // Some upstreams return multi-kilobyte HTML on errors; the truncation
    // keeps that out of the user-facing copy.
    const huge = 'x'.repeat(2000)
    const res = new Response(huge, { status: 500 })
    const err = await httpError(res, 'Provider')
    // 300 char cap + the "Provider request failed (500): " prefix. Allow
    // some headroom; we only care that it didn't dump 2000 chars verbatim.
    expect(err.message.length).toBeLessThan(500)
  })
})

describe('invokeAbortSignal', () => {
  // `AbortSignal.timeout()` schedules on the native event loop, not vitest's
  // fake timer queue — `vi.advanceTimersByTime` is a no-op against it. We use
  // real timers with short durations and wait the wall-clock delay instead.
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('aborts when the timeout elapses', async () => {
    const signal = invokeAbortSignal(undefined, 30)
    expect(signal.aborted).toBe(false)
    await wait(60)
    expect(signal.aborted).toBe(true)
  })

  it('aborts when the user signal fires before the timeout', () => {
    const user = new AbortController()
    const signal = invokeAbortSignal(user.signal, 60_000)
    expect(signal.aborted).toBe(false)
    user.abort()
    expect(signal.aborted).toBe(true)
  })

  it('aborts when EITHER source fires (timeout wins the race here)', async () => {
    const user = new AbortController()
    const signal = invokeAbortSignal(user.signal, 30)
    await wait(60)
    expect(signal.aborted).toBe(true)
    // Late user abort still safe — no throw on a second abort.
    expect(() => user.abort()).not.toThrow()
  })
})

describe('rethrowAsTimeout', () => {
  it('wraps a DOMException TimeoutError into a friendly message naming the provider', () => {
    const err = new Error('signal is aborted without reason')
    err.name = 'TimeoutError'
    expect(() => rethrowAsTimeout(err, 'OpenAI', 5000)).toThrow(/OpenAI.*timed out.*5s/)
  })

  it('lets user-driven AbortError bubble through unchanged', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(() => rethrowAsTimeout(err, 'OpenAI')).toThrow(err)
  })

  it('lets unrelated errors bubble through unchanged', () => {
    const err = new Error('something else broke')
    expect(() => rethrowAsTimeout(err, 'OpenAI')).toThrow(err)
  })
})
