/**
 * v2.0 — Conversational voice mode (Jarvis-style).
 *
 * Full-duplex, interruptible voice loop. The user opens conversation
 * mode once, the mic stays open across turns, replies stream back as
 * speech, and the user can talk over the assistant to interrupt at
 * any moment (barge-in). After the assistant finishes speaking the
 * mic is already listening for the next turn — no second wake word.
 *
 * State machine
 * -------------
 *   idle         — controller not running, no mic, no audio resources
 *   listening    — mic capturing PCM, VAD looking for speech endpoint
 *   transcribing — captured chunk in flight to STT (Whisper local or cloud)
 *   thinking     — chat completion in flight, no audio playing yet
 *   speaking     — TTS streaming the reply; barge-in detector watching mic
 *
 * Transitions
 * -----------
 *   idle  → listening    : start()
 *   listening → transcribing : VAD detects post-voice silence (endpoint)
 *   transcribing → thinking  : transcript handed to chat store
 *   thinking → speaking      : first audio chunk plays (useSpeakerState transitions)
 *   speaking → listening     : TTS queue drains (natural end of reply)
 *                              OR barge-in detected (user talked over reply)
 *   * → idle                 : stop(), or auto-exit on extended silence
 *
 * Barge-in
 * --------
 * While `speaking`, we sample mic energy at 60 ms intervals. If RMS
 * crosses BARGE_IN_RMS for BARGE_IN_HOLD_MS continuously, we call
 * stopSpeaking() and transition back to listening — with the recording
 * already capturing the user's interruption. The barge-in threshold is
 * deliberately higher than the listening threshold so TTS bleed (even
 * with browser echo cancellation) doesn't false-trigger.
 *
 * Auto-exit
 * ---------
 * Pure 'listening' silence for 30 s with no voice ever → stop().
 * Prevents a forgotten conversation session from holding the mic open.
 *
 * Why not AudioWorklet
 * --------------------
 * For v1 we reuse MediaRecorder + AnalyserNode (same primitives the
 * existing voiceInput.ts uses) — keeps the diff small, the format pipeline
 * shared, and the latency budget comfortable. AudioWorklet would shave
 * ~50-100 ms off endpoint detection; worth doing in a follow-up once we
 * have telemetry on real-world turn-around feel.
 */
import { vs } from './bridge'
import { stopSpeaking, subscribeSpeakerState } from './voice'

/** Single-tap state for callers / UI. */
export type ConversationState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

/* --------------------------- tunables ---------------------------------- */

/** Whisper's native sample rate; the WAV the main process expects. */
const TARGET_SAMPLE_RATE = 16_000

/** RMS that counts as "voice present" while listening. Matches the
 *  silence-monitor in voiceInput.ts so the two paths behave the same. */
const LISTEN_VOICE_RMS = 0.015

/** RMS that counts as "user is barging in" while assistant is speaking.
 *  Higher than LISTEN_VOICE_RMS — even with browser echo cancellation
 *  the mic picks up some TTS bleed, and we don't want our own audio to
 *  cancel itself. 2x is the empirical sweet spot from internal testing. */
const BARGE_IN_RMS = 0.03

/** Sustained energy duration before we believe in a barge-in. Shorter
 *  windows fire on typing / chair-creak transients; longer windows
 *  feel laggy when the user wants to interrupt. */
const BARGE_IN_HOLD_MS = 200

/** Post-voice silence that signals end of utterance. Same value as
 *  voiceInput.ts so single-shot and conv mode feel identical. */
const ENDPOINT_SILENCE_MS = 1_200

/** Cap on a single listening segment (user kept talking forever). */
const MAX_UTTERANCE_MS = 30_000

/** Idle-conversation timeout — drop back to 'idle' after this much
 *  un-interrupted silence in 'listening'. */
const AUTO_EXIT_SILENCE_MS = 30_000

/** VAD sampling rate. 60 ms is fast enough that barge-in feels
 *  instantaneous and slow enough that the FFT + RMS math is free. */
const VAD_TICK_MS = 60

/* --------------------------- types ------------------------------------- */

export interface ConversationOptions {
  /** Called every time the state machine transitions. */
  onState?: (state: ConversationState) => void
  /** Called after each successful transcript before it's sent to chat. */
  onUserTurn?: (text: string) => void
  /**
   * Called to send the user's transcribed text into the conversation.
   * Implementation owns the chat pipeline (provider routing, streaming,
   * TTS) — the controller only handles audio. Returns a promise that
   * resolves when the assistant's reply has FULLY finished streaming
   * AND speaking, so the controller knows when to reopen the mic.
   */
  sendTurn: (text: string) => Promise<void>
  /** Called on fatal error so the UI can surface a toast. */
  onError?: (message: string) => void
}

/* --------------------------- controller -------------------------------- */

export class ConversationController {
  private state: ConversationState = 'idle'
  private readonly opts: ConversationOptions

  private mediaStream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private analyserSource: MediaStreamAudioSourceNode | null = null
  // TS's stricter typings narrow getFloatTimeDomainData's parameter to
  // Float32Array<ArrayBuffer>. The explicit generic anchors that here
  // so a future `new Float32Array(SharedArrayBuffer)` regression — and
  // the silent runtime crash that would cause — gets caught at build.
  private analyserBuf: Float32Array<ArrayBuffer> | null = null

  private recorder: MediaRecorder | null = null
  private recorderChunks: Blob[] = []

  private vadTimer: number | null = null
  /** Performance.now() at which we last heard voice during the current
   *  listening segment. 0 means "no voice yet this segment". */
  private voiceFirstHeardAt = 0
  /** Performance.now() at which the current silence run started. 0 means
   *  "we're hearing voice right now (or haven't sampled yet)". */
  private silenceStartedAt = 0
  /** Performance.now() at which the current listening segment began —
   *  drives the MAX_UTTERANCE_MS hard cap. */
  private listenStartedAt = 0
  /** Performance.now() at which the current barge-in run started. 0
   *  means "no sustained barge-in candidate right now". */
  private bargeStartedAt = 0

  /** Tracks the most recently observed speaker substate so we can
   *  flip from speaking → listening on the speaker-idle transition. */
  private unsubscribeSpeaker: (() => void) | null = null

  /** Snapshot used to drop stale awaits when stop() races with an
   *  in-flight transcribe or chat completion. Bumped on every stop()
   *  and every state transition out of transcribing / thinking. */
  private generation = 0

  constructor(opts: ConversationOptions) {
    this.opts = opts
  }

  getState(): ConversationState {
    return this.state
  }

  /**
   * Start the conversation. Opens the mic, primes the audio graph, and
   * enters 'listening'. Safe to call when already running — second call
   * is a no-op so the toggle button can be wired through unconditionally.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') return
    try {
      // v2.0 — `echoCancellation: true` is what makes barge-in detection
      // viable. Without it the mic would hear our own TTS playback at
      // full strength and constantly false-trigger the barge-in path.
      // `noiseSuppression` + `autoGainControl` match voiceInput.ts so
      // the two transcript paths feel identical.
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch (err) {
      this.opts.onError?.(
        `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    try {
      this.audioCtx = new AudioContext()
      this.analyserSource = this.audioCtx.createMediaStreamSource(this.mediaStream)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyserBuf = new Float32Array(this.analyser.fftSize)
      this.analyserSource.connect(this.analyser)
    } catch (err) {
      this.opts.onError?.(
        `Audio graph init failed: ${err instanceof Error ? err.message : String(err)}`
      )
      void this.releaseStream()
      return
    }

    // Watch the speaker subsystem to drive two transitions:
    //   thinking → speaking  : as soon as Piper queues the first chunk
    //                          (warming or actively playing). This is
    //                          what unblocks the barge-in detector — we
    //                          can't listen for interruption until the
    //                          state machine knows speech is in flight.
    //   speaking → listening : when the TTS queue fully drains. That's
    //                          the natural-end-of-reply signal and what
    //                          re-arms the mic for the next user turn.
    //
    // v2.0 polish — the source state for "speech started" is `thinking`
    // ONLY. A stale Piper synth from a prior Read Aloud (e.g., the user
    // tapped a bubble's speaker button just before entering conv mode)
    // would otherwise jump us from `listening` to `speaking` against
    // audio that isn't our reply — barge-in detection would then mute
    // the user's own bubble playback. The legitimate "speech started"
    // path always comes from a sendTurn we just kicked off, which is
    // exactly the `thinking` state.
    this.unsubscribeSpeaker = subscribeSpeakerState((next) => {
      if (this.state === 'thinking' && (next === 'warming' || next === 'speaking')) {
        this.enterSpeaking()
      } else if (this.state === 'speaking' && next === 'idle') {
        this.enterListening()
      }
    })

    this.beginRecorder()
    this.enterListening()
  }

  /**
   * Stop the conversation, release the mic, tear down the audio graph.
   * Safe to call from any state — a no-op when already idle. Any
   * in-flight transcribe or chat-completion result will be dropped
   * via the generation snapshot.
   */
  stop(): void {
    if (this.state === 'idle') return
    // v2.0 polish — flip state + unsubscribe FIRST. Doing this before
    // stopSpeaking() means the speaker callback (which fires synchronously
    // on stopSpeaking → 'idle') can't sneak in and re-trigger
    // enterListening() against a controller we've just torn down. It
    // also gives UI subscribers a clean 'idle' edge BEFORE any visible
    // mid-teardown jitter ('speaking' → 'idle' rather than via an
    // intermediate state).
    this.generation++
    this.unsubscribeSpeaker?.()
    this.unsubscribeSpeaker = null
    this.setState('idle')
    // Pull the plug on any speech that's still playing — exiting a
    // conversation should be silent, not "and one last sentence finishes
    // a second after you tapped exit". Safe to call after we cleared
    // the subscription above.
    stopSpeaking()
    this.stopVadTimer()
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      try {
        this.recorder.stop()
      } catch {
        /* already stopped */
      }
    }
    this.recorder = null
    this.recorderChunks = []
    // Tear down the analyser graph before releasing the stream so the
    // AudioContext doesn't sit hot with a dead source.
    if (this.analyserSource) {
      try {
        this.analyserSource.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.analyserSource = null
    this.analyser = null
    this.analyserBuf = null
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      // v2.0 polish — close() is async. We deliberately don't await it
      // (stop() needs to be sync) but nulling the ref BEFORE close
      // resolves is fine because no other code path reads it post-stop.
      // Chromium caps simultaneous AudioContexts at 6; a rapid
      // toggle-off-toggle-on burst could otherwise blow the cap.
      const ctx = this.audioCtx
      void ctx.close().catch(() => {
        /* best-effort */
      })
    }
    this.audioCtx = null
    this.releaseStream()
  }

  /* ----------------------- state transitions -------------------------- */

  private setState(next: ConversationState): void {
    if (this.state === next) return
    this.state = next
    this.opts.onState?.(next)
  }

  /**
   * Enter the listening state.
   *
   * @param opts.fromBargeIn  Default false. When true (the barge-in
   *   transition called this path), we KEEP the recorder chunks that
   *   accumulated during 'speaking' — those contain the first ~200 ms
   *   of the user's interrupting phoneme that the barge-in detector
   *   needed to confirm the interrupt. Dropping them (the default for
   *   a clean post-reply transition) would force the user to repeat
   *   themselves; keeping them captures the syllable they already said.
   */
  private enterListening(opts: { fromBargeIn?: boolean } = {}): void {
    this.setState('listening')
    this.voiceFirstHeardAt = 0
    this.silenceStartedAt = 0
    this.listenStartedAt = performance.now()
    this.bargeStartedAt = 0
    // Drop accumulated chunks ONLY on a clean post-reply transition;
    // see opts.fromBargeIn above for why we preserve them on barge-in.
    // Clean transitions still need the drop because chunks from the
    // speaking phase are a mix of TTS bleed + ambient that would
    // confuse Whisper if it leaked into the next transcribed turn.
    if (!opts.fromBargeIn) {
      this.recorderChunks = []
    } else if (this.voiceFirstHeardAt === 0 && this.recorderChunks.length > 0) {
      // We kept chunks across the barge-in entry — seed `voiceFirstHeardAt`
      // so the endpoint detector knows we already heard voice this segment
      // and doesn't auto-exit the session before the user finishes their
      // interrupting sentence.
      this.voiceFirstHeardAt = performance.now()
    }
    if (this.recorder && this.recorder.state === 'inactive') {
      try {
        this.recorder.start()
      } catch (err) {
        this.opts.onError?.(
          `Couldn't start recording: ${err instanceof Error ? err.message : String(err)}`
        )
        this.stop()
        return
      }
    }
    this.startVadTimer()
  }

  /**
   * Transition into 'speaking' — TTS is in flight. The VAD timer keeps
   * running so the barge-in detector can react. The recorder stays
   * armed (capturing the user's voice the moment they interrupt) so
   * the first syllable of a barge-in is preserved for the next
   * Whisper pass.
   */
  private enterSpeaking(): void {
    this.setState('speaking')
    this.bargeStartedAt = 0
    // VAD ticker started on listening entry — keep it running so we
    // can sample mic energy during playback. If it's somehow stopped
    // (defensive — shouldn't happen normally), bring it back.
    if (this.vadTimer === null) this.startVadTimer()
    // v2.0 polish — verify the recorder is actually capturing. After a
    // transcribing→thinking transition, harvestRecorderBlob() called
    // beginRecorder() to cycle a fresh recorder. If that threw silently
    // (constructor failure on some Chromium builds when the system
    // runs out of media nodes), we'd enter 'speaking' with no active
    // recorder and a barge-in would have nothing to transcribe. Re-arm
    // here as a defence — beginRecorder no-ops if the stream is gone.
    if (!this.recorder || this.recorder.state !== 'recording') {
      this.beginRecorder()
    }
  }

  /**
   * Endpoint reached — stop the recorder, decode + transcribe, and on
   * success hand the text to the parent for the chat-store roundtrip.
   * The generation check at every await boundary protects against a
   * stop() that races with the in-flight Promise chain.
   */
  private async finishUtterance(): Promise<void> {
    if (this.state !== 'listening' || !this.recorder) return
    this.stopVadTimer()
    this.setState('transcribing')
    const myGen = this.generation
    const stillCurrent = (): boolean => myGen === this.generation

    const blob = await this.harvestRecorderBlob()
    if (!stillCurrent()) return
    if (!blob || blob.size === 0) {
      // No audio captured (mic glitch, super-short tap) — drop quietly
      // and re-arm listening rather than bouncing the user out.
      this.enterListening()
      return
    }

    let clip: { pcm: Float32Array; sampleRate: number }
    try {
      clip = await decodeBlobToPcm(blob)
    } catch (err) {
      if (!stillCurrent()) return
      this.opts.onError?.(
        `Couldn't decode recorded audio: ${err instanceof Error ? err.message : String(err)}`
      )
      this.enterListening()
      return
    }

    let transcript = ''
    try {
      const result = await vs.ai.transcribe(clip)
      if (!stillCurrent()) return
      if (result.error) {
        this.opts.onError?.(`Transcription failed — ${result.error}`)
        this.enterListening()
        return
      }
      transcript = result.text.trim()
    } catch (err) {
      if (!stillCurrent()) return
      this.opts.onError?.(
        `Transcription failed — ${err instanceof Error ? err.message : String(err)}`
      )
      this.enterListening()
      return
    }

    if (transcript.length < 2) {
      // Empty / too-short transcript — silently re-arm rather than
      // spamming the chat with garbage turns.
      this.enterListening()
      return
    }

    this.opts.onUserTurn?.(transcript)
    this.setState('thinking')
    try {
      await this.opts.sendTurn(transcript)
      if (!stillCurrent()) return
      // sendTurn resolves when the streaming reply has fully arrived
      // text-wise. TTS may still be playing — the speaker-state
      // subscription handles the speaking → listening transition in
      // that case. We only manually re-arm when voice was disabled
      // (no speaker transition will ever fire) AND we haven't already
      // been transitioned elsewhere. The `state !== 'idle'` check is
      // critical for the case where stop() races the resolve — without
      // it we'd re-acquire the mic the user just released.
      //
      // The `as ConversationState` reads are because TS narrows
      // this.state to 'thinking' (the last setState call before the
      // await) and can't see across the await that the speaker
      // subscription or stop() may have moved it.
      const post = this.state as ConversationState
      if (post === 'thinking') this.enterListening()
    } catch (err) {
      // Same stop()-races-resolve concern as the success path: if
      // stillCurrent() is false the state already moved on; don't
      // toast the error against a dead controller, and don't reach
      // for enterListening on a torn-down audio graph.
      if (!stillCurrent()) return
      this.opts.onError?.(`Chat failed — ${err instanceof Error ? err.message : String(err)}`)
      const post = this.state as ConversationState
      if (post !== 'idle') this.enterListening()
    }
  }

  /* ------------------------- audio plumbing --------------------------- */

  private beginRecorder(): void {
    if (!this.mediaStream) return
    this.recorder = new MediaRecorder(this.mediaStream, { mimeType: pickMimeType() })
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.recorderChunks.push(event.data)
    }
    try {
      this.recorder.start()
    } catch (err) {
      this.opts.onError?.(
        `Recorder start failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.stop()
    }
  }

  /**
   * Stop the recorder and return the captured blob. We KEEP the
   * MediaStream alive (mic stays warm), only the recorder cycles.
   *
   * v2.0 polish — generation snapshot. If `stop()` runs between us
   * calling `recorder.stop()` and the async `onstop` firing, the
   * captured callback would otherwise run `beginRecorder()` against
   * a stream whose tracks have already been released → MediaRecorder
   * constructor throws and bubbles up to an unhandled rejection.
   * Guarding the recycle path on the generation lets the harvested
   * blob still resolve (the awaiting finishUtterance also drops it
   * via its own stillCurrent() check) without trying to spin up
   * audio resources on a torn-down controller.
   */
  private async harvestRecorderBlob(): Promise<Blob | null> {
    if (!this.recorder) return null
    const myGen = this.generation
    if (this.recorder.state === 'inactive') {
      const blob = new Blob(this.recorderChunks, { type: this.recorder.mimeType })
      this.recorderChunks = []
      if (myGen === this.generation) this.beginRecorder()
      return blob
    }
    return new Promise<Blob | null>((resolve) => {
      const active = this.recorder
      if (!active) {
        resolve(null)
        return
      }
      active.onstop = () => {
        const blob = new Blob(this.recorderChunks, { type: active.mimeType })
        this.recorderChunks = []
        if (myGen === this.generation) this.beginRecorder()
        resolve(blob)
      }
      try {
        active.stop()
      } catch {
        resolve(null)
      }
    })
  }

  private releaseStream(): void {
    if (!this.mediaStream) return
    this.mediaStream.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch {
        /* ignore */
      }
    })
    this.mediaStream = null
  }

  /* ------------------------------ VAD --------------------------------- */

  private startVadTimer(): void {
    this.stopVadTimer()
    this.vadTimer = window.setInterval(() => this.tickVad(), VAD_TICK_MS)
  }

  private stopVadTimer(): void {
    if (this.vadTimer !== null) {
      clearInterval(this.vadTimer)
      this.vadTimer = null
    }
  }

  private tickVad(): void {
    if (!this.analyser || !this.analyserBuf) return
    this.analyser.getFloatTimeDomainData(this.analyserBuf)
    let sumSq = 0
    for (let i = 0; i < this.analyserBuf.length; i++) {
      const sample = this.analyserBuf[i]
      sumSq += sample * sample
    }
    const rms = Math.sqrt(sumSq / this.analyserBuf.length)
    const now = performance.now()

    if (this.state === 'listening') {
      this.tickListening(rms, now)
    } else if (this.state === 'speaking') {
      this.tickSpeaking(rms, now)
    }
    // 'transcribing' / 'thinking' / 'idle' — VAD timer SHOULD be stopped
    // before we enter those, but a stale tick is harmless thanks to the
    // explicit state guards above.
  }

  private tickListening(rms: number, now: number): void {
    if (rms > LISTEN_VOICE_RMS) {
      if (this.voiceFirstHeardAt === 0) this.voiceFirstHeardAt = now
      this.silenceStartedAt = 0
      return
    }
    // Silence frame.
    if (this.silenceStartedAt === 0) this.silenceStartedAt = now
    const silenceFor = now - this.silenceStartedAt
    const sessionFor = now - this.listenStartedAt

    // Natural endpoint — voice happened, then quiet for ENDPOINT_SILENCE_MS.
    if (this.voiceFirstHeardAt > 0 && silenceFor >= ENDPOINT_SILENCE_MS) {
      void this.finishUtterance()
      return
    }
    // Hard utterance cap — user kept talking past MAX_UTTERANCE_MS.
    // Treat it as an endpoint to keep transcribe latency bounded.
    if (sessionFor >= MAX_UTTERANCE_MS) {
      void this.finishUtterance()
      return
    }
    // Auto-exit — extended silence with no voice ever this segment.
    if (this.voiceFirstHeardAt === 0 && sessionFor >= AUTO_EXIT_SILENCE_MS) {
      this.stop()
    }
  }

  private tickSpeaking(rms: number, now: number): void {
    if (rms <= BARGE_IN_RMS) {
      this.bargeStartedAt = 0
      return
    }
    if (this.bargeStartedAt === 0) {
      this.bargeStartedAt = now
      return
    }
    if (now - this.bargeStartedAt >= BARGE_IN_HOLD_MS) {
      // Confirmed barge-in. Cut the assistant off mid-sentence and re-arm
      // listening with `fromBargeIn: true` so the recorder chunks already
      // captured (the first ~200 ms of the user's interrupting phoneme)
      // are PRESERVED for the next Whisper pass. Dropping them would
      // force the user to repeat themselves once they realised they had
      // been heard.
      stopSpeaking()
      this.bargeStartedAt = 0
      this.enterListening({ fromBargeIn: true })
    }
  }
}

/* ------------------------ shared helpers ------------------------------- */

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return 'audio/webm'
}

/**
 * Decodes a webm/opus blob into mono PCM at TARGET_SAMPLE_RATE — exact
 * mirror of `voiceInput.ts`'s decodeBlobToPcm so both paths produce the
 * same wire shape and Whisper sees a single consistent format. Pulled
 * here rather than imported because the single-shot voice-input module
 * doesn't export it.
 */
async function decodeBlobToPcm(blob: Blob): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const buffer = await blob.arrayBuffer()
  const decodeCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(buffer)
  } finally {
    void decodeCtx.close()
  }
  const targetLength = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE))
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE)
  const source = offlineCtx.createBufferSource()
  source.buffer = decoded
  source.connect(offlineCtx.destination)
  source.start(0)
  const rendered = await offlineCtx.startRendering()
  return { pcm: rendered.getChannelData(0).slice(), sampleRate: TARGET_SAMPLE_RATE }
}
