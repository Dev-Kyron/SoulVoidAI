#!/usr/bin/env node
/**
 * v1.12.0 — sign the curated MCP registry.
 *
 * Reads mcp-registry/registry.json verbatim, computes its SHA-256,
 * signs the hash bytes with the Ed25519 private key at
 * mcp-registry/.private-key.b64 (gitignored), writes the result to
 * mcp-registry/signature.json. The app reads both files and verifies
 * the signature against the bundled public key on every fetch.
 *
 * Run after editing registry.json:
 *   node scripts/sign-mcp-registry.mjs
 *
 * Rotating the keypair (if the private key leaks, or as routine hygiene):
 *   node -e "const c=require('crypto'); const k=c.generateKeyPairSync('ed25519'); \
 *     require('fs').writeFileSync('mcp-registry/.private-key.b64', \
 *     k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64')); \
 *     console.log('NEW_PUBLIC_KEY_BASE64:', \
 *     k.publicKey.export({type:'spki',format:'der'}).toString('base64'));"
 * — then paste the new public key into src/main/services/setup/registry-signing.ts
 *   and re-run this script.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { resolve } from 'node:path'

const REGISTRY_PATH = resolve('mcp-registry/registry.json')
const SIGNATURE_PATH = resolve('mcp-registry/signature.json')
const PRIVATE_KEY_PATH = resolve('mcp-registry/.private-key.b64')

if (!existsSync(PRIVATE_KEY_PATH)) {
  console.error(
    `[sign-mcp-registry] Private key not found at ${PRIVATE_KEY_PATH}.\n` +
      'Generate one with the rotation snippet in this file\'s header docs,\n' +
      'or restore the existing key from your password manager.'
  )
  process.exit(1)
}

if (!existsSync(REGISTRY_PATH)) {
  console.error(`[sign-mcp-registry] Registry not found at ${REGISTRY_PATH}.`)
  process.exit(1)
}

const registryText = readFileSync(REGISTRY_PATH, 'utf-8')
const hashHex = createHash('sha256').update(registryText, 'utf8').digest('hex')
const hashBytes = Buffer.from(hashHex, 'hex')

const privateKeyB64 = readFileSync(PRIVATE_KEY_PATH, 'utf-8').trim()
const privateKey = createPrivateKey({
  key: Buffer.from(privateKeyB64, 'base64'),
  format: 'der',
  type: 'pkcs8'
})

// Ed25519 signs the bytes directly (no separate hash algorithm —
// it\'s baked into the curve). Pass `null` for the algorithm slot.
const signatureBytes = cryptoSign(null, hashBytes, privateKey)

const sigFile = {
  version: 1,
  algorithm: 'ed25519',
  registrySha256: hashHex,
  signature: signatureBytes.toString('base64'),
  signedAt: new Date().toISOString()
}

writeFileSync(SIGNATURE_PATH, JSON.stringify(sigFile, null, 2) + '\n')
console.log(`[sign-mcp-registry] Signed ${REGISTRY_PATH}`)
console.log(`  SHA-256: ${hashHex}`)
console.log(`  Wrote:   ${SIGNATURE_PATH}`)
