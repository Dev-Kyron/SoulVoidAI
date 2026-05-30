/**
 * Sync crypto primitives.
 *
 * No external deps — all primitives come from Node's `crypto` builtin:
 *   - `scrypt` for password-based key derivation (well-tuned defaults
 *     below approximate Argon2id's hardness on modern hardware without
 *     pulling a native binding through electron-builder).
 *   - `aes-256-gcm` for AEAD: 256-bit key, 96-bit nonce, 128-bit auth
 *     tag. The nonce is random per chunk (`randomBytes(12)`) — we never
 *     reuse a nonce under the same key, which is the GCM security
 *     requirement.
 *   - `randomBytes` for mnemonic entropy.
 *
 * BIP-39 mnemonics: 24 words encode 256 bits of entropy + 8-bit checksum
 * (264 / 11 = 24). Same scheme crypto wallets use, so a user who already
 * knows what a seed phrase is doesn't need to learn anything new.
 *
 * Security model: the recovery phrase IS the secret. It's typed by the
 * user during pairing and stored only on this device's local keychain
 * (via the existing `secrets:set` IPC). The sync folder contains nothing
 * a passive cloud-storage operator can read — every chunk is
 * AEAD-sealed under a key the cloud never sees.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { BIP39_ENGLISH } from './wordlist'

const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: {
    N?: number
    r?: number
    p?: number
    maxmem?: number
  }
) => Promise<Buffer>

/** Bytes used by the scrypt KDF. ~64 MB of memory is reasonable for an
 *  Electron main process and meaningful against off-the-shelf GPU
 *  cracking of the recovery phrase. */
const SCRYPT_N = 1 << 16 // 65536
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32 // 256-bit AES key
const SCRYPT_MAXMEM = 128 * 1024 * 1024 // 128 MB, headroom over N*r*p*128

const GCM_NONCE_LEN = 12
const GCM_TAG_LEN = 16

/** 24-word mnemonic = 256 bits entropy + 8-bit checksum = 264 bits. */
const MNEMONIC_ENTROPY_BYTES = 32
const MNEMONIC_WORDS = 24

/**
 * Generates a fresh 24-word BIP-39 mnemonic from 256 bits of CSPRNG
 * entropy. Returned as a single string of words separated by single
 * spaces — matches how every other BIP-39 wallet displays it, and is
 * what `validateMnemonic` accepts.
 */
export function generateMnemonic(): string {
  const entropy = randomBytes(MNEMONIC_ENTROPY_BYTES)
  return entropyToMnemonic(entropy)
}

/**
 * Validates a mnemonic against the BIP-39 spec:
 *   - exactly 24 words
 *   - each word in the official English list
 *   - 8-bit checksum matches SHA256(entropy)[0]
 *
 * Returns the recovered 32-byte entropy on success, `null` on any
 * failure. The Settings UI uses the boolean result to gate the "Pair"
 * button; the engine uses the bytes to derive the encryption key.
 */
export function validateMnemonic(input: string): Uint8Array | null {
  const words = normaliseMnemonic(input)
  if (words.length !== MNEMONIC_WORDS) return null
  const indices: number[] = []
  for (const w of words) {
    const i = BIP39_ENGLISH.indexOf(w)
    if (i < 0) return null
    indices.push(i)
  }
  // 24 words × 11 bits = 264 bits = 33 bytes (32 entropy + 1 checksum).
  const bits = new Uint8Array(33)
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    for (let b = 0; b < 11; b++) {
      const bitPos = i * 11 + b
      const bit = (idx >> (10 - b)) & 1
      if (bit) bits[bitPos >> 3] |= 1 << (7 - (bitPos & 7))
    }
  }
  const entropy = bits.slice(0, MNEMONIC_ENTROPY_BYTES)
  const checksum = bits[MNEMONIC_ENTROPY_BYTES]
  const expected = createHash('sha256').update(entropy).digest()[0]
  if (checksum !== expected) return null
  return entropy
}

/** Normalises a user-pasted mnemonic: lowercase, collapse whitespace,
 *  drop incidental punctuation. Returns the words array. */
export function normaliseMnemonic(input: string): string[] {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== MNEMONIC_ENTROPY_BYTES) {
    throw new Error(`Mnemonic entropy must be ${MNEMONIC_ENTROPY_BYTES} bytes`)
  }
  const checksum = createHash('sha256').update(entropy).digest()[0]
  const bits = new Uint8Array(33)
  bits.set(entropy)
  bits[MNEMONIC_ENTROPY_BYTES] = checksum
  const words: string[] = []
  for (let i = 0; i < MNEMONIC_WORDS; i++) {
    let idx = 0
    for (let b = 0; b < 11; b++) {
      const bitPos = i * 11 + b
      const bit = (bits[bitPos >> 3] >> (7 - (bitPos & 7))) & 1
      idx = (idx << 1) | bit
    }
    words.push(BIP39_ENGLISH[idx])
  }
  return words.join(' ')
}

/**
 * Derives the 32-byte AEAD key from mnemonic-entropy + a per-vault salt.
 * The salt lives in the sync folder's manifest.json (plaintext — it's
 * not secret; it just stops rainbow-table sharing between distinct
 * sync vaults with the same passphrase).
 *
 * v2.0 polish — async to keep the Electron main thread responsive
 * during boot-time engine init and pairing flows. The original
 * scryptSync froze the UI for 500-1000ms; the async variant moves
 * the work off the event loop and onto libuv's threadpool.
 */
export async function deriveKey(entropy: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return scryptAsync(Buffer.from(entropy), Buffer.from(salt), SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })
}

/** Fresh per-vault salt. Stored in manifest.json — anyone reading it
 *  learns nothing useful because the entropy is in the recovery phrase. */
export function newSalt(): Buffer {
  return randomBytes(16)
}

/**
 * Encrypts plaintext under a derived key. Output layout:
 *   [12-byte nonce][N-byte ciphertext][16-byte GCM auth tag]
 * Returned as a single Buffer ready for disk write.
 *
 * AAD is the record's stable identifier (`recordKey`) — binding the
 * ciphertext to its filename means an attacker can't rename a chunk on
 * disk to make device A apply device B's stale value (which would still
 * decrypt cleanly with just key + nonce + tag).
 */
export function seal(key: Buffer, recordKey: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(recordKey, 'utf-8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, body, tag])
}

/**
 * Inverse of `seal`. Returns the plaintext bytes on success, `null` on
 * any verification failure (tampered chunk, wrong key, wrong recordKey
 * binding). Engine callers treat null as "skip this chunk + log a
 * warning"; they never throw, because one bad file in the sync folder
 * shouldn't break the loop.
 */
export function unseal(key: Buffer, recordKey: string, blob: Buffer): Buffer | null {
  if (blob.length < GCM_NONCE_LEN + GCM_TAG_LEN) return null
  const nonce = blob.subarray(0, GCM_NONCE_LEN)
  const tag = blob.subarray(blob.length - GCM_TAG_LEN)
  const body = blob.subarray(GCM_NONCE_LEN, blob.length - GCM_TAG_LEN)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(Buffer.from(recordKey, 'utf-8'))
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return null
  }
}
