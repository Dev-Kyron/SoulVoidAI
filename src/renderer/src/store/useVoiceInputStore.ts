/**
 * Voice input orchestration: records from the microphone, transcribes via the
 * main process, and sends the result straight into the conversation — the
 * hands-free side of the assistant. Drives the orb's "listening" state.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import { startRecording, stopRecording, cancelRecording } from '../lib/voiceInput'
import { stopSpeaking } from '../lib/voice'
import { useConfigStore } from './useConfigStore'
import { useChatStore } from './useChatStore'
import { useWidgetStore } from './useWidgetStore'
import { useUiStore } from './useUiStore'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/**
 * Has a transcribe call landed successfully this session? When false AND no
 * cloud STT key is configured, the first call has to download Whisper-tiny
 * (~75 MB) — that's a 5-15s wait with no visible signal otherwise. Tracked
 * at module scope so it survives store re-creation in HMR.
 */
let sttWarmed = false

/**
 * Monotonic generation token. The recording→transcribing→send pipeline
 * snapshots it (`++voiceGen`) before its first await; if the snapshot no
 * longer matches `voiceGen` when the await resolves, the result is
 * discarded rather than fired into whatever the user has since navigated
 * to. `cancel()` also bumps the gen so a mid-transcribe cancel drops the
 * pending result on the floor.
 */
let voiceGen = 0

interface VoiceInputState {
  status: VoiceInputStatus
  /** Starts recording when idle; stops, transcribes and sends when recording. */
  toggle: () => Promise<void>
  cancel: () => void
}

export const useVoiceInputStore = create<VoiceInputState>((set, get) => ({
  status: 'idle',

  toggle: async () => {
    const status = get().status
    if (status === 'transcribing') return

    if (status === 'recording') {
      set({ status: 'transcribing' })
      useWidgetStore.getState().setOrbState('processing')
      // Snapshot the generation token before any await — checked at every
      // await boundary below so a cancel() / fresh toggle() mid-transcribe
      // drops the stale result instead of letting it land in whatever
      // thread the user has since navigated to.
      const gen = ++voiceGen
      const stillCurrent = (): boolean => gen === voiceGen
      // stopRecording now decodes the webm blob to PCM via OfflineAudioContext
      // — that can throw on corrupt audio. Catch here so the orb doesn't get
      // stuck in 'processing' forever.
      let clip: Awaited<ReturnType<typeof stopRecording>>
      try {
        clip = await stopRecording()
      } catch (err) {
        set({ status: 'idle' })
        useWidgetStore.getState().setOrbState('error')
        // The raw browser error (e.g. "EncodingError: Unable to decode audio
        // data") is opaque. Surface a friendly message and stash the detail
        // in the activity log for users who want to dig.
        void vs.logs.write(
          'error',
          'system',
          'Voice input decode failed',
          err instanceof Error ? err.message : String(err)
        )
        useUiStore
          .getState()
          .pushToast(
            'error',
            "Couldn't read that recording. Try again — and check the logs tab if it keeps failing."
          )
        return
      }
      if (!clip) {
        set({ status: 'idle' })
        useWidgetStore.getState().setOrbState('idle')
        return
      }
      // First transcribe of the session AND no cloud STT key configured =
      // main will route to local Whisper, which has a ~75 MB cold-download.
      // Surface a toast so the user knows why "processing" sticks for 5-15s.
      if (!sttWarmed) {
        const cfg = useConfigStore.getState().config
        const providers = cfg?.providers ?? []
        const cloudReady =
          providers.find((p) => p.id === 'openai')?.hasKey ||
          providers.find((p) => p.id === 'gemini')?.hasKey
        if (!cloudReady) {
          useUiStore
            .getState()
            .pushToast('info', 'Preparing speech-to-text model (one-time download)…')
        }
      }
      const result = await vs.ai.transcribe(clip)
      sttWarmed = true
      // Drop a stale result rather than firing it into the wrong thread.
      // We still leave `status` alone — a newer toggle() may have already
      // taken ownership of it.
      if (!stillCurrent()) return
      set({ status: 'idle' })
      if (result.error) {
        useWidgetStore.getState().setOrbState('error')
        // Prefix the friendly context so the user sees "Voice transcription
        // failed — <detail>" rather than just a cryptic provider error like
        // "401 Unauthorized" floating in a toast with no operation context.
        useUiStore
          .getState()
          .pushToast('error', `Voice transcription failed — ${result.error}`)
        return
      }
      const text = result.text.trim()
      if (text.length < 2) {
        useWidgetStore.getState().setOrbState('idle')
        useUiStore.getState().pushToast('info', "Didn't catch that — try again.")
        return
      }
      // The reply surfaces wherever the user is — no forced tab switch.
      void useChatStore.getState().send(text)
      return
    }

    // idle → begin recording. If the assistant was speaking, interrupt it
    // first — same UX shape as ChatGPT/Claude voice mode: tap the mic (or
    // say a wake word) mid-TTS and the assistant immediately shuts up so
    // your follow-up isn't talking over its own voice.
    stopSpeaking()
    const config = useConfigStore.getState().config
    if (!config) return
    if (!config.permissions.microphone.granted) {
      const granted = await useUiStore.getState().promptPermission('microphone', 'Voice input')
      if (!granted) {
        useUiStore.getState().pushToast('info', 'Voice input cancelled — microphone not granted.')
        return
      }
      await useConfigStore.getState().setPermission('microphone', true)
    }
    try {
      await startRecording()
      set({ status: 'recording' })
      useWidgetStore.getState().setOrbState('listening')
    } catch {
      set({ status: 'idle' })
      useUiStore.getState().pushToast('error', 'Could not access the microphone.')
    }
  },

  cancel: () => {
    const status = get().status
    if (status === 'idle') return
    if (status === 'recording') cancelRecording()
    // Bump the generation so any in-flight transcribe await is treated as
    // stale and its result is dropped on the floor. Also resets the orb so
    // a slow transcribe that won't complete doesn't leave it stuck on
    // 'processing' forever — cancel means cancel.
    voiceGen++
    set({ status: 'idle' })
    useWidgetStore.getState().setOrbState('idle')
  }
}))
