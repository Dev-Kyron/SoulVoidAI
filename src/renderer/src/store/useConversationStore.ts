/**
 * v2.0 — Conversational voice mode store.
 *
 * Single-instance binding around `ConversationController`. The renderer
 * never instantiates the controller directly; it goes through this store
 * so the overlay, the launch button, the global hotkey, and the auto-
 * close on shutdown all share one source of truth.
 *
 * The store stays small on purpose. Heavy lifting (audio graph, VAD,
 * recorder lifecycle) lives in `lib/conversationMode.ts`; this layer
 * exists so React components can subscribe to a Zustand slot instead
 * of holding the controller in a ref and remembering to subscribe /
 * unsubscribe manually.
 */
import { create } from 'zustand'
import {
  ConversationController,
  type ConversationOptions,
  type ConversationState
} from '../lib/conversationMode'
import { useChatStore } from './useChatStore'
import { useConfigStore } from './useConfigStore'
import { useWidgetStore } from './useWidgetStore'
import { useUiStore } from './useUiStore'
import { isQuietNow } from '@shared/types'

interface ConversationStoreState {
  status: ConversationState
  /** Most recent user transcript — surfaced in the overlay so the user
   *  can see what the model heard. Cleared on stop(). */
  lastUserTurn: string | null
  start: () => Promise<void>
  stop: () => void
  toggle: () => Promise<void>
}

// Module-scope controller — survives store re-creation in HMR so a
// dev-time edit doesn't strand a hot mic or a half-bound AudioContext.
let controller: ConversationController | null = null

export const useConversationStore = create<ConversationStoreState>((set, get) => {
  const ensureController = (): ConversationController => {
    if (controller) return controller
    const opts: ConversationOptions = {
      onState: (next) => {
        set({ status: next })
        // Mirror into the orb so the floating widget and the chat
        // surface reflect the same state without an extra subscription.
        const orb = useWidgetStore.getState()
        if (next === 'listening') orb.setOrbState('listening')
        else if (next === 'transcribing' || next === 'thinking') orb.setOrbState('processing')
        else if (next === 'speaking') orb.setOrbState('processing')
        else if (next === 'idle') orb.setOrbState('idle')
      },
      onUserTurn: (text) => {
        set({ lastUserTurn: text })
      },
      sendTurn: async (text) => {
        // v2.0 — bypass agent mode for conversation turns so latency
        // stays in the "feels natural" range. The agent loop can run
        // 30 s+ of tool calls; that breaks the back-and-forth rhythm
        // a voice conversation lives on. The streaming path with TTS
        // is what users expect from a Jarvis-style voice mode.
        await useChatStore.getState().send(text, { conversationMode: true })
      },
      onError: (message) => {
        useUiStore.getState().pushToast('error', `Voice mode — ${message}`)
      }
    }
    controller = new ConversationController(opts)
    return controller
  }

  return {
    status: 'idle',
    lastUserTurn: null,

    start: async () => {
      // Voice + DND gates — same logic as the speaker layer uses, so a
      // user who silenced voice can't accidentally enter a mode that
      // would talk over them anyway.
      const config = useConfigStore.getState().config
      if (!config) return
      if (!config.voice.enabled) {
        useUiStore
          .getState()
          .pushToast('info', 'Voice is muted in Settings — turn it on to use conversation mode.')
        return
      }
      if (isQuietNow(config.appearance.dnd)) {
        useUiStore
          .getState()
          .pushToast(
            'info',
            'Do Not Disturb is active — conversation mode would mean speaking aloud. Pause DND first.'
          )
        return
      }
      // Microphone permission — defer to the existing prompt path so
      // the user sees the same confirm UI they see for single-shot
      // voice input.
      if (!config.permissions.microphone.granted) {
        const granted = await useUiStore
          .getState()
          .promptPermission('microphone', 'Conversation mode')
        if (!granted) {
          useUiStore
            .getState()
            .pushToast('info', 'Conversation mode cancelled — microphone not granted.')
          return
        }
        await useConfigStore.getState().setPermission('microphone', true)
      }

      const ctrl = ensureController()
      set({ lastUserTurn: null })
      await ctrl.start()
    },

    stop: () => {
      controller?.stop()
      // controller.stop()'s onState callback will set status: 'idle' for
      // us in the normal path. We belt-and-braces here for the case
      // where the controller was already idle (early-return from
      // stop()) but the store somehow drifted — e.g. an error toast
      // path that set status without telling the controller. Explicit
      // reset costs nothing and closes the recovery hole.
      set({ status: 'idle', lastUserTurn: null })
    },

    toggle: async () => {
      const status = get().status
      if (status === 'idle') {
        await get().start()
      } else {
        get().stop()
      }
    }
  }
})
