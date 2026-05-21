/**
 * Speech-to-text router. Takes 16kHz mono PCM from the renderer and routes to
 * the best available backend:
 *
 *   1. OpenAI Whisper API — if an OpenAI key is configured (highest quality).
 *   2. Gemini 2.0 Flash — if a Gemini key is configured.
 *   3. Local Whisper-tiny.en via the RAG worker — keyless fallback, runs on
 *      the user's CPU. First call downloads ~75 MB; subsequent calls are local
 *      and offline. This is the new free default — voice input "just works"
 *      out of the box.
 */
import { getApiKey } from '../storage/keys'
import { resolveBaseUrl } from '../storage/config'
import { ProviderError } from './types'
import { httpError } from './stream'
import { transcribeAudioViaWorker } from '../rag-worker'

/**
 * Wraps a Float32Array of audio samples into a 16-bit PCM WAV buffer suitable
 * for upload to the OpenAI / Gemini transcription APIs. WAV is the simplest
 * universal container — just a 44-byte header on top of the sample bytes.
 *
 * Exported so the unit test imports the real encoder rather than maintaining
 * a parallel copy that would silently drift if the production version
 * changed (e.g., gain staging tweaks, header alignment fixes).
 */
export function pcmFloat32ToWav(pcm: Float32Array, sampleRate: number): Buffer {
  // Float32 [-1, 1] → Int16. Asymmetric scaling matches the standard PCM
  // convention so silence stays bit-exact and positive peaks reach +32767.
  const samples = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]))
    samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 44)
  return buf
}

async function transcribeWithWhisper(wav: Buffer, apiKey: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', 'whisper-1')
  const res = await fetch(`${resolveBaseUrl('openai')}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) throw await httpError(res, 'Whisper')
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}

async function transcribeWithGemini(wav: Buffer, apiKey: string): Promise<string> {
  const base64 = wav.toString('base64')
  const res = await fetch(
    `${resolveBaseUrl('gemini')}/v1beta/models/gemini-2.0-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: 'audio/wav', data: base64 } },
              {
                text:
                  'Transcribe this audio recording exactly. Respond with only the transcription ' +
                  'text — no preamble, no quotation marks.'
              }
            ]
          }
        ]
      })
    }
  )
  if (!res.ok) throw await httpError(res, 'Gemini')
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()
}

export interface TranscribeRequest {
  pcm: Float32Array
  sampleRate: number
}

/**
 * Picks a backend and runs transcription. Falls through to local Whisper if
 * no cloud keys are configured — so voice input always works, no setup.
 */
export async function transcribeAudio(audio: TranscribeRequest): Promise<string> {
  if (audio.pcm.length === 0) return ''

  const openaiKey = getApiKey('openai')
  if (openaiKey) {
    return transcribeWithWhisper(pcmFloat32ToWav(audio.pcm, audio.sampleRate), openaiKey)
  }
  const geminiKey = getApiKey('gemini')
  if (geminiKey) {
    return transcribeWithGemini(pcmFloat32ToWav(audio.pcm, audio.sampleRate), geminiKey)
  }
  // No cloud keys → local Whisper. The worker will lazy-load the ~75 MB model
  // on first call; the renderer's orb is already in "processing" state so
  // the wait is visible. We don't surface a separate "downloading model"
  // event here — first-call latency is the closest natural signal.
  try {
    const result = await transcribeAudioViaWorker(audio)
    return result.text
  } catch (err) {
    // Surface a clearer hint than the raw worker error if it's a network /
    // permission issue downloading the model.
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderError(
      `Local speech-to-text failed: ${message}. ` +
        'First use needs ~75 MB to download — add an OpenAI or Gemini key as an alternative.'
    )
  }
}
