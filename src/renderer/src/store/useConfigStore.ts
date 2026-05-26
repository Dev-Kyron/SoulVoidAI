/**
 * Mirrors the persisted application configuration. Every mutator round-trips
 * through the main process and stores the authoritative {@link ClientConfig}
 * it returns, so the renderer never drifts from disk.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type {
  AppearanceConfig,
  ClientConfig,
  EmbeddingProvider,
  MemoryConfig,
  ModeId,
  ProactiveVoiceConfig,
  ScreenWatchConfig,
  ProviderId,
  ProviderRuntime,
  VoiceConfig
} from '@shared/types'
import type { PermissionId } from '@shared/permissions'

interface ConfigState {
  config: ClientConfig | null
  models: Partial<Record<ProviderId, string[]>>
  ready: boolean

  load: () => Promise<void>
  /**
   * Applies a `ClientConfig` snapshot pushed from the main process —
   * used by the cross-window `config:updated` event so two open windows
   * stay in lockstep when one edits a setting.
   */
  applyExternal: (config: ClientConfig) => void
  activeProvider: () => ProviderRuntime | null

  setActiveProvider: (provider: ProviderId) => Promise<void>
  setProviderModel: (provider: ProviderId, model: string) => Promise<void>
  setProviderBaseUrl: (provider: ProviderId, baseUrl: string) => Promise<void>
  setApiKey: (provider: ProviderId, key: string) => Promise<void>
  setActiveMode: (mode: ModeId) => Promise<void>
  setAppearance: (patch: Partial<AppearanceConfig>) => Promise<void>
  setVoice: (patch: Partial<VoiceConfig>) => Promise<void>
  setAgentMode: (enabled: boolean) => Promise<void>
  setAutoMemory: (enabled: boolean) => Promise<void>
  setPrivateChat: (enabled: boolean) => Promise<void>
  setRagEnabled: (enabled: boolean) => Promise<void>
  setAutoRoute: (enabled: boolean) => Promise<void>
  setMemory: (patch: Partial<MemoryConfig>) => Promise<void>
  setProactiveVoice: (patch: Partial<ProactiveVoiceConfig>) => Promise<void>
  setScreenWatch: (patch: Partial<ScreenWatchConfig>) => Promise<void>
  setEmbeddingProvider: (provider: EmbeddingProvider) => Promise<void>
  setOnboarded: (value: boolean) => Promise<void>
  setSystemPrompt: (prompt: string) => Promise<void>
  setPermission: (id: PermissionId, granted: boolean) => Promise<void>
  loadModels: (provider: ProviderId) => Promise<void>
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  models: {},
  ready: false,

  load: async () => {
    set({ config: await vs.config.get(), ready: true })
  },

  applyExternal: (config) => {
    set((state) => (state.ready ? { config } : { config, ready: true }))
  },

  activeProvider: () => {
    const config = get().config
    if (!config) return null
    return config.providers.find((p) => p.id === config.activeProvider) ?? null
  },

  setActiveProvider: async (provider) => {
    set({ config: await vs.config.setActiveProvider(provider) })
  },

  setProviderModel: async (provider, model) => {
    set({ config: await vs.config.setProvider(provider, { model }) })
  },

  setProviderBaseUrl: async (provider, baseUrl) => {
    set({ config: await vs.config.setProvider(provider, { baseUrl }) })
  },

  setApiKey: async (provider, key) => {
    set({ config: await vs.config.setApiKey(provider, key) })
  },

  setActiveMode: async (mode) => {
    set({ config: await vs.config.setActiveMode(mode) })
  },

  setAppearance: async (patch) => {
    set({ config: await vs.config.setAppearance(patch) })
  },

  setVoice: async (patch) => {
    set({ config: await vs.config.setVoice(patch) })
  },

  setAgentMode: async (enabled) => {
    set({ config: await vs.config.setAgentMode(enabled) })
  },

  setAutoMemory: async (enabled) => {
    set({ config: await vs.config.setAutoMemory(enabled) })
  },

  setPrivateChat: async (enabled) => {
    set({ config: await vs.config.setPrivateChat(enabled) })
  },

  setRagEnabled: async (enabled) => {
    set({ config: await vs.config.setRagEnabled(enabled) })
  },

  setAutoRoute: async (enabled) => {
    set({ config: await vs.config.setAutoRoute(enabled) })
  },

  setMemory: async (patch) => {
    set({ config: await vs.config.setMemory(patch) })
  },

  setProactiveVoice: async (patch) => {
    set({ config: await vs.config.setProactiveVoice(patch) })
  },
  setScreenWatch: async (patch) => {
    set({ config: await vs.config.setScreenWatch(patch) })
  },

  setEmbeddingProvider: async (provider) => {
    set({ config: await vs.config.setEmbeddingProvider(provider) })
  },

  setOnboarded: async (value) => {
    set({ config: await vs.config.setOnboarded(value) })
  },

  setSystemPrompt: async (prompt) => {
    set({ config: await vs.config.setSystemPrompt(prompt) })
  },

  setPermission: async (id, granted) => {
    const permissions = await vs.permissions.set(id, granted)
    const config = get().config
    if (config) set({ config: { ...config, permissions } })
  },

  loadModels: async (provider) => {
    const list = await vs.ai.listModels(provider)
    set((state) => ({ models: { ...state.models, [provider]: list } }))
  }
}))
