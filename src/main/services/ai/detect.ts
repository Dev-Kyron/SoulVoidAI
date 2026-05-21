/**
 * Local AI provider auto-detection. Probes the standard ports for Ollama and
 * LM Studio at app boot; if either is running and the user hasn't configured
 * a working provider yet, the detected one is adopted as the active provider
 * automatically — so a fresh user with Ollama already installed goes straight
 * to a working chat with zero key paste-ins.
 *
 * Probes use short timeouts so a non-running daemon doesn't slow the boot.
 * Detection is best-effort and silent on failure (a network blip shouldn't
 * leave a confused toast in the user's face).
 */
import {
  getClientConfig,
  getConfig,
  resolveBaseUrl,
  setProvider,
  updateConfig
} from '../storage/config'
import { hasApiKey } from '../storage/keys'
import { PROVIDER_META, isLocalProvider } from './types'
import { log } from '../logger'
import { broadcast } from '../../events'
import type { ProviderId } from '@shared/types'

const PROBE_TIMEOUT_MS = 1200

/**
 * Defensive sanitiser for model-name strings coming back from a local probe.
 * A rogue service bound to 11434/1234 could return arbitrarily large or
 * crafted strings — we cap length, strip control chars, and allowlist a
 * reasonable character set since these names flow into HTTP request bodies
 * and config storage.
 */
function sanitiseModelName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 200) return null
  // Model ids in the wild use letters, digits, `.`, `-`, `_`, `:`, `/`, `~`.
  // Anything else is suspect — reject rather than silently mangling.
  if (!/^[A-Za-z0-9._:/~-]+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Set of local providers found reachable by the last detection sweep. Used by
 * `getClientConfig` to stamp `localReady` onto each provider runtime so the
 * dropdown can show "✓ detected" without re-probing on every config read.
 *
 * The variable is reassigned (not mutated) when detection updates, so a
 * concurrent reader (`getClientConfig` running on the main thread between
 * a clear and re-add) can never observe a transiently-empty set.
 */
let lastDetected: ReadonlySet<ProviderId> = new Set()

/** Whether the named provider was reachable in the most recent detection sweep. */
export function wasLocalProviderDetected(id: ProviderId): boolean {
  return lastDetected.has(id)
}

/**
 * Stamps a local provider as reachable WITHOUT a full re-probe — used when
 * an adjacent operation (e.g. `listModels`) succeeds against the provider,
 * which is positive proof the daemon is up. Saves a probe round-trip on a
 * cold start where the user manually refreshes models, and crucially closes
 * the gap where the FirstRunBanner would otherwise stick around until the
 * next boot.
 *
 * Reassigns rather than mutates so concurrent readers always see the full
 * set in one observation.
 */
export function markLocalProviderReachable(id: ProviderId): void {
  if (!isLocalProvider(id)) return
  if (lastDetected.has(id)) return
  const next = new Set(lastDetected)
  next.add(id)
  lastDetected = next
  broadcast('config:updated', getClientConfig())
}

export interface DetectedProvider {
  id: Extract<ProviderId, 'ollama' | 'lmstudio' | 'llamacpp'>
  /** Names of locally-loaded models. The first entry becomes the default model. */
  models: string[]
}

/** GET with a per-call AbortController so a hung daemon doesn't stall boot. */
async function probe(url: string): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probeOllama(): Promise<DetectedProvider | null> {
  const base = resolveBaseUrl('ollama')
  if (!base) return null
  const res = await probe(`${base}/api/tags`)
  if (!res) return null
  try {
    const json = (await res.json()) as { models?: Array<{ name: unknown }> }
    const models = (json.models ?? [])
      .map((m) => sanitiseModelName(m.name))
      .filter((n): n is string => n !== null)
    return { id: 'ollama', models }
  } catch {
    return null
  }
}

/**
 * LM Studio and llama-server (llama.cpp's bundled HTTP server) both expose
 * the OpenAI-compatible `/v1/models` shape, so one probe covers both. Kept
 * generic so a future OpenAI-compatible local backend slots in by id only.
 */
async function probeOpenAICompatible(
  id: Extract<ProviderId, 'lmstudio' | 'llamacpp'>
): Promise<DetectedProvider | null> {
  const base = resolveBaseUrl(id)
  if (!base) return null
  const res = await probe(`${base}/v1/models`)
  if (!res) return null
  try {
    const json = (await res.json()) as { data?: Array<{ id: unknown }> }
    const models = (json.data ?? [])
      .map((m) => sanitiseModelName(m.id))
      .filter((n): n is string => n !== null)
    return { id, models }
  } catch {
    return null
  }
}

/** Probes all known local providers in parallel. */
export async function detectLocalProviders(): Promise<DetectedProvider[]> {
  const results = await Promise.all([
    probeOllama(),
    probeOpenAICompatible('lmstudio'),
    probeOpenAICompatible('llamacpp')
  ])
  return results.filter((r): r is DetectedProvider => r !== null && r.models.length > 0)
}

/**
 * Re-probes the local providers and updates the detection cache, without the
 * "auto-adopt if no active provider" side-effect. For mid-session refreshes —
 * e.g. when the user starts Ollama AFTER launch and clicks "Refresh models",
 * the dropdown should immediately stop showing "— not running" without
 * surprise-switching their active provider.
 */
export async function refreshLocalProviderDetection(): Promise<void> {
  const detected = await detectLocalProviders()
  const before = lastDetected
  const next: ReadonlySet<ProviderId> = new Set(detected.map((d) => d.id))
  // Single-statement swap — readers see either the old set or the new one,
  // never a transiently-empty intermediate.
  lastDetected = next
  // Only emit a config-updated broadcast when the set actually changed,
  // otherwise every model-refresh tick would spam every open window.
  let changed = before.size !== next.size
  if (!changed) {
    for (const id of next) {
      if (!before.has(id)) {
        changed = true
        break
      }
    }
  }
  if (changed) broadcast('config:updated', getClientConfig())
}

/**
 * Whether the user's currently-active provider can actually answer a request
 * right now. Keyed-providers need a stored key; local providers are usable
 * whenever their daemon is reachable (which we just probed for).
 */
function activeProviderIsUsable(detected: DetectedProvider[]): boolean {
  const cfg = getConfig()
  const meta = PROVIDER_META[cfg.activeProvider]
  if (!meta) return false
  if (meta.needsKey) return hasApiKey(cfg.activeProvider)
  // Local providers — usable iff we just successfully probed them.
  return detected.some((d) => d.id === cfg.activeProvider)
}

/**
 * Runs detection and, if the user has no working provider yet, adopts the
 * first detected local one — seeding its default model from whatever's
 * actually loaded so the chat works on the first message. Idempotent: a user
 * who already has a real provider configured is never overridden.
 */
export async function autoDetectAndAdopt(): Promise<void> {
  const detected = await detectLocalProviders()
  // Refresh the detection cache so the renderer's provider picker reflects
  // whichever local daemons are actually up — even when none were adopted.
  // Build the new set in full, THEN swap the reference in one assignment so
  // readers never see a transient empty state.
  lastDetected = new Set(detected.map((d) => d.id))
  if (detected.length === 0) return

  // Always update the seeded default model for *any* detected local provider —
  // this keeps the model picker accurate when the user manually switches over
  // later, without overriding a model they've already explicitly picked.
  let modelChanged = false
  for (const d of detected) {
    const current = getConfig().providers[d.id]
    const fallback = PROVIDER_META[d.id].defaultModel
    // Only overwrite when the stored model is the bare default — leave any
    // manual pick alone.
    if (!current.model || current.model === fallback) {
      setProvider(d.id, { model: d.models[0] })
      modelChanged = true
    }
  }

  if (activeProviderIsUsable(detected)) {
    if (modelChanged) broadcast('config:updated', getClientConfig())
    log(
      'info',
      'system',
      `Local AI detected (${detected.map((d) => d.id).join(', ')}); active provider already usable.`
    )
    return
  }

  // No usable active provider — switch to the first detected one.
  const pick = detected[0]
  updateConfig({ activeProvider: pick.id })
  log(
    'success',
    'system',
    `Local AI detected — switched active provider to ${PROVIDER_META[pick.id].label} (${pick.models[0]}).`
  )
  broadcast('config:updated', getClientConfig())
}
