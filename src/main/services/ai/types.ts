/**
 * Provider metadata and the internal interface every AI provider implements.
 */
import type { ChatTurn, ProviderId, ToolCall } from '@shared/types'

export interface ProviderMeta {
  id: ProviderId
  label: string
  /** Whether an API key is required for this provider to function. */
  needsKey: boolean
  defaultModel: string
  defaultModels: string[]
  defaultBaseUrl?: string
}

/**
 * Local (self-hosted, free) providers. Centralised so adding a fourth one
 * (e.g. a future MLX server) is a single-edit change — every "is this Ollama
 * or LM Studio or llama.cpp?" branch reads from here.
 */
export const LOCAL_PROVIDER_IDS = new Set<ProviderId>(['ollama', 'lmstudio', 'llamacpp'])

export function isLocalProvider(id: ProviderId): boolean {
  return LOCAL_PROVIDER_IDS.has(id)
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    defaultBaseUrl: 'https://api.openai.com'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    needsKey: true,
    defaultModel: 'claude-sonnet-4-5',
    defaultModels: [
      // Newest first — the Refresh button will pull whatever the API actually
      // returns; this list is the fallback so the dropdown is never empty.
      'claude-opus-4-7',
      'claude-opus-4-7-1m',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-1',
      'claude-3-5-haiku-latest'
    ],
    defaultBaseUrl: 'https://api.anthropic.com'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    needsKey: true,
    defaultModel: 'gemini-2.0-flash',
    defaultModels: ['gemini-2.0-flash', 'gemini-2.0-pro-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (Local)',
    needsKey: false,
    defaultModel: 'llama3.2',
    defaultModels: ['llama3.2', 'llama3.1', 'qwen2.5', 'mistral', 'phi3'],
    defaultBaseUrl: 'http://localhost:11434'
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    needsKey: false,
    // LM Studio's API is OpenAI-compatible; the actually-loaded model id comes
    // back from `/v1/models` so this default is just a placeholder until
    // detection populates the real one.
    defaultModel: 'local-model',
    defaultModels: [],
    defaultBaseUrl: 'http://localhost:1234'
  },
  llamacpp: {
    id: 'llamacpp',
    // `llama-server` is the OpenAI-compatible HTTP server bundled with
    // llama.cpp. Power-users running GGUF models directly typically start
    // it on port 8080 — `llama-server -m model.gguf`. Detecting it gives
    // VoidSoul the GGUF audience without bundling 200+ MB of llama.cpp
    // binaries ourselves.
    label: 'llama.cpp Server (Local)',
    needsKey: false,
    defaultModel: 'local-model',
    defaultModels: [],
    defaultBaseUrl: 'http://localhost:8080'
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    defaultModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama-3.2-90b-vision-preview',
      'mixtral-8x7b-32768',
      'gemma2-9b-it'
    ],
    defaultBaseUrl: 'https://api.groq.com/openai'
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    needsKey: true,
    defaultModel: 'grok-2-latest',
    defaultModels: ['grok-2-latest', 'grok-2-vision-1212', 'grok-beta'],
    defaultBaseUrl: 'https://api.x.ai'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    defaultModel: 'openai/gpt-4o-mini',
    defaultModels: [
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash-exp',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat'
    ],
    defaultBaseUrl: 'https://openrouter.ai/api'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    needsKey: true,
    defaultModel: 'deepseek-chat',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    defaultBaseUrl: 'https://api.deepseek.com'
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    needsKey: true,
    defaultModel: 'mistral-large-latest',
    defaultModels: [
      'mistral-large-latest',
      'mistral-small-latest',
      'open-mistral-nemo',
      'codestral-latest'
    ],
    defaultBaseUrl: 'https://api.mistral.ai'
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    needsKey: false,
    defaultModel: '',
    defaultModels: [],
    defaultBaseUrl: ''
  }
}

/** Options passed to a provider for a single streaming completion. */
export interface CompletionOptions {
  apiKey: string | null
  baseUrl: string
  model: string
  system: string
  messages: ChatTurn[]
  temperature?: number
  signal: AbortSignal
  /** Invoked for every incremental token / text fragment. */
  onDelta: (delta: string) => void
}

/**
 * The minimum shape every AI provider needs to advertise a tool to the model.
 * Built-in automation tools (ToolSpec) and MCP-server tools both reduce to
 * this shape before being shipped to the provider. `parameters` is a JSON
 * Schema fragment — kept as `object` so both our rigid built-in schema and
 * whatever an MCP server hands us flow through without coercion.
 */
export interface ProviderTool {
  name: string
  description: string
  parameters: object
}

/** Options for a non-streaming, tool-enabled agent step. */
export interface InvokeOptions {
  apiKey: string | null
  baseUrl: string
  model: string
  system: string
  messages: ChatTurn[]
  tools: ProviderTool[]
  temperature?: number
  signal: AbortSignal
}

/** Result of an agent step — assistant text plus any tool calls requested. */
export interface CompletionResult {
  text: string
  toolCalls: ToolCall[]
}

export interface AIProvider {
  id: ProviderId
  /** Streams a plain completion, returning the full assembled text. */
  complete(opts: CompletionOptions): Promise<string>
  /** Runs one non-streaming, tool-enabled step. */
  invoke(opts: InvokeOptions): Promise<CompletionResult>
  /** Returns the model ids available for this provider/key. */
  listModels(apiKey: string | null, baseUrl: string): Promise<string[]>
}

export class ProviderError extends Error {
  /**
   * HTTP status code from the upstream provider, when the error came from an
   * HTTP response. Undefined for non-HTTP errors (JSON parse failures, etc.).
   * The auto-fallback dispatcher reads this directly rather than regexing
   * `message` — adding a structured field keeps the trigger conditions
   * (429 / 502-504 / network) trivially testable.
   */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}
