/**
 * Provider-agnostic AI gateway. Resolves the active provider, injects the
 * decrypted API key (which never leaves the main process) and streams the
 * completion back through the supplied delta callback.
 */
import { openaiProvider } from './openai'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'
import { ollamaProvider } from './ollama'
import { PROVIDER_META, ProviderError, isLocalProvider } from './types'
import type { AIProvider, ProviderMeta } from './types'
import { getApiKey, hasApiKey } from '../storage/keys'
import { resolveBaseUrl, recordSeenModels } from '../storage/config'
import {
  refreshLocalProviderDetection,
  markLocalProviderReachable,
  wasLocalProviderDetected
} from './detect'
import { PROVIDER_META as ALL_PROVIDERS_META } from './types'
import { broadcast } from '../../events'
import { TOOL_SPECS } from '../automation/tools'
import { getProviderTools as getMcpTools } from '../mcp/manager'
import { recordUsage } from '../usage'
import type { AgentRequest, AgentResult, ChatRequest, ChatTurn, ProviderId } from '@shared/types'

/** Joins a turn list into a single string for token estimation. */
function flattenTurns(system: string, turns: ChatTurn[]): { text: string; imageCount: number } {
  let imageCount = 0
  const parts: string[] = [system]
  for (const t of turns) {
    if (t.content) parts.push(t.content)
    if (t.images?.length) imageCount += t.images.length
    if (t.toolResults?.length) {
      for (const r of t.toolResults) parts.push(r.content)
    }
  }
  return { text: parts.join('\n'), imageCount }
}

const PROVIDERS: Record<ProviderId, AIProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  // OpenAI-compatible providers share the OpenAI engine; only base URL differs.
  lmstudio: openaiProvider,
  llamacpp: openaiProvider,
  groq: openaiProvider,
  xai: openaiProvider,
  openrouter: openaiProvider,
  deepseek: openaiProvider,
  mistral: openaiProvider,
  custom: openaiProvider
}

export interface CompletionOutcome {
  text: string
  /** Set on failure; the special value `'aborted'` means the user stopped it. */
  error?: string
}

/**
 * Pre-flight check for local providers — returns a friendly setup-hint error
 * when the daemon wasn't found in the last detection sweep, or null when the
 * provider is either remote (no check needed) or local-and-reachable.
 */
function localUnavailableError(provider: ProviderId, meta: ProviderMeta): string | null {
  if (!isLocalProvider(provider)) return null
  if (wasLocalProviderDetected(provider)) return null
  return `${meta.label} isn't running. Install it (ollama.com/download) or switch to an AI provider with an API key in Settings.`
}

function humanError(err: unknown, label: string): string {
  if (err instanceof ProviderError) return err.message
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted'
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(err.message)) {
      return `${label} could not be reached. Check the server, network or base URL.`
    }
    return err.message
  }
  return 'Unexpected error during completion.'
}

export async function runCompletion(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  signal: AbortSignal
): Promise<CompletionOutcome> {
  const provider = PROVIDERS[req.provider]
  const meta = PROVIDER_META[req.provider]
  if (!provider || !meta) {
    return { text: '', error: `Unknown provider: ${req.provider}` }
  }

  const apiKey = getApiKey(req.provider)
  if (meta.needsKey && !apiKey) {
    return { text: '', error: `No API key configured for ${meta.label}. Add one in Settings.` }
  }
  const baseUrl = resolveBaseUrl(req.provider)
  if (!baseUrl) {
    return { text: '', error: `No endpoint URL set for ${meta.label}. Add one in Settings.` }
  }
  // Local provider, but the boot probe didn't find a daemon. Surface a
  // friendly setup hint instead of letting the user wait for a fetch error.
  const unreachable = localUnavailableError(req.provider, meta)
  if (unreachable) return { text: '', error: unreachable }

  try {
    const text = await provider.complete({
      apiKey,
      baseUrl,
      model: req.model,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
      signal,
      onDelta
    })
    const flat = flattenTurns(req.system, req.messages)
    recordUsage({
      provider: req.provider,
      model: req.model,
      kind: 'chat',
      inputText: flat.text,
      outputText: text,
      imageCount: flat.imageCount,
      estimated: true
    })
    return { text }
  } catch (err) {
    if (signal.aborted) return { text: '', error: 'aborted' }
    return { text: '', error: humanError(err, meta.label) }
  }
}

/** Runs one non-streaming, tool-enabled agent step. */
export async function invokeCompletion(
  req: AgentRequest,
  signal: AbortSignal
): Promise<AgentResult> {
  const provider = PROVIDERS[req.provider]
  const meta = PROVIDER_META[req.provider]
  if (!provider || !meta) {
    return { text: '', toolCalls: [], error: `Unknown provider: ${req.provider}` }
  }

  const apiKey = getApiKey(req.provider)
  if (meta.needsKey && !apiKey) {
    return {
      text: '',
      toolCalls: [],
      error: `No API key configured for ${meta.label}. Add one in Settings.`
    }
  }
  const baseUrl = resolveBaseUrl(req.provider)
  if (!baseUrl) {
    return {
      text: '',
      toolCalls: [],
      error: `No endpoint URL set for ${meta.label}. Add one in Settings.`
    }
  }
  const unreachable = localUnavailableError(req.provider, meta)
  if (unreachable) return { text: '', toolCalls: [], error: unreachable }

  try {
    const result = await provider.invoke({
      apiKey,
      baseUrl,
      model: req.model,
      system: req.system,
      messages: req.messages,
      // Built-in automation tools plus whatever MCP servers are connected.
      tools: [...TOOL_SPECS, ...getMcpTools()],
      signal
    })
    const flat = flattenTurns(req.system, req.messages)
    recordUsage({
      provider: req.provider,
      model: req.model,
      kind: 'invoke',
      inputText: flat.text,
      outputText: result.text,
      imageCount: flat.imageCount,
      estimated: true
    })
    return { text: result.text, toolCalls: result.toolCalls }
  } catch (err) {
    if (signal.aborted) return { text: '', toolCalls: [], error: 'aborted' }
    return { text: '', toolCalls: [], error: humanError(err, meta.label) }
  }
}

export async function listModels(provider: ProviderId): Promise<string[]> {
  const impl = PROVIDERS[provider]
  const meta = PROVIDER_META[provider]
  if (!impl || !meta) return []
  let result: string[]
  let reachable = false
  try {
    const models = await impl.listModels(getApiKey(provider), resolveBaseUrl(provider))
    reachable = models.length > 0
    result = models.length
      ? [...new Set([...models, ...meta.defaultModels])]
      : meta.defaultModels
  } catch {
    result = meta.defaultModels
  }
  // A successful listModels against a local daemon is positive proof it's
  // up — mark it without paying for another probe round-trip. Closes the
  // gap where the FirstRunBanner would stick around until a full restart
  // even after the user manually clicked "Refresh models" on a freshly-
  // started Ollama.
  if (reachable && isLocalProvider(provider)) {
    markLocalProviderReachable(provider)
  }
  // Record first-seen timestamps so the UI can surface a NEW badge on freshly
  // discovered models. Brand-new arrivals get broadcast as an event.
  const { newSinceLast } = recordSeenModels(provider, result)
  if (newSinceLast.length > 0) {
    broadcast('ai:new-models', { provider, models: newSinceLast })
  }
  return result
}

/**
 * Quietly refreshes the model list for every provider that has a key — used
 * once on app start so freshly-released models surface without the user
 * needing to open the Provider settings. Also re-probes local providers so
 * the dropdown's "✓ detected" badge stays accurate if the user starts
 * Ollama / LM Studio mid-session.
 */
export async function refreshAllModels(): Promise<void> {
  const ids = Object.keys(ALL_PROVIDERS_META) as ProviderId[]
  await Promise.all([
    refreshLocalProviderDetection(),
    ...ids.map(async (id) => {
      const meta = ALL_PROVIDERS_META[id]
      // Skip providers that need a key but don't have one — no point hitting them.
      if (meta.needsKey && !hasApiKey(id)) return
      // Skip if the provider has no configured baseUrl (e.g. blank Custom).
      const base = resolveBaseUrl(id)
      if (!base) return
      try {
        await listModels(id)
      } catch {
        /* silent — best-effort */
      }
    })
  ])
}
