/**
 * Mirrors installed plugins and the quick actions they contribute.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { PluginInfo, PluginManifest, PluginRegistryEntry, QuickAction } from '@shared/types'

interface PluginStore {
  plugins: PluginInfo[]
  actions: QuickAction[]
  loaded: boolean
  /** Registry entries from the last `browseRegistry` call. Null = not fetched yet. */
  registry: PluginRegistryEntry[] | null
  /** Latest registry-fetch error, surfaced in the marketplace UI. */
  registryError: string | null
  /** True while a browse / install round-trip is in flight. */
  registryBusy: boolean
  load: () => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  reload: () => Promise<void>
  /** Fetch the public registry. Caches the result; pass force=true to re-fetch. */
  browseRegistry: (force?: boolean) => Promise<void>
  /** Install a registry manifest. Refreshes the installed list on success. */
  install: (manifest: PluginManifest) => Promise<void>
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  actions: [],
  loaded: false,
  registry: null,
  registryError: null,
  registryBusy: false,

  load: async () => {
    // allSettled — if one of the two IPC calls happens to fail, the other's
    // result still populates so partial info is better than no info. Errors
    // are caught in main and logged there.
    const [pluginsRes, actionsRes] = await Promise.allSettled([
      vs.plugins.list(),
      vs.plugins.actions()
    ])
    set({
      plugins: pluginsRes.status === 'fulfilled' ? pluginsRes.value : [],
      actions: actionsRes.status === 'fulfilled' ? actionsRes.value : [],
      loaded: true
    })
  },

  setEnabled: async (id, enabled) => {
    const plugins = await vs.plugins.setEnabled(id, enabled)
    set({ plugins, actions: await vs.plugins.actions() })
  },

  reload: async () => {
    const plugins = await vs.plugins.reload()
    set({ plugins, actions: await vs.plugins.actions() })
  },

  browseRegistry: async (force = false) => {
    if (!force && get().registry) return
    set({ registryBusy: true, registryError: null })
    try {
      const registry = await vs.plugins.browse()
      set({ registry, registryBusy: false })
    } catch (err) {
      set({
        registryBusy: false,
        registryError: err instanceof Error ? err.message : 'Failed to load registry.'
      })
    }
  },

  install: async (manifest) => {
    set({ registryBusy: true })
    try {
      const plugins = await vs.plugins.install(manifest)
      set({ plugins, actions: await vs.plugins.actions(), registryBusy: false })
    } catch (err) {
      set({
        registryBusy: false,
        registryError: err instanceof Error ? err.message : 'Install failed.'
      })
      throw err
    }
  }
}))
