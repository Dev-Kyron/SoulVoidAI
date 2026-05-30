/**
 * Local-state ↔ sync-record translators.
 *
 * Each "record" is one logical unit of syncable state. We picked unit
 * sizes pragmatically:
 *
 *   - `thread:<id>` — one record per chat thread (messages + summary +
 *     pinned + per-thread mode/prompt overrides + project link).
 *     Threads are append-mostly so per-thread granularity means a chat
 *     on device A doesn't conflict with a different chat on device B.
 *
 *   - `memory:facts` — single bundle of all UserFact rows. The set is
 *     small (capped at ~50) and mutation is rare, so per-fact records
 *     would be more overhead than they're worth.
 *
 *   - `memory:biographical` — single bundle of all BiographicalEntry
 *     rows. Same reasoning as facts.
 *
 *   - `config:global` — the user-facing slice of config: appearance,
 *     voice prefs, active mode/persona, system prompt, memory toggles,
 *     experimental flags. Excludes anything machine-local (sync folder,
 *     API keys, syncDeviceId, paths) so device A doesn't overwrite
 *     device B's `~/Documents/VoidSoul` with its `~/Library/...`.
 *
 * Conflict resolution is LWW per record by `modifiedAt`. Since we don't
 * have a per-row updatedAt for memory/config, we hash the serialised
 * payload and only mark a record as "modified" when the hash changes —
 * that gives us automatic dedup without instrumenting every mutation
 * site to bump a watermark.
 *
 * Delete propagation is OUT of scope for v1: deleting a thread on
 * device A leaves it intact on device B until manually removed there
 * too. Add tombstones in a follow-up.
 */
import { createHash } from 'node:crypto'
import { db } from '../storage/db'
import {
  getHistory,
  saveThread,
  setThreadPinned,
  setThreadMode,
  setThreadSystemPrompt,
  createThread
} from '../storage/history'
import { getMemory, replaceMemory } from '../storage/memory'
import { getConfig, updateConfig } from '../storage/config'
import { log } from '../logger'
import type {
  AppearanceConfig,
  BiographicalEntry,
  ChatMessage,
  ChatThread,
  HistorySummary,
  MemoryConfig,
  MemoryState,
  ModeId,
  UserFact,
  VoiceConfig
} from '@shared/types'

/**
 * Discriminator on every sync record. Used both for routing in the
 * apply path and as a prefix on the record-key so the same kind never
 * masks another (a thread whose UUID happens to start "memory:" can't
 * shadow the facts bundle).
 */
export type RecordKind = 'thread' | 'memory:facts' | 'memory:biographical' | 'config:global'

/**
 * Shape on the wire (after seal+unseal). `data` is a kind-specific
 * payload — see the per-kind helpers below for the concrete schemas.
 * Keep this loose-typed at the sync edge so a peer running a newer
 * record version doesn't crash our applier on an unknown field.
 */
export interface SyncRecord {
  schema: 1
  key: string
  kind: RecordKind
  modifiedAt: string
  deviceId: string
  data: unknown
}

/**
 * Snapshot of one local record ready for push: the serialised payload,
 * its content hash (used by the engine to detect "did this change since
 * last push?" without instrumenting every mutation site), and the kind
 * so the engine can attach a stable record-key prefix.
 */
export interface LocalSnapshotEntry {
  key: string
  kind: RecordKind
  hash: string
  data: unknown
}

/* ----------------------------- collect ----------------------------- */

/**
 * Collects every local record into a flat list. Called once per push
 * tick. Pure read — no mutation. Hashes are computed over the canonical
 * JSON.stringify of the payload so two devices with semantically-equal
 * state produce the same hash and the engine treats it as a no-op push.
 */
export function collectLocalSnapshot(): LocalSnapshotEntry[] {
  const out: LocalSnapshotEntry[] = []
  // Threads — one record per thread.
  const { threads } = getHistory()
  for (const t of threads) {
    const payload = threadPayload(t)
    out.push({
      key: `thread:${t.id}`,
      kind: 'thread',
      hash: hashOf(payload),
      data: payload
    })
  }
  // Memory.facts — single bundle.
  const memory = getMemory()
  const facts = memory.facts ?? []
  out.push({
    key: 'memory:facts',
    kind: 'memory:facts',
    hash: hashOf(facts),
    data: { facts }
  })
  // Memory.biographical — single bundle.
  const biographical = memory.biographical ?? []
  out.push({
    key: 'memory:biographical',
    kind: 'memory:biographical',
    hash: hashOf(biographical),
    data: { biographical }
  })
  // Config — global, user-facing slice only.
  const cfg = getConfig()
  const configPayload = pickSyncableConfig(cfg)
  out.push({
    key: 'config:global',
    kind: 'config:global',
    hash: hashOf(configPayload),
    data: configPayload
  })
  return out
}

/* ----------------------------- apply ------------------------------- */

/**
 * Apply a remote record to the local store.
 *
 * IMPORTANT: this overwrites the local copy for that record without
 * checking timestamps — the engine has already decided this record is
 * the LWW winner for its key. Returns true on success (or no-op), false
 * if the payload was malformed and we skipped it. We never throw — one
 * bad chunk shouldn't kill the sync loop.
 */
export function applyRemoteRecord(record: SyncRecord): boolean {
  try {
    switch (record.kind) {
      case 'thread':
        return applyThread(record)
      case 'memory:facts':
        return applyFacts(record)
      case 'memory:biographical':
        return applyBiographical(record)
      case 'config:global':
        return applyConfig(record)
      default:
        return false
    }
  } catch (err) {
    log(
      'warn',
      'system',
      `Sync apply threw for ${record.key}`,
      err instanceof Error ? err.message : String(err)
    )
    return false
  }
}

/* ----------------------------- threads ----------------------------- */

interface ThreadPayload {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned: boolean
  messages: ChatMessage[]
  summary: HistorySummary | null
  pinnedMode: ModeId | null
  pinnedSystemPrompt: string | null
  projectId: string | null
}

function threadPayload(t: ChatThread): ThreadPayload {
  // ChatThread leaves a lot of fields optional in the on-disk schema
  // (back-compat with v0.x exports); the wire payload normalises them
  // to a concrete shape so two devices with different vintages of the
  // type still hash to the same value when the data is equivalent.
  return {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    pinned: t.pinned ?? false,
    messages: t.messages,
    summary: t.summary ?? null,
    pinnedMode: t.pinnedMode ?? null,
    pinnedSystemPrompt: t.pinnedSystemPrompt ?? null,
    projectId: t.projectId ?? null
  }
}

function applyThread(record: SyncRecord): boolean {
  const payload = record.data as Partial<ThreadPayload> | null
  if (!payload || typeof payload !== 'object') return false
  const id = String(payload.id ?? '').trim()
  if (!id) return false
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  // saveThread does nothing if the thread row doesn't exist — for a
  // brand-new remote thread we create the row first (without flipping
  // active thread; the user might be mid-conversation locally).
  const existing = db().prepare(`SELECT id FROM threads WHERE id = ?`).get(id) as
    | { id: string }
    | undefined
  if (!existing) {
    // createThread allocates a fresh id; we want to use the REMOTE id
    // exactly so the next pull doesn't re-introduce it as a sibling.
    // Hand-INSERT the row instead, leaving the active thread alone.
    db()
      .prepare(
        `INSERT INTO threads
           (id, title, created_at, updated_at, pinned, summary,
            pinned_mode, pinned_system_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        typeof payload.title === 'string' ? payload.title : 'Synced chat',
        typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
        typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString(),
        payload.pinned ? 1 : 0,
        payload.summary ? JSON.stringify(payload.summary) : null,
        typeof payload.pinnedMode === 'string' ? payload.pinnedMode : null,
        typeof payload.pinnedSystemPrompt === 'string' ? payload.pinnedSystemPrompt : null
      )
  }
  // Per-thread mode/prompt + pinned aren't part of saveThread's contract
  // (see saveThread's comment) — set them through the dedicated setters.
  if (typeof payload.pinned === 'boolean') setThreadPinned(id, payload.pinned)
  setThreadMode(id, typeof payload.pinnedMode === 'string' ? (payload.pinnedMode as ModeId) : null)
  setThreadSystemPrompt(
    id,
    typeof payload.pinnedSystemPrompt === 'string' ? payload.pinnedSystemPrompt : null
  )
  // saveThread handles the messages + summary atomically (one tx).
  saveThread(id, messages, payload.summary ?? null)
  return true
}

// Re-export createThread so the engine can pull it in alongside the
// records module without two separate imports. Currently unused here
// directly — kept future-proof for the tombstone-aware variant.
export { createThread as _createThread }

/* ----------------------------- memory ------------------------------ */

function applyFacts(record: SyncRecord): boolean {
  const payload = record.data as { facts?: unknown } | null
  if (!payload || !Array.isArray(payload.facts)) return false
  const facts: UserFact[] = payload.facts
    .filter((f: unknown): f is UserFact => isUserFact(f))
    .slice(0, 200) // hard cap mirroring MAX_FACTS doubled — defensive
  const current = getMemory()
  replaceMemory({ ...current, facts })
  return true
}

function applyBiographical(record: SyncRecord): boolean {
  const payload = record.data as { biographical?: unknown } | null
  if (!payload || !Array.isArray(payload.biographical)) return false
  const biographical: BiographicalEntry[] = payload.biographical
    .filter((b: unknown): b is BiographicalEntry => isBiographical(b))
    .slice(0, 200)
  const current = getMemory()
  replaceMemory({ ...current, biographical })
  return true
}

function isUserFact(v: unknown): v is UserFact {
  if (!v || typeof v !== 'object') return false
  const f = v as Partial<UserFact>
  return typeof f.id === 'string' && typeof f.text === 'string'
}

function isBiographical(v: unknown): v is BiographicalEntry {
  if (!v || typeof v !== 'object') return false
  const b = v as Partial<BiographicalEntry>
  return typeof b.id === 'string' && typeof b.text === 'string' && typeof b.category === 'string'
}

/* ----------------------------- config ------------------------------ */

/**
 * Picks the subset of config that's safe + meaningful to sync across
 * devices. Explicit allowlist — we'd rather miss a sync field than
 * accidentally clobber a per-device setting like the sync folder
 * itself (which would cause device A to point at device B's path that
 * doesn't exist on A).
 *
 * Always excluded:
 *   - `syncFolder`, sync state, deviceId, salt — per-device by definition
 *   - API keys, secrets — never leave the OS keychain
 *   - providers[].baseUrl — points at machine-local LM Studio / Ollama
 *   - `seenModels` — provider's model list, machine-local cache
 */
/**
 * Allowlisted chat-config subset that syncs. Deliberately EXCLUDES
 * `chat.private` — that's a session-local intent ("I want this single
 * conversation off-record"), not a durable preference, and propagating
 * it would silently put the other device into private mode without
 * the user asking.
 */
interface SyncableChatConfig {
  agent: boolean
  autoMemory: boolean
  rag: boolean
  embeddingProvider: string
  autoRoute: boolean
}

interface SyncableConfig {
  appearance: AppearanceConfig
  voice: VoiceConfig
  memory: MemoryConfig
  chat: SyncableChatConfig
  activeMode: ModeId
  systemPrompt: string
}

function pickSyncableConfig(cfg: ReturnType<typeof getConfig>): SyncableConfig {
  return {
    appearance: cfg.appearance,
    voice: cfg.voice,
    memory: cfg.memory,
    chat: {
      agent: cfg.chat.agent,
      autoMemory: cfg.chat.autoMemory,
      rag: cfg.chat.rag,
      embeddingProvider: cfg.chat.embeddingProvider,
      autoRoute: cfg.chat.autoRoute
    },
    activeMode: cfg.activeMode,
    systemPrompt: cfg.systemPrompt
  }
}

function applyConfig(record: SyncRecord): boolean {
  const payload = record.data as Partial<SyncableConfig> | null
  if (!payload || typeof payload !== 'object') return false
  // Build the patch carefully — every field is optional so a future
  // device with a wider config schema can still publish records this
  // version understands, dropping unknown fields silently.
  const patch: Record<string, unknown> = {}
  const current = getConfig()
  if (payload.appearance && typeof payload.appearance === 'object') {
    patch.appearance = { ...current.appearance, ...payload.appearance }
  }
  if (payload.voice && typeof payload.voice === 'object') {
    patch.voice = { ...current.voice, ...payload.voice }
  }
  if (payload.memory && typeof payload.memory === 'object') {
    patch.memory = { ...current.memory, ...payload.memory }
  }
  if (payload.chat && typeof payload.chat === 'object') {
    // Carry over the existing chat config and only overwrite the
    // explicitly-listed durable flags. Critically, `private` is left
    // untouched — see the allowlist comment.
    const incoming = payload.chat as Partial<SyncableChatConfig>
    patch.chat = {
      ...current.chat,
      ...(typeof incoming.agent === 'boolean' ? { agent: incoming.agent } : {}),
      ...(typeof incoming.autoMemory === 'boolean' ? { autoMemory: incoming.autoMemory } : {}),
      ...(typeof incoming.rag === 'boolean' ? { rag: incoming.rag } : {}),
      ...(typeof incoming.embeddingProvider === 'string'
        ? { embeddingProvider: incoming.embeddingProvider }
        : {}),
      ...(typeof incoming.autoRoute === 'boolean' ? { autoRoute: incoming.autoRoute } : {})
    }
  }
  if (typeof payload.activeMode === 'string') patch.activeMode = payload.activeMode
  if (typeof payload.systemPrompt === 'string') patch.systemPrompt = payload.systemPrompt
  updateConfig(patch)
  return true
}

/* ----------------------------- helpers ----------------------------- */

/** Deterministic hash over the canonical JSON of a payload. Two devices
 *  with the same logical state produce the same hash so the engine
 *  doesn't write redundant push chunks every tick. */
function hashOf(value: unknown): string {
  const json = JSON.stringify(value, sortedKeys)
  return createHash('sha256').update(json).digest('hex')
}

/** JSON.stringify replacer that emits object keys in stable sort order
 *  at every level. Without it, `{a:1,b:2}` and `{b:2,a:1}` would hash
 *  differently. Arrays preserve their order — we want a moved message
 *  inside a thread to count as a change. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ordered: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) {
      ordered[k] = (value as Record<string, unknown>)[k]
    }
    return ordered
  }
  return value
}

/**
 * Memory-state shape consumed by `applyMemoryFor*` — exported for the
 * engine's optimistic apply path (if it ever wants to skip the round
 * trip through replaceMemory). Currently unused outside this module;
 * the comment is the export. Left intentionally to avoid a needless
 * export-then-delete in the next batch. */
export type _MemoryFromSync = MemoryState
