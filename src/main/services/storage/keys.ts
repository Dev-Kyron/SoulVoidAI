/**
 * Encrypted API-key vault. Keys are encrypted with the OS keychain via
 * Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) and never leave the main process. The renderer can only learn
 * *whether* a key exists, never its value.
 *
 * As a development convenience, keys may also be supplied through environment
 * variables; a stored key always takes precedence.
 */
import { safeStorage } from 'electron'
import { JsonStore } from './store'
import type { ProviderId } from '@shared/types'

interface KeyFile {
  keys: Partial<Record<ProviderId, string>>
  /** Non-AI integration secrets — Tavily, etc. Encrypted alongside keys. */
  secrets?: Partial<Record<string, string>>
}

let cached: JsonStore<KeyFile> | null = null
function store(): JsonStore<KeyFile> {
  if (!cached) cached = new JsonStore<KeyFile>('keys', { keys: {} })
  return cached
}

const ENV_VAR: Partial<Record<ProviderId, string>> = {
  openai: 'VOIDSOUL_OPENAI_API_KEY',
  anthropic: 'VOIDSOUL_ANTHROPIC_API_KEY',
  gemini: 'VOIDSOUL_GEMINI_API_KEY'
}

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }
  // Fallback when no OS keychain is available — obfuscation only.
  return `b64:${Buffer.from(plain, 'utf-8').toString('base64')}`
}

function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf-8')
  }
  return ''
}

export function setApiKey(provider: ProviderId, key: string): void {
  const keys = { ...store().get().keys }
  const trimmed = key.trim()
  if (trimmed) {
    keys[provider] = encrypt(trimmed)
  } else {
    delete keys[provider]
  }
  store().set({ keys })
}

export function getApiKey(provider: ProviderId): string | null {
  const stored = store().get().keys[provider]
  if (stored) {
    try {
      const value = decrypt(stored)
      if (value) return value
    } catch {
      // Encryption context changed (e.g. OS user changed) — ignore stale key.
    }
  }
  const envName = ENV_VAR[provider]
  if (envName && process.env[envName]) return process.env[envName] as string
  return null
}

export function hasApiKey(provider: ProviderId): boolean {
  return getApiKey(provider) !== null
}

/* ------------------------- non-provider secrets ------------------------ */

const SECRET_ENV: Record<string, string> = {
  tavily: 'VOIDSOUL_TAVILY_API_KEY',
  // Fall back to the env var the official GitHub MCP server uses, so a single
  // PAT can serve both that integration and our share-as-gist feature.
  github: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  // Stability AI for the alternate Stable Diffusion image-gen provider.
  stability: 'STABILITY_API_KEY',
  // Picovoice access key for the wake-word engine (free for personal use).
  picovoice: 'PICOVOICE_ACCESS_KEY'
}

export function setSecret(id: string, value: string): void {
  const secrets = { ...(store().get().secrets ?? {}) }
  const trimmed = value.trim()
  if (trimmed) {
    secrets[id] = encrypt(trimmed)
  } else {
    delete secrets[id]
  }
  store().set({ secrets })
}

export function getSecret(id: string): string | null {
  const stored = store().get().secrets?.[id]
  if (stored) {
    try {
      const value = decrypt(stored)
      if (value) return value
    } catch {
      // ignore stale encryption context
    }
  }
  const envName = SECRET_ENV[id]
  if (envName && process.env[envName]) return process.env[envName] as string
  return null
}

export function hasSecret(id: string): boolean {
  return getSecret(id) !== null
}
