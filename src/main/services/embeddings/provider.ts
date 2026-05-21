/**
 * Embedding client. Routes the configured embedding source: OpenAI via HTTP,
 * Ollama via HTTP, or `local` — a Transformers.js pipeline running inside
 * the RAG worker (downloads ~25 MB once on first use, then fully offline +
 * free + unlimited). Returns null when nothing can serve, so callers can
 * gracefully disable RAG features.
 *
 * Each call returns the model that produced the vectors — vectors from
 * different models live in different spaces and must not be mixed at search
 * time. The vector store records this alongside each record.
 */
import { getApiKey } from '../storage/keys'
import { getConfig, resolveBaseUrl } from '../storage/config'
import { embedTextsViaWorker } from '../rag-worker'
import { log } from '../logger'
import type { EmbeddingProvider } from '@shared/types'

const OPENAI_MODEL = 'text-embedding-3-small'
const OLLAMA_MODEL = 'nomic-embed-text'
const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2'
const MAX_INPUT_CHARS = 4000

export interface EmbedResult {
  vectors: number[][]
  model: string
}

/** Reads the configured embedding provider, with `'auto'` as the default. */
function activeProvider(): EmbeddingProvider {
  return getConfig().chat.embeddingProvider ?? 'auto'
}

export function embeddingsAvailable(): boolean {
  const provider = activeProvider()
  if (provider === 'local') return true // worker handles download lazily
  if (provider === 'openai') return Boolean(getApiKey('openai'))
  if (provider === 'ollama') {
    const ollama = resolveBaseUrl('ollama')
    return Boolean(ollama && ollama.trim().length > 0)
  }
  // 'auto' — true if *any* path has a chance.
  if (getApiKey('openai')) return true
  const ollama = resolveBaseUrl('ollama')
  return Boolean(ollama && ollama.trim().length > 0)
}

/** True iff OpenAI specifically has a configured API key. */
export function hasOpenAIKey(): boolean {
  return Boolean(getApiKey('openai'))
}

function clip(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text
}

async function embedViaOpenAI(texts: string[]): Promise<EmbedResult | null> {
  const key = getApiKey('openai')
  if (!key) return null
  const base = resolveBaseUrl('openai')
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: OPENAI_MODEL, input: texts.map(clip) })
    })
    if (!res.ok) {
      log(
        'warn',
        'rag',
        `OpenAI embeddings request failed (${res.status})`,
        await res.text().catch(() => res.statusText)
      )
      return null
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> }
    const ordered = [...data.data].sort((a, b) => a.index - b.index)
    return { vectors: ordered.map((d) => d.embedding), model: `openai:${OPENAI_MODEL}` }
  } catch (err) {
    log(
      'warn',
      'rag',
      'OpenAI embeddings call threw',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

async function embedViaOllama(texts: string[]): Promise<EmbedResult | null> {
  const base = resolveBaseUrl('ollama')
  if (!base) return null
  try {
    // Ollama's batch endpoint accepts an array of inputs.
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: texts.map(clip) })
    })
    if (!res.ok) {
      log(
        'warn',
        'rag',
        `Ollama embeddings request failed (${res.status})`,
        await res.text().catch(() => res.statusText)
      )
      return null
    }
    const data = (await res.json()) as { embeddings?: number[][] }
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      log(
        'warn',
        'rag',
        'Ollama embeddings response shape unexpected',
        `expected ${texts.length} vectors, got ${data.embeddings?.length ?? 0}`
      )
      return null
    }
    return { vectors: data.embeddings, model: `ollama:${OLLAMA_MODEL}` }
  } catch (err) {
    log(
      'warn',
      'rag',
      'Ollama embeddings call threw',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

async function embedViaLocal(texts: string[]): Promise<EmbedResult | null> {
  try {
    return await embedTextsViaWorker({ texts: texts.map(clip) })
  } catch (err) {
    log(
      'warn',
      'rag',
      'Local embedder call threw',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * Embeds a batch of texts. Honours the configured provider:
 *  - `local`  → Transformers.js inside the RAG worker (offline, free)
 *  - `openai` → OpenAI HTTP only
 *  - `ollama` → Ollama HTTP only
 *  - `auto`   → OpenAI first (best quality if a key is set), else Ollama
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult | null> {
  if (texts.length === 0) return { vectors: [], model: 'none' }
  switch (activeProvider()) {
    case 'local':
      return embedViaLocal(texts)
    case 'openai':
      return embedViaOpenAI(texts)
    case 'ollama':
      return embedViaOllama(texts)
    default:
      return (await embedViaOpenAI(texts)) ?? (await embedViaOllama(texts))
  }
}

/** Returns the model id we *would* use, without making a request. */
export function preferredModel(): string {
  switch (activeProvider()) {
    case 'local':
      return `local:${LOCAL_MODEL}`
    case 'openai':
      return `openai:${OPENAI_MODEL}`
    case 'ollama':
      return `ollama:${OLLAMA_MODEL}`
    default:
      return hasOpenAIKey() ? `openai:${OPENAI_MODEL}` : `ollama:${OLLAMA_MODEL}`
  }
}
