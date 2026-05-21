/**
 * Mirrors installed plugins and the quick actions they contribute.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { PluginInfo, QuickAction } from '@shared/types'

interface PluginStore {
  plugins: PluginInfo[]
  actions: QuickAction[]
  loaded: boolean
  load: () => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  reload: () => Promise<void>
}

export const usePluginStore = create<PluginStore>((set) => ({
  plugins: [],
  actions: [],
  loaded: false,

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
  }
}))
