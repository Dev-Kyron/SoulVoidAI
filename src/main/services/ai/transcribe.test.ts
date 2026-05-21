import { describe, expect, it } from 'vitest'
import { pcmFloat32ToWav } from './transcribe'

describe('PCM → WAV encoding (for cloud STT upload)', () => {
  it('writes a valid RIFF/WAVE header with the right field values', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1])
    const wav = pcmFloat32ToWav(pcm, 16000)

    // Header magic strings
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')

    // PCM format = 1, mono = 1ch, 16kHz, 16-bit
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(34)).toBe(16)
    // Byte rate = sampleRate * blockAlign = 16000 * 2
    expect(wav.readUInt32LE(28)).toBe(32000)
    // Block align = channels * bytes/sample = 1 * 2
    expect(wav.readUInt16LE(32)).toBe(2)

    // Data chunk: 5 samples × 2 bytes = 10
    expect(wav.readUInt32LE(40)).toBe(10)
    expect(wav.length).toBe(44 + 10)
  })

  it('clamps out-of-range samples and uses asymmetric Int16 scaling', () => {
    // 1.0 should map to +32767 (0x7fff); -1.0 should map to -32768 (0x8000).
    const pcm = new Float32Array([1, -1, 2, -2, 0])
    const wav = pcmFloat32ToWav(pcm, 16000)
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, 5)
    expect(samples[0]).toBe(32767)
    expect(samples[1]).toBe(-32768)
    expect(samples[2]).toBe(32767) // clamped from 2
    expect(samples[3]).toBe(-32768) // clamped from -2
    expect(samples[4]).toBe(0)
  })

  it('handles empty input cleanly', () => {
    const wav = pcmFloat32ToWav(new Float32Array(0), 16000)
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
  })

  it('respects non-default sample rates in the header', () => {
    // 44.1k input would change the byte-rate / sample-rate header fields —
    // verify the encoder doesn't hardcode 16000 anywhere.
    const wav = pcmFloat32ToWav(new Float32Array(10), 44100)
    expect(wav.readUInt32LE(24)).toBe(44100)
    expect(wav.readUInt32LE(28)).toBe(88200)
  })
})
