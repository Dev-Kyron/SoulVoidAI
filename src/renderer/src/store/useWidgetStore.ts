/**
 * Floating-widget UI state: collapsed vs expanded, the active panel tab and
 * the orb's visual state. Expansion grows the OS window first, then the panel
 * animates in; collapsing reverses the order via `finishCollapse`.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import type { WidgetState } from '@shared/types'

// Settings used to be a tab here; it now lives in its own window opened via
// the gear icon in the panel header. The tab union narrows accordingly.
export type PanelTab = 'nexus' | 'chat' | 'notebook' | 'logs'

interface WidgetStore {
  expanded: boolean
  busy: boolean
  orbState: WidgetState
  /**
   * Whether the wake-word engine has actually booted and is scanning audio
   * right now. Surfaces on the orb only when `orbState === 'idle'`, so a
   * chat-in-progress or active recording isn't visually overridden by the
   * background listener. See `visibleOrbState`.
   */
  wakeListening: boolean
  /**
   * Per-session arm switch — separate from the persisted
   * `config.voice.wakeWord.enabled`. Defaults to `false` on every app
   * launch even if wake-word is enabled in settings; users must click an
   * "Arm" control to actually start listening. This stops the orb from
   * pulsing the moment the panel opens, which beta testers read as "the
   * app is recording me without permission".
   */
  wakeArmed: boolean
  activeTab: PanelTab

  setTab: (tab: PanelTab) => void
  setOrbState: (state: WidgetState) => void
  setWakeListening: (listening: boolean) => void
  setWakeArmed: (armed: boolean) => void
  expand: () => Promise<void>
  collapse: () => void
  toggle: () => Promise<void>
  finishCollapse: () => void
}

let revertTimer: number | undefined

export const useWidgetStore = create<WidgetStore>((set, get) => ({
  expanded: false,
  busy: false,
  orbState: 'idle',
  wakeListening: false,
  wakeArmed: false,
  activeTab: 'nexus',

  setTab: (tab) => set({ activeTab: tab }),

  setOrbState: (state) => {
    window.clearTimeout(revertTimer)
    set({ orbState: state })
    // Transient states settle back to idle on their own.
    if (state === 'success' || state === 'error') {
      revertTimer = window.setTimeout(() => set({ orbState: 'idle' }), 1600)
    }
  },

  setWakeListening: (listening) => {
    // Skip the no-op write so subscribers don't re-render on every boot ping.
    if (get().wakeListening === listening) return
    set({ wakeListening: listening })
  },

  setWakeArmed: (armed) => {
    if (get().wakeArmed === armed) return
    set({ wakeArmed: armed })
  },

  expand: async () => {
    if (get().expanded || get().busy) return
    set({ busy: true })
    await vs.window.setExpanded(true)
    set({ expanded: true, busy: false })
  },

  collapse: () => {
    if (!get().expanded) return
    // Flip the flag — the panel exit animation runs, then finishCollapse fires.
    set({ expanded: false })
  },

  toggle: async () => {
    if (get().expanded) get().collapse()
    else await get().expand()
  },

  finishCollapse: () => {
    if (!get().expanded) void vs.window.setExpanded(false)
  }
}))

/**
 * Resolves the orb state the user actually sees. The wake-engine baseline only
 * surfaces when nothing more important is happening — chat streaming, voice
 * capture, transient success/error flashes all take priority over the gentle
 * "armed and waiting" pulse.
 */
export function useVisibleOrbState(): WidgetState {
  return useWidgetStore((s) =>
    s.orbState === 'idle' && s.wakeListening ? 'wake-listening' : s.orbState
  )
}
