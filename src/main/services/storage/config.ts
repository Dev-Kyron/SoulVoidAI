/**
 * Application configuration: active provider/model, workflow mode, granular
 * permissions, appearance and the base system prompt. Persisted locally; the
 * renderer receives a sanitised {@link ClientConfig} that never contains keys.
 */
import { JsonStore } from './store'
import { hasApiKey } from './keys'
import { PROVIDER_META, isLocalProvider } from '../ai/types'
import { wasLocalProviderDetected } from '../ai/detect'
import { DEFAULT_MODE } from '@shared/modes'
import { defaultPermissionState } from '@shared/permissions'
import type { PermissionId, PermissionState } from '@shared/permissions'
import type {
  AppearanceConfig,
  ChatBehaviourConfig,
  ClientConfig,
  ModeId,
  ProviderId,
  ProviderRuntime,
  SeenModels,
  VoiceConfig
} from '@shared/types'

interface ProviderSettings {
  model: string
  baseUrl: string
}

export interface AppConfigFile {
  activeProvider: ProviderId
  providers: Record<ProviderId, ProviderSettings>
  activeMode: ModeId
  permissions: Record<PermissionId, PermissionState>
  appearance: AppearanceConfig
  voice: VoiceConfig
  /** Conversation-behaviour switches (agent mode, auto-memory, private, rag). */
  chat: ChatBehaviourConfig
  /** When each model id was first observed from a `listModels` call, per provider. */
  seenModels: SeenModels
  syncFolder: string
  onboarded: boolean
  /** Last expanded-panel size (height 0 means "auto, full height"). */
  panel: { width: number; height: number }
  /**
   * Persisted bounds for the dedicated Settings window. Optional — the first
   * time it opens we centre it on the primary display, then write back as
   * the user moves/resizes.
   */
  settingsWindow?: { x: number; y: number; width: number; height: number }
  systemPrompt: string
}

const DEFAULT_SYSTEM_PROMPT =
  'You are VoidSoul, a futuristic AI operating layer for creators and developers. ' +
  'Be precise, fast and practical. Prefer concrete steps and runnable code. ' +
  'When the user asks you to do something on their machine, describe the action ' +
  'clearly — the app will request the matching permission before anything runs.'

const DEFAULT_PROVIDERS = (Object.keys(PROVIDER_META) as ProviderId[]).reduce(
  (acc, id) => {
    acc[id] = { model: PROVIDER_META[id].defaultModel, baseUrl: '' }
    return acc
  },
  {} as Record<ProviderId, ProviderSettings>
)

const DEFAULT_CONFIG: AppConfigFile = {
  // Default to Ollama — it's the only provider that costs nothing and needs
  // no key, so a fresh install never lands the user on a "paste a key" wall.
  // On boot, `autoDetectAndAdopt` probes localhost and either confirms this
  // (great, they're already running it) or — if they have a remote key set —
  // switches them over. Worst case: user has neither, gets a friendly prompt.
  activeProvider: 'ollama',
  providers: DEFAULT_PROVIDERS,
  activeMode: DEFAULT_MODE,
  permissions: defaultPermissionState(),
  appearance: {
    accent: 'violet',
    theme: 'dark',
    animations: true,
    glassOpacity: 0.85,
    alwaysOnTop: true,
    launchOnStartup: false,
    screenAwareness: false,
    nexusStyle: 'advanced',
    locale: 'system',
    dnd: { enabled: false, quietStart: null, quietEnd: null }
  },
  voice: {
    // Spoken replies on by default — v1.2.0 ships local Piper voices, so
    // there's no longer a "no voices configured" gap for new users to fall
    // into. The migration on first launch copies any Voices/<persona>/
    // files into the per-user voices folder; if none are present the
    // settings UI shows a clear "drop a .onnx file" empty state.
    enabled: true,
    persona: 'void',
    rate: 1,
    volume: 1,
    wakeWord: { enabled: false }
  },
  chat: {
    agent: true,
    autoMemory: true,
    private: false,
    rag: false,
    embeddingProvider: 'auto'
  },
  seenModels: {},
  syncFolder: '',
  onboarded: false,
  panel: { width: 472, height: 0 },
  systemPrompt: DEFAULT_SYSTEM_PROMPT
}

let cached: JsonStore<AppConfigFile> | null = null

/** Legacy top-level toggles, kept for one-shot migration into `chat`. */
interface LegacyChatFields {
  agentMode?: boolean
  autoMemory?: boolean
  privateChat?: boolean
  ragEnabled?: boolean
}

/**
 * Model ids that shipped in earlier defaults but never existed on the
 * upstream API — picking them at chat time returns 404. We rewrite any
 * stored selection that lands on one of these to the provider's current
 * defaultModel on next load. Keyed by exact match because partial matches
 * would also catch real models the user might have legitimately set.
 *
 * Entries here are one-way tombstones; once a user has been migrated off
 * the bad name, the next save persists the rewrite and they never see
 * the 404 again.
 */
const RETIRED_MODEL_IDS = new Set<string>([
  // Speculative Anthropic names from the v1.0-v1.2.4 defaults that
  // returned "model: ..." 404 in production.
  'claude-opus-4-7',
  'claude-opus-4-7-1m',
  'claude-opus-4-6',
  'claude-sonnet-4-6'
])

function normalize(c: AppConfigFile): AppConfigFile {
  const providers = {} as Record<ProviderId, ProviderSettings>
  for (const id of Object.keys(PROVIDER_META) as ProviderId[]) {
    const merged = { ...DEFAULT_PROVIDERS[id], ...c.providers?.[id] }
    // Auto-recover from the retired-model trap: existing users who picked
    // one of the bad defaults before the cleanup land here on the next
    // launch and get bumped to the provider's current defaultModel
    // (claude-sonnet-4-5 for Anthropic). One-time, idempotent.
    if (merged.model && RETIRED_MODEL_IDS.has(merged.model)) {
      merged.model = PROVIDER_META[id].defaultModel
    }
    providers[id] = merged
  }
  // Migrate the pre-bundled flat keys (agentMode, autoMemory, privateChat,
  // ragEnabled) into the new `chat` group. Existing users keep their settings.
  const legacy = c as AppConfigFile & LegacyChatFields
  const chat: ChatBehaviourConfig = {
    agent: c.chat?.agent ?? legacy.agentMode ?? DEFAULT_CONFIG.chat.agent,
    autoMemory: c.chat?.autoMemory ?? legacy.autoMemory ?? DEFAULT_CONFIG.chat.autoMemory,
    private: c.chat?.private ?? legacy.privateChat ?? DEFAULT_CONFIG.chat.private,
    rag: c.chat?.rag ?? legacy.ragEnabled ?? DEFAULT_CONFIG.chat.rag,
    embeddingProvider:
      c.chat?.embeddingProvider ?? DEFAULT_CONFIG.chat.embeddingProvider
  }
  // Strip the legacy keys so they don't linger on disk forever after migration.
  const cleaned: Record<string, unknown> = { ...c }
  delete cleaned.agentMode
  delete cleaned.autoMemory
  delete cleaned.privateChat
  delete cleaned.ragEnabled
  return {
    ...DEFAULT_CONFIG,
    ...(cleaned as Partial<AppConfigFile>),
    providers,
    appearance: {
      ...DEFAULT_CONFIG.appearance,
      ...c.appearance,
      dnd: { ...DEFAULT_CONFIG.appearance.dnd, ...c.appearance?.dnd }
    },
    voice: {
      ...DEFAULT_CONFIG.voice,
      ...c.voice,
      wakeWord: { ...DEFAULT_CONFIG.voice.wakeWord, ...c.voice?.wakeWord }
    },
    chat,
    seenModels: c.seenModels ?? DEFAULT_CONFIG.seenModels,
    panel: { ...DEFAULT_CONFIG.panel, ...c.panel },
    permissions: { ...DEFAULT_CONFIG.permissions, ...c.permissions }
  }
}

/** Records first-seen timestamps for newly-discovered models, returns the diff. */
export function recordSeenModels(provider: ProviderId, modelIds: string[]): {
  firstSeen: Record<string, string>
  newSinceLast: string[]
} {
  const all = store().get()
  const existing = all.seenModels[provider] ?? {}
  const now = new Date().toISOString()
  const merged = { ...existing }
  const newSinceLast: string[] = []
  for (const id of modelIds) {
    if (!merged[id]) {
      merged[id] = now
      newSinceLast.push(id)
    }
  }
  if (newSinceLast.length > 0) {
    store().set({ seenModels: { ...all.seenModels, [provider]: merged } })
  }
  return { firstSeen: merged, newSinceLast }
}

function store(): JsonStore<AppConfigFile> {
  if (!cached) {
    cached = new JsonStore<AppConfigFile>('config', DEFAULT_CONFIG)
    cached.replace(normalize(cached.get()))
  }
  return cached
}

export function getConfig(): AppConfigFile {
  return store().get()
}

export function updateConfig(patch: Partial<AppConfigFile>): AppConfigFile {
  return store().set(patch)
}

export function setPanelSize(width: number, height: number): void {
  store().set({ panel: { width, height } })
}

export function setSettingsWindowBounds(bounds: {
  x: number
  y: number
  width: number
  height: number
}): void {
  store().set({ settingsWindow: bounds })
}

export function setProvider(id: ProviderId, patch: Partial<ProviderSettings>): AppConfigFile {
  const providers = { ...getConfig().providers }
  providers[id] = { ...providers[id], ...patch }
  return updateConfig({ providers })
}

export function setAppearance(patch: Partial<AppearanceConfig>): AppConfigFile {
  return updateConfig({ appearance: { ...getConfig().appearance, ...patch } })
}

export function setVoice(patch: Partial<VoiceConfig>): AppConfigFile {
  return updateConfig({ voice: { ...getConfig().voice, ...patch } })
}

export function resolveBaseUrl(id: ProviderId): string {
  const configured = getConfig().providers[id].baseUrl.trim()
  return configured || PROVIDER_META[id].defaultBaseUrl || ''
}

/** Builds the renderer-facing config — strictly no secret material. */
export function getClientConfig(): ClientConfig {
  const c = getConfig()
  const providers: ProviderRuntime[] = (Object.keys(PROVIDER_META) as ProviderId[]).map((id) => {
    const meta = PROVIDER_META[id]
    // Local providers get a `localReady` flag so the renderer's dropdown can
    // show "✓ detected" vs "not running" — non-local providers leave it
    // undefined so the existing key-status badge keeps working unchanged.
    const isLocal = isLocalProvider(id)
    return {
      id,
      label: meta.label,
      model: c.providers[id].model,
      baseUrl: resolveBaseUrl(id),
      needsKey: meta.needsKey,
      hasKey: hasApiKey(id),
      defaultModels: meta.defaultModels,
      localReady: isLocal ? wasLocalProviderDetected(id) : undefined
    }
  })
  return {
    activeProvider: c.activeProvider,
    providers,
    activeMode: c.activeMode,
    permissions: c.permissions,
    appearance: c.appearance,
    voice: c.voice,
    chat: c.chat,
    seenModels: c.seenModels,
    syncFolder: c.syncFolder,
    onboarded: c.onboarded,
    systemPrompt: c.systemPrompt
  }
}
