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
  /**
   * Diagnostic — the most recent few Whisper-wake-word events. Each
   * entry is one of:
   *   · matched=true       — green, phrase fired
   *   · matched=false, text="…"  — grey, heard but didn't match
   *   · matched=false, text=""   — periodic silence beat (engine alive)
   *   · error set          — red, transcribe failed (see message)
   * Surfaced in Settings → Voice → Wake word so users can diagnose
   * "I said the phrase and nothing happened" instead of staring at
   * silent failure. Capped at 8 entries; Porcupine doesn't populate
   * this (keyword-based, no text). v1.7.2 added error + silence-beat.
   */
  wakeHeard: Array<{ at: number; text: string; matched: boolean; error?: string }>
  activeTab: PanelTab

  setTab: (tab: PanelTab) => void
  setOrbState: (state: WidgetState) => void
  setWakeListening: (listening: boolean) => void
  setWakeArmed: (armed: boolean) => void
  pushWakeHeard: (text: string, matched: boolean, error?: string) => void
  clearWakeHeard: () => void
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
  wakeHeard: [],
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

  pushWakeHeard: (text, matched, error) => {
    // v1.7.2 — accept silence beats (empty text, no error) and error
    // events alongside real transcriptions. The UI distinguishes via
    // the discriminated shape. Trim only the text field; an empty
    // text with `error` still counts as a useful event.
    const trimmed = text.trim()
    if (!trimmed && !error && !matched) {
      // Silence beat — represented as empty text with no error.
    } else if (!trimmed && !error) {
      // Shouldn't happen (matched=true with empty text is invalid),
      // but be defensive.
      return
    }
    // Keep last 8 — slightly more than v1.7.1's 5 because silence beats
    // + errors push useful entries off the list faster.
    const next = [{ at: Date.now(), text: trimmed, matched, error }, ...get().wakeHeard].slice(
      0,
      8
    )
    set({ wakeHeard: next })
  },

  clearWakeHeard: () => set({ wakeHeard: [] }),

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
