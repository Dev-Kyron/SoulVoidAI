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
import type { PersonaTemplate } from '@shared/personas'
import { defaultPermissionState } from '@shared/permissions'
import type { PermissionId, PermissionState } from '@shared/permissions'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/defaultPrompts'
import type {
  AppearanceConfig,
  ChatBehaviourConfig,
  ClientConfig,
  ExperimentalFeaturesConfig,
  MemoryConfig,
  ModeId,
  ProactiveVoiceConfig,
  ProviderId,
  ProviderRuntime,
  ScreenWatchConfig,
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
  /**
   * v2.0 — user-defined persona templates. Each is a sharable bundle of
   * {system prompt + recommended model + sample prompts} that the user
   * can apply to a thread via the Persona panel. Doesn't override the
   * 6 built-in MODES — these are presets on top of them. Empty by
   * default; populated by export/import or in-app creation.
   */
  customPersonas: PersonaTemplate[]
  permissions: Record<PermissionId, PermissionState>
  appearance: AppearanceConfig
  voice: VoiceConfig
  /** Conversation-behaviour switches (agent mode, auto-memory, private, rag). */
  chat: ChatBehaviourConfig
  /** v1.4.0+ emotional context + sentiment classifier config. */
  memory: MemoryConfig
  /** v1.5.0+ proactive watch tasks master switch. */
  proactiveVoice: ProactiveVoiceConfig
  /** v1.7+ screen-watch loop config — Soul periodically looks at the
   *  screen and may speak proactively if she sees something useful. */
  screenWatch: ScreenWatchConfig
  /** v1.10.1+ experimental feature gates (visualClick, etc.). */
  experimentalFeatures: ExperimentalFeaturesConfig
  /** When each model id was first observed from a `listModels` call, per provider. */
  seenModels: SeenModels
  syncFolder: string
  /** v2.0 — true once the user has set up the E2E sync vault on this
   *  device (either created or joined). Independent of `syncFolder`
   *  being set: the legacy manual backup/import path also uses
   *  `syncFolder` without engaging the continuous encrypted engine. */
  syncPaired?: boolean
  /** v2.0 — this device's UUID inside the sync vault. Stable across
   *  launches; regenerated only on unpair/re-pair. */
  syncDeviceId?: string
  /** v2.0 — user-visible label for this device (e.g. "Kyron-Desktop"),
   *  shown in the vault's device registry on every peer. */
  syncDeviceName?: string
  /** v2.0 polish — the encrypted-vault subfolder (typically
   *  `<userPickedParent>/voidsoul-sync`). Kept distinct from
   *  `syncFolder` so the legacy "Push bundle" button can't be tricked
   *  into writing a plaintext JSON dump into the encrypted vault
   *  directory after pairing. The engine reads + writes only this
   *  field; the legacy backup path reads + writes only `syncFolder`. */
  syncVaultFolder?: string
  onboarded: boolean
  /** v2.0 — browser-extension bridge master switch. Off by default; the
   *  Settings panel toggles it after the user pastes their extension id
   *  and accepts the install prompt. Optional in the on-disk schema so
   *  older config files migrate cleanly to a sensible default. */
  browserExtension?: { enabled: boolean }
  /** v2.0 — Home Assistant native integration. Off by default. Token
   *  stored separately in the OS keychain. */
  homeAssistant?: { url: string; enabled: boolean }
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

// v2.0 polish — DEFAULT_SYSTEM_PROMPT body now lives ONLY in
// shared/defaultPrompts.ts. The inline copy here was 130 lines of duplicated
// string with a misleading "asserted equal at boot" comment promising drift
// protection that didn't exist. One source of truth, imported at the top.
// All references in this file point at the imported binding.

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
  // v2.0 — empty by default; users grow this list by importing bundles
  // or saving their own through the Persona panel.
  customPersonas: [],
  permissions: defaultPermissionState(),
  appearance: {
    accent: 'violet',
    theme: 'dark',
    animations: true,
    glassOpacity: 0.85,
    alwaysOnTop: true,
    launchOnStartup: false,
    screenAwareness: false,
    // v2.0 — semantic awareness opt-in. Local OCR via tesseract.js
    // when both this AND the coarse `screenAwareness` flag are on.
    semanticScreenAwareness: false,
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
    wakeWord: { enabled: false },
    // v2.0 — both default to empty so pre-2.0 behaviour is preserved:
    // activeVoice() falls back to voices[0], resolveEffectivePersona()
    // falls back to the global `persona`. Users opt in via Settings.
    selectedVoiceByPersona: {},
    personaByMode: {}
  },
  chat: {
    agent: true,
    autoMemory: true,
    private: false,
    rag: false,
    embeddingProvider: 'auto',
    autoRoute: true,
    // v2.0 — plugin JS hooks default OFF. Even when a plugin is enabled
    // and its manifest declares hooks, nothing runs until the user flips
    // this master switch in Settings. Forces an informed choice.
    pluginHooks: false
  },
  memory: {
    // Emotional context on by default — Soul's wishlist item #1, beta
    // testers want it. Silently skips when no fast model is reachable,
    // so this is opt-in by capability rather than opt-in by config.
    emotionalContext: true,
    // Auto-pick the cheapest model from the active provider unless the
    // user pins one explicitly in Settings.
    sentimentModel: null,
    // v2.0 — summariser defaults match the pre-2.0 hardcoded constants
    // (SUMMARIZE_TRIGGER_TOKENS=10_000, KEEP_RECENT_MIN=8) so existing
    // users see identical behaviour after upgrade. Users tune per-mode
    // via summariserPerMode below.
    summariserTriggerTokens: 10_000,
    summariserKeepRecent: 8,
    summariserPerMode: {},
    // v2.0 — pause fact extraction during stressed/stuck sessions so
    // the assistant doesn't memorialise frustration. Defaults ON; only
    // does anything when `emotionalContext` is also on (no signal
    // otherwise).
    sentimentPruning: true,
    // v2.0 — passive biographical profile. Headline v2.0 feature: a
    // categorized profile (identity / projects / preferences /
    // relationships / tools / work-patterns) auto-extracted from each
    // streaming reply. Default ON because passive memory is the whole
    // point; users who hate the idea turn it off in Settings → Memory.
    biographical: true
  },
  proactiveVoice: {
    // Master kill-switch ON by default so that when the user opts INTO
    // a specific watch task (all four ship disabled), it actually fires.
    // Flipping this off is the one-toggle way to silence the whole
    // proactive subsystem without unticking every task individually.
    enabled: true
  },
  screenWatch: {
    // Ships OFF — screen-watch sends screenshots to the active AI
    // provider every interval, which has real cost + privacy
    // implications. Explicit opt-in in Settings (and the screenCapture
    // permission must also be granted) before any tick fires.
    enabled: false,
    // 15 minutes balances "responsive enough to notice you're stuck"
    // against "doesn't blow your token budget". Tunable in Settings.
    intervalMinutes: 15,
    // Active hours default 09:00-23:00 — same as the Long-idle watch
    // task default. Soul shouldn't be looking at 3am unless asked.
    activeFrom: '09:00',
    activeTo: '23:00',
    // 48 calls/day at 15min = roughly every 15 min for 12 hrs. Cap
    // exists so a misconfigured tight interval can't drain hundreds
    // of dollars overnight on a cloud provider.
    dailyCap: 48
  },
  seenModels: {},
  // v1.10.1 — experimental feature gates. All OFF by default; user
  // opts in explicitly from Settings → Experimental with copy that
  // sets honest expectations about reliability.
  experimentalFeatures: {
    visualClick: false,
    // v2.0 Phase 2 — `auto` does the right thing for most users (uia-then-
    // vision baseline, but transparently upgrade to sonnet-computer-use
    // when they happen to be on a capable Anthropic Sonnet model). Power
    // users override from Settings → Experimental.
    clickStrategy: 'auto'
  },
  syncFolder: '',
  syncPaired: false,
  syncDeviceId: '',
  syncDeviceName: '',
  syncVaultFolder: '',
  onboarded: false,
  browserExtension: { enabled: false },
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
    embeddingProvider: c.chat?.embeddingProvider ?? DEFAULT_CONFIG.chat.embeddingProvider,
    // v1.13.4 — back-compat: existing configs without `autoRoute` get
    // `true` so the router stays on by default. New installs also start
    // ON. User can flip it OFF in Settings → Providers when the router's
    // mid-prompt switching produces worse results than their Active pick.
    autoRoute: c.chat?.autoRoute ?? DEFAULT_CONFIG.chat.autoRoute,
    pluginHooks: c.chat?.pluginHooks ?? DEFAULT_CONFIG.chat.pluginHooks
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
    memory: { ...DEFAULT_CONFIG.memory, ...c.memory },
    proactiveVoice: { ...DEFAULT_CONFIG.proactiveVoice, ...c.proactiveVoice },
    screenWatch: { ...DEFAULT_CONFIG.screenWatch, ...c.screenWatch },
    experimentalFeatures: {
      ...DEFAULT_CONFIG.experimentalFeatures,
      ...c.experimentalFeatures
    },
    seenModels: c.seenModels ?? DEFAULT_CONFIG.seenModels,
    panel: { ...DEFAULT_CONFIG.panel, ...c.panel },
    permissions: { ...DEFAULT_CONFIG.permissions, ...c.permissions },
    // v2.0 — pre-2.0 configs lack the field; default to []. Existing
    // personas pass through verbatim (no per-item migration today).
    customPersonas: Array.isArray(c.customPersonas) ? c.customPersonas : []
  }
}

/** Records first-seen timestamps for newly-discovered models, returns the diff. */
export function recordSeenModels(
  provider: ProviderId,
  modelIds: string[]
): {
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

/* --------------------------- Persona templates -------------------------- */

/** Read the full list — used by the renderer to populate the picker. */
export function listCustomPersonas(): PersonaTemplate[] {
  return store().get().customPersonas
}

/**
 * Insert or replace a persona by id. Returns the new list so the renderer
 * can apply the update without a second round-trip. The id is the unique
 * key: an import that re-uses an existing id overwrites; importing the
 * same bundle twice (which mints a fresh id-with-timestamp suffix) lands
 * as a second entry, which is the expected "save another copy" behaviour.
 */
export function upsertCustomPersona(persona: PersonaTemplate): PersonaTemplate[] {
  const current = store().get().customPersonas
  const idx = current.findIndex((p) => p.id === persona.id)
  const next =
    idx === -1
      ? [...current, persona]
      : [...current.slice(0, idx), persona, ...current.slice(idx + 1)]
  store().set({ customPersonas: next })
  return next
}

/** Remove a persona by id. Returns the surviving list. */
export function removeCustomPersona(id: string): PersonaTemplate[] {
  const next = store()
    .get()
    .customPersonas.filter((p) => p.id !== id)
  store().set({ customPersonas: next })
  return next
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
    customPersonas: c.customPersonas,
    permissions: c.permissions,
    appearance: c.appearance,
    voice: c.voice,
    chat: c.chat,
    memory: c.memory,
    proactiveVoice: c.proactiveVoice,
    screenWatch: c.screenWatch,
    experimentalFeatures: c.experimentalFeatures,
    seenModels: c.seenModels,
    syncFolder: c.syncFolder,
    syncPaired: c.syncPaired ?? false,
    syncDeviceId: c.syncDeviceId ?? '',
    syncDeviceName: c.syncDeviceName ?? '',
    syncVaultFolder: c.syncVaultFolder ?? '',
    homeAssistant: c.homeAssistant ?? { url: '', enabled: false },
    onboarded: c.onboarded,
    systemPrompt: c.systemPrompt,
    // v2.0 — browser-extension bridge config. Falls back to disabled when
    // the field is missing in the persisted file (pre-2.0 installs).
    browserExtension: { enabled: c.browserExtension?.enabled ?? false }
  }
}
