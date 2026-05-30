#!/usr/bin/env node
/**
 * Fetches the official BIP-0039 English wordlist (2048 words) from the
 * canonical bitcoin/bips repository and writes it to
 * `src/main/services/sync/wordlist.ts` as a frozen string array.
 *
 * Run once at sync-feature setup time; rerun if the wordlist ever moves
 * (it's been stable since 2013 — extremely unlikely). The generated file
 * is committed to the repo so end users don't fetch on install.
 *
 * Usage:  node scripts/generate-bip39-wordlist.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SOURCE_URL = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt'
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'main',
  'services',
  'sync',
  'wordlist.ts'
)

const response = await fetch(SOURCE_URL)
if (!response.ok) {
  console.error(`Failed to fetch wordlist: HTTP ${response.status}`)
  process.exit(1)
}
const raw = await response.text()
const words = raw
  .split('\n')
  .map((w) => w.trim())
  .filter((w) => w.length > 0)

if (words.length !== 2048) {
  console.error(`Expected 2048 words, got ${words.length}.`)
  process.exit(1)
}

const header =
  `/**\n` +
  ` * Official BIP-0039 English wordlist (2048 words). Used to render and\n` +
  ` * validate the 24-word recovery phrase that doubles as the sync\n` +
  ` * encryption-key seed.\n` +
  ` *\n` +
  ` * Generated from ${SOURCE_URL}\n` +
  ` * by scripts/generate-bip39-wordlist.mjs — do not hand-edit. Rerun the\n` +
  ` * script if a newer wordlist ever ships (extremely unlikely; stable\n` +
  ` * since 2013).\n` +
  ` */\n` +
  `// eslint-disable-next-line prettier/prettier\n` +
  `export const BIP39_ENGLISH: readonly string[] = Object.freeze([\n`

const body = words.map((w) => `  '${w}'`).join(',\n')
const footer = `\n])\n`

writeFileSync(OUT_PATH, header + body + footer, 'utf-8')
console.log(`Wrote ${words.length} words to ${OUT_PATH}`)
