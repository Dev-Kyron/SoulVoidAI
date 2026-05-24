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
import { resolveBaseUrl, recordSeenModels, getConfig } from '../storage/config'
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
import { log } from '../logger'
import { isRetryableProviderError, pickFallbackProvider } from './fallback'
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

/**
 * Resolve the model to use when falling back to a different provider.
 * Each provider has its own model namespace (Claude's "claude-sonnet-4-5"
 * means nothing to Gemini) so we read the user's stored selection for
 * the fallback provider, then back off to the provider's default.
 */
function fallbackModelFor(providerId: ProviderId): string {
  const cfg = getConfig()
  const stored = cfg.providers?.[providerId]?.model
  if (stored) return stored
  return ALL_PROVIDERS_META[providerId].defaultModel
}

/** Notify renderers that a fallback fired so the UI can toast the user. */
function broadcastFallback(from: ProviderId, to: ProviderId, reason: string): void {
  broadcast('ai:fallback', {
    from,
    fromLabel: ALL_PROVIDERS_META[from].label,
    to,
    toLabel: ALL_PROVIDERS_META[to].label,
    reason
  })
}

export async function runCompletion(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  signal: AbortSignal
): Promise<CompletionOutcome> {
  return runCompletionAttempt(req, onDelta, signal, new Set())
}

/**
 * Internal worker for runCompletion that threads a `tried` set so the
 * recursive fallback call doesn't re-pick a provider we already failed
 * against. Public callers go through runCompletion which seeds an empty
 * set; that wrapper exists so the IPC surface stays one-arg.
 */
async function runCompletionAttempt(
  req: ChatRequest,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
  tried: ReadonlySet<ProviderId>
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

  // Wrap the user's onDelta so we know whether any tokens have streamed
  // before an error fires. Mid-stream failures CAN'T cleanly fall back —
  // the renderer has already rendered partial text from the first provider,
  // and rewinding would confuse the reader. So we only retry when nothing
  // has been emitted yet.
  let streamed = false
  const trackingOnDelta = (delta: string): void => {
    if (delta.length > 0) streamed = true
    onDelta(delta)
  }

  try {
    const text = await provider.complete({
      apiKey,
      baseUrl,
      model: req.model,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
      signal,
      onDelta: trackingOnDelta
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
    if (!streamed && isRetryableProviderError(err)) {
      const nextTried = new Set(tried).add(req.provider)
      const fallbackId = pickFallbackProvider(req.provider, nextTried)
      if (fallbackId) {
        const fallbackModel = fallbackModelFor(fallbackId)
        broadcastFallback(req.provider, fallbackId, humanError(err, meta.label))
        return runCompletionAttempt(
          { ...req, provider: fallbackId, model: fallbackModel },
          onDelta,
          signal,
          nextTried
        )
      }
    }
    return { text: '', error: humanError(err, meta.label) }
  }
}

/** Runs one non-streaming, tool-enabled agent step.
 *  Pass `{ tools: [] }` to suppress the built-in + MCP tool schema (used
 *  by callers that want a clean one-shot completion, e.g. screen-watch's
 *  JSON-observation prompt where any tool call would be wasted tokens). */
export async function invokeCompletion(
  req: AgentRequest,
  signal: AbortSignal,
  options?: { tools?: import('./types').ProviderTool[] }
): Promise<AgentResult> {
  return invokeCompletionAttempt(req, signal, new Set(), options)
}

/**
 * Internal worker mirroring runCompletionAttempt — agent steps are
 * non-streaming so the "no tokens emitted" guard isn't needed; any
 * retryable error is a clean restart on a fresh provider.
 */
async function invokeCompletionAttempt(
  req: AgentRequest,
  signal: AbortSignal,
  tried: ReadonlySet<ProviderId>,
  options?: { tools?: import('./types').ProviderTool[] }
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
    // v1.10.1 — `click_on_screen` is filtered out unless the user has
    // explicitly opted into experimentalFeatures.visualClick. The tool's
    // accuracy depends on vision-model precision + browser accessibility
    // exposure, neither of which is reliable enough yet for the default
    // bundle. When off, the model literally doesn't see the tool exists.
    // v1.10.2 — surface the filter outcome in the log so we can debug
    // "is the model actually seeing click_on_screen?" without guessing.
    const filteredTools =
      options?.tools ?? [
        ...TOOL_SPECS.filter((t) => {
          if (t.actionType === 'visual-click') {
            return getConfig().experimentalFeatures?.visualClick === true
          }
          return true
        }),
        ...getMcpTools()
      ]
    // Only log the toolbox composition for default (agent) invocations —
    // internal callers that override `options.tools` (screen-watch
    // passing [], vision-locate calls passing []) don't need a noise
    // entry every tick.
    if (!options?.tools) {
      const visualClickAvailable = filteredTools.some(
        (t) => t.name === 'click_on_screen'
      )
      log(
        'info',
        'ai',
        `[ai] invoke via ${req.provider}/${req.model} — ${filteredTools.length} tools available, click_on_screen=${visualClickAvailable ? 'YES' : 'no'}`
      )
    }
    const result = await provider.invoke({
      apiKey,
      baseUrl,
      model: req.model,
      system: req.system,
      messages: req.messages,
      tools: filteredTools,
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
    if (isRetryableProviderError(err)) {
      const nextTried = new Set(tried).add(req.provider)
      const fallbackId = pickFallbackProvider(req.provider, nextTried)
      if (fallbackId) {
        const fallbackModel = fallbackModelFor(fallbackId)
        broadcastFallback(req.provider, fallbackId, humanError(err, meta.label))
        return invokeCompletionAttempt(
          { ...req, provider: fallbackId, model: fallbackModel },
          signal,
          nextTried,
          options
        )
      }
    }
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
