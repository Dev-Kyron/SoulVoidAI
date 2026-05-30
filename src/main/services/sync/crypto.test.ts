/**
 * Unit tests for the sync crypto layer. Pinned BIP-39 test vectors come
 * from the canonical bitcoin/bips repo so any regression in the entropy
 * ↔ mnemonic encoding surfaces immediately (the bit-packing is the
 * spookiest part of this module — easy to off-by-one).
 */
import { describe, expect, it } from 'vitest'
import {
  deriveKey,
  generateMnemonic,
  newSalt,
  normaliseMnemonic,
  seal,
  unseal,
  validateMnemonic
} from './crypto'

const TEST_VECTOR_ENTROPY_HEX = '0000000000000000000000000000000000000000000000000000000000000000'
const TEST_VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon art'

describe('sync crypto — BIP-39 mnemonic', () => {
  it('matches the canonical all-zero test vector', () => {
    // Round-trip the well-known all-zero entropy through validateMnemonic
    // → the recovered entropy should match the input, AND the mnemonic
    // string the spec publishes should validate cleanly.
    const recovered = validateMnemonic(TEST_VECTOR_MNEMONIC)
    expect(recovered).not.toBeNull()
    expect(Buffer.from(recovered!).toString('hex')).toBe(TEST_VECTOR_ENTROPY_HEX)
  })

  it('rejects a tampered word (wrong checksum)', () => {
    // Swap the last word for another valid wordlist entry — different
    // entropy bits, checksum mismatches, must fail validation.
    const tampered = TEST_VECTOR_MNEMONIC.replace(/art$/, 'zoo')
    expect(validateMnemonic(tampered)).toBeNull()
  })

  it('rejects a non-wordlist word', () => {
    const broken = TEST_VECTOR_MNEMONIC.replace(/art$/, 'antelope')
    expect(validateMnemonic(broken)).toBeNull()
  })

  it('rejects the wrong number of words', () => {
    const short = TEST_VECTOR_MNEMONIC.split(' ').slice(0, 12).join(' ')
    expect(validateMnemonic(short)).toBeNull()
  })

  it('normalises whitespace + casing', () => {
    const noisy = `  ABANDON   abandon\nabandon\tabandon abandon abandon
abandon abandon abandon abandon abandon abandon abandon abandon abandon
abandon abandon abandon abandon abandon abandon abandon abandon ART  `
    expect(validateMnemonic(noisy)).not.toBeNull()
  })

  it('round-trips a freshly-generated mnemonic', () => {
    const m = generateMnemonic()
    expect(m.split(' ')).toHaveLength(24)
    expect(validateMnemonic(m)).not.toBeNull()
  })

  it('normaliseMnemonic strips punctuation', () => {
    expect(normaliseMnemonic('Hello, world!')).toEqual(['hello', 'world'])
  })
})

describe('sync crypto — AEAD seal/unseal', () => {
  it('round-trips through seal+unseal', async () => {
    const entropy = validateMnemonic(TEST_VECTOR_MNEMONIC)!
    const salt = newSalt()
    const key = await deriveKey(entropy, salt)
    const plaintext = Buffer.from('thread.abc-123: hello world 👋', 'utf-8')
    const blob = seal(key, 'thread.abc-123', plaintext)
    const recovered = unseal(key, 'thread.abc-123', blob)
    expect(recovered).not.toBeNull()
    expect(recovered!.toString('utf-8')).toBe(plaintext.toString('utf-8'))
  })

  it('rejects a chunk whose recordKey AAD was rewritten', async () => {
    // The recordKey binding is what stops an attacker (or buggy code)
    // from moving a stale `thread.A` blob over to `thread.B` and having
    // it decrypt as B's value.
    const entropy = validateMnemonic(TEST_VECTOR_MNEMONIC)!
    const salt = newSalt()
    const key = await deriveKey(entropy, salt)
    const blob = seal(key, 'thread.A', Buffer.from('A-plaintext'))
    expect(unseal(key, 'thread.B', blob)).toBeNull()
  })

  it('rejects a tampered ciphertext (auth-tag mismatch)', async () => {
    const entropy = validateMnemonic(TEST_VECTOR_MNEMONIC)!
    const salt = newSalt()
    const key = await deriveKey(entropy, salt)
    const blob = seal(key, 'k', Buffer.from('hello'))
    // Flip a byte deep inside the ciphertext body (skip nonce, stop
    // before tag) — GCM verification must fail.
    blob[14] ^= 0xff
    expect(unseal(key, 'k', blob)).toBeNull()
  })

  it('rejects a chunk produced under a different key', async () => {
    const entropyA = validateMnemonic(TEST_VECTOR_MNEMONIC)!
    const entropyB = validateMnemonic(generateMnemonic())!
    const salt = newSalt()
    const keyA = await deriveKey(entropyA, salt)
    const keyB = await deriveKey(entropyB, salt)
    const blob = seal(keyA, 'k', Buffer.from('secret'))
    expect(unseal(keyB, 'k', blob)).toBeNull()
  })
})
