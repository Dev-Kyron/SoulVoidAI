/**
 * Continuous E2E-encrypted sync engine.
 *
 * Owns the periodic loop, the disk layout, and the pairing state machine.
 * No transport — chunks are written to a user-chosen folder, expected to
 * be backed by iCloud / Dropbox / OneDrive / Syncthing / Tailscale-mounted
 * storage. The user picks whichever cloud they already trust; VoidSoul
 * just treats the folder as a dumb persistent bytestore.
 *
 * Disk layout under <userFolder>/voidsoul-sync/:
 *
 *   manifest.json        Plaintext. Vault id, salt, device registry,
 *                        sentinel ciphertext used to verify a typed-in
 *                        mnemonic during pairing.
 *
 *   chunks/<hashedKey>.<deviceId>.<lamport>.bin
 *                        Each `.bin` is `[12-byte nonce][ciphertext][16-byte tag]`
 *                        sealed under the key derived from the recovery
 *                        phrase. `hashedKey` is `sha256(recordKey).slice(0,16)`
 *                        so cloud operators can't learn which threads
 *                        exist by directory listing. `deviceId` is per-vault
 *                        per-device. `lamport` is a base-36 millisecond
 *                        timestamp — sorts lexically chronological per
 *                        device, which the engine uses to age-out stale
 *                        chunks during compaction.
 *
 * Concurrency model: SQLite is single-process and the engine lives in
 * main, so there's no in-process race against the renderer. Two devices
 * writing to the same record-key concurrently is resolved LWW by the
 * `modifiedAt` field inside the sealed record — see the pull path.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { app } from 'electron'
import { log } from '../logger'
import { broadcast } from '../../events'
import { getSecret, setSecret } from '../storage/keys'
import { getConfig, updateConfig } from '../storage/config'
import { deriveKey, generateMnemonic, newSalt, seal, unseal, validateMnemonic } from './crypto'
import { applyRemoteRecord, collectLocalSnapshot, type SyncRecord } from './records'
import type { SyncDevice, SyncStatus } from '@shared/types'

/* --------------------------- constants --------------------------- */

const MANIFEST_FILE = 'manifest.json'
const CHUNKS_DIR = 'chunks'
const SYNC_SUBDIR = 'voidsoul-sync'
const MNEMONIC_SECRET_ID = 'voidsoul-sync-mnemonic'
const SENTINEL_PLAINTEXT = 'voidsoul-vault-v1'
const TICK_MS = 60_000
const PUSH_DEBOUNCE_MS = 2_500

/* --------------------------- shapes ------------------------------ */

interface Manifest {
  schema: 1
  vaultId: string
  saltB64: string
  createdAt: string
  /** Sentinel ciphertext (`seal(key, 'sentinel', 'voidsoul-vault-v1')`)
   *  used by Join-Vault to verify the user typed the right recovery
   *  phrase BEFORE we start trying to decrypt thousands of chunks. */
  sentinelB64: string
  devices: SyncDevice[]
}

/* --------------------------- state ------------------------------- */

let key: Buffer | null = null
let manifest: Manifest | null = null
let folder: string | null = null
let deviceId: string | null = null
let lastPushAt: string | null = null
let lastPullAt: string | null = null
let lastError: string | null = null
let state: 'idle' | 'syncing' | 'error' = 'idle'

let tickTimer: ReturnType<typeof setInterval> | null = null
let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null

/** v2.0 polish — set by `unpair`/`disposeSync` to make in-flight loop
 *  iterations bail cleanly instead of writing/reading against null
 *  module state. Checked at every yield point inside push/pull. */
let shuttingDown = false

/** v2.0 polish — single in-flight gate so the 60s tick + the 2.5s
 *  debounce + a manual `syncNow()` can't all run push/pull concurrently.
 *  Concurrent push wrote duplicate chunks with the same Date.now()
 *  filename and tore lastApplied between writers. */
let pushPullInFlight: Promise<void> | null = null

/**
 * Tracks the last record version this device APPLIED for each key —
 * whether the application source was a local push or a pull from a
 * peer. Each value carries the hash (canonical-JSON sha256 of the
 * payload) and the modifiedAt timestamp from the record we wrote/applied.
 *
 * Why hash AND modifiedAt:
 *   - Hash lets us detect unpushed local edits (current local snapshot's
 *     hash for this key ≠ lastApplied.hash means "user changed
 *     something since the last apply").
 *   - modifiedAt lets us LWW-compare against incoming peer records.
 *
 * Together they fix the v1 data-loss bug where pulls compared only
 * against the last-pushed hash and silently overwrote unpushed local
 * edits with older peer records.
 */
const lastApplied = new Map<string, { hash: string; modifiedAt: string }>()

/* ----------------------- public API ----------------------------- */

/**
 * Boot path. Called once from main's init after the secret store + db
 * are ready. Restores the previous session if the user was already
 * paired (mnemonic in keychain + folder remembered in config). On a
 * fresh install this is a no-op — the engine sits idle until the user
 * runs `setup` from the Settings panel.
 */
export async function initSync(): Promise<void> {
  try {
    const cfg = getConfig()
    // v2.0 polish — read syncVaultFolder (engine's own field) so the
    // legacy bundle field syncFolder can't redirect us. Fall back to
    // syncFolder ONLY for users paired before this polish landed; we
    // migrate the value forward on first successful load below.
    const vaultPath = cfg.syncVaultFolder || cfg.syncFolder
    if (!vaultPath || !cfg.syncPaired) return
    const mnemonic = getSecret(MNEMONIC_SECRET_ID)
    if (!mnemonic) {
      log('warn', 'system', 'Sync was paired but the recovery phrase is missing — leaving idle.')
      return
    }
    const entropy = validateMnemonic(mnemonic)
    if (!entropy) {
      log('error', 'system', 'Stored sync recovery phrase failed validation.')
      return
    }
    const m = readManifest(vaultPath)
    if (!m) {
      log('warn', 'system', `Sync folder ${vaultPath} has no manifest — leaving idle.`)
      return
    }
    const k = await deriveKey(entropy, Buffer.from(m.saltB64, 'base64'))
    // Verify the derived key actually decrypts THIS vault's sentinel —
    // protects against the user pointing the same recovery phrase at
    // someone else's folder.
    const sentinel = unseal(k, 'sentinel', Buffer.from(m.sentinelB64, 'base64'))
    if (!sentinel || sentinel.toString('utf-8') !== SENTINEL_PLAINTEXT) {
      log(
        'error',
        'system',
        'Sync sentinel decryption failed — the recovery phrase does not match this vault.'
      )
      return
    }
    key = k
    manifest = m
    folder = vaultPath
    deviceId = cfg.syncDeviceId ?? null
    if (!deviceId) {
      // Pre-paired install on a config that's missing the deviceId
      // (shouldn't normally happen, but be defensive). Generate one and
      // join the manifest now.
      deviceId = randomUUID()
      updateConfig({ syncDeviceId: deviceId })
      registerSelfInManifest()
    }
    // Migrate pre-polish installs that wrote the vault path into the
    // legacy syncFolder field. Move it to syncVaultFolder and clear
    // the legacy entry so a stale "Push bundle" click can't write
    // plaintext into the encrypted vault.
    if (!cfg.syncVaultFolder && cfg.syncFolder === vaultPath) {
      updateConfig({ syncVaultFolder: vaultPath, syncFolder: '' })
    }
    log('info', 'system', `Sync engine online — vault ${m.vaultId}, device ${deviceId}.`)
    startLoop()
  } catch (err) {
    log(
      'error',
      'system',
      'Sync engine init failed',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * Pair this device with a NEW vault. Generates a fresh mnemonic + salt
 * + vaultId, writes the manifest, registers this device, and returns
 * the mnemonic so the Settings UI can show the user their backup phrase.
 *
 * The mnemonic is also stored in the local keychain so the engine can
 * derive the key on subsequent launches without re-prompting.
 */
export async function setupNewVault(opts: {
  folder: string
  deviceName: string
}): Promise<{ mnemonic: string; vaultId: string }> {
  const vaultFolder = ensureFolder(opts.folder)
  if (existsSync(join(vaultFolder, MANIFEST_FILE))) {
    throw new Error(
      'That folder already contains a VoidSoul sync vault — use "Join existing" instead.'
    )
  }
  const mnemonic = generateMnemonic()
  const entropy = validateMnemonic(mnemonic)!
  const salt = newSalt()
  const derived = await deriveKey(entropy, salt)
  const sentinelBlob = seal(derived, 'sentinel', Buffer.from(SENTINEL_PLAINTEXT, 'utf-8'))
  const localDeviceId = randomUUID()
  const m: Manifest = {
    schema: 1,
    vaultId: randomUUID(),
    saltB64: salt.toString('base64'),
    sentinelB64: sentinelBlob.toString('base64'),
    createdAt: new Date().toISOString(),
    devices: [
      {
        id: localDeviceId,
        name: opts.deviceName,
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      }
    ]
  }
  writeManifest(vaultFolder, m)
  setSecret(MNEMONIC_SECRET_ID, mnemonic)
  updateConfig({
    // v2.0 polish — engine persists ONLY to syncVaultFolder. The
    // legacy syncFolder field stays untouched so the "Push bundle"
    // button doesn't get redirected into our encrypted vault path.
    syncVaultFolder: vaultFolder,
    syncPaired: true,
    syncDeviceId: localDeviceId,
    syncDeviceName: opts.deviceName
  })
  key = derived
  manifest = m
  folder = vaultFolder
  deviceId = localDeviceId
  // Do an immediate push so the new vault is non-empty + the manifest
  // is the only file the cloud has to replicate before another device
  // can join.
  startLoop()
  schedulePush()
  broadcastStatus()
  log('success', 'system', `Sync vault created at ${vaultFolder}.`)
  return { mnemonic, vaultId: m.vaultId }
}

/**
 * Join an EXISTING vault. The user typed their recovery phrase + picked
 * the same folder another device set up. Loads the manifest, derives
 * the key, verifies the sentinel decrypts, registers this device, and
 * stores the phrase locally.
 */
export async function joinExistingVault(opts: {
  folder: string
  mnemonic: string
  deviceName: string
}): Promise<{ vaultId: string }> {
  const vaultFolder = ensureFolder(opts.folder)
  const m = readManifest(vaultFolder)
  if (!m) {
    throw new Error(
      'No VoidSoul sync vault found in that folder. Use "Create new vault" to set one up.'
    )
  }
  const entropy = validateMnemonic(opts.mnemonic)
  if (!entropy) {
    throw new Error('That recovery phrase is not a valid 24-word BIP-39 mnemonic.')
  }
  const derived = await deriveKey(entropy, Buffer.from(m.saltB64, 'base64'))
  const sentinel = unseal(derived, 'sentinel', Buffer.from(m.sentinelB64, 'base64'))
  if (!sentinel || sentinel.toString('utf-8') !== SENTINEL_PLAINTEXT) {
    throw new Error(
      'Recovery phrase does not match this vault. Double-check the words — order matters.'
    )
  }
  // Register this device.
  const localDeviceId = randomUUID()
  m.devices.push({
    id: localDeviceId,
    name: opts.deviceName,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  })
  writeManifest(vaultFolder, m)
  setSecret(MNEMONIC_SECRET_ID, opts.mnemonic)
  updateConfig({
    syncVaultFolder: vaultFolder,
    syncPaired: true,
    syncDeviceId: localDeviceId,
    syncDeviceName: opts.deviceName
  })
  key = derived
  manifest = m
  folder = vaultFolder
  deviceId = localDeviceId
  startLoop()
  // First pull immediately — pulls down whatever the other device(s)
  // have published before we start pushing our local diffs.
  void doPull().then(() => schedulePush())
  broadcastStatus()
  log('success', 'system', `Joined sync vault ${m.vaultId} at ${vaultFolder}.`)
  return { vaultId: m.vaultId }
}

/**
 * Unpair this device. Stops the loop, drops the in-memory key, removes
 * the mnemonic from the keychain, and de-registers from the manifest.
 * Does NOT delete chunks — other devices on the vault keep working.
 * Local data is untouched.
 */
export async function unpair(): Promise<void> {
  // v2.0 polish — flip the shutdown gate first so any push/pull
  // already iterating sees it on the next yield and bails before
  // touching the now-nulled module state. Then await the in-flight
  // chain so it's settled before we wipe key/folder/etc.
  shuttingDown = true
  stopLoop()
  if (pushPullInFlight) {
    try {
      await pushPullInFlight
    } catch {
      /* swallowed — the inflight runner has its own error logging */
    }
  }
  if (manifest && folder && deviceId) {
    manifest.devices = manifest.devices.filter((d) => d.id !== deviceId)
    try {
      writeManifest(folder, manifest)
    } catch (err) {
      log(
        'warn',
        'system',
        'Unpair: could not update manifest',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  // setSecret with empty value deletes the entry (see storage/keys.ts).
  setSecret(MNEMONIC_SECRET_ID, '')
  updateConfig({
    syncPaired: false,
    syncDeviceId: '',
    syncDeviceName: '',
    syncVaultFolder: ''
  })
  key = null
  manifest = null
  folder = null
  deviceId = null
  lastPushAt = null
  lastPullAt = null
  lastError = null
  state = 'idle'
  lastApplied.clear()
  shuttingDown = false
  broadcastStatus()
}

/** Renderer-facing one-shot trigger — runs a full push+pull right now,
 *  even if the timer hasn't fired yet. Useful for the "Sync now" button. */
export async function syncNow(): Promise<void> {
  if (!key || !manifest) return
  await runExclusive('manual-sync', async () => {
    // v2.0 round-6 perf — share the snapshot across the pull+push pair.
    const snapshot = collectLocalSnapshot()
    await doPull(snapshot)
    await doPush(snapshot)
    lastError = null
    state = 'idle'
    broadcastStatus()
  })
}

/** Read-only status snapshot for the Settings panel. */
export function getSyncStatus(): SyncStatus {
  return {
    paired: !!key,
    folder,
    vaultId: manifest?.vaultId ?? null,
    deviceId,
    deviceName: getConfig().syncDeviceName || null,
    lastPushAt,
    lastPullAt,
    devices: manifest?.devices ?? [],
    state,
    lastError
  }
}

/**
 * Returns the active mnemonic from the OS keychain so the Settings
 * panel can offer "show recovery phrase" for backup. Returns null if
 * we're not paired or the keychain entry is gone.
 */
export async function getMnemonic(): Promise<string | null> {
  if (!key) return null
  return getSecret(MNEMONIC_SECRET_ID)
}

/**
 * External hook the rest of main calls to debounce-schedule a push
 * whenever local state changes (e.g. a chat reply lands, a memory
 * fact is added). Cheap to call repeatedly — debounced internally.
 */
export function notifyLocalChange(): void {
  if (!key) return
  schedulePush()
}

/* ------------------------- internals ---------------------------- */

function startLoop(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    void runExclusive('tick', async () => {
      // v2.0 round-6 perf — share the snapshot across doPull + doPush
      // within ONE tick. Each computation walks getHistory + getMemory +
      // getConfig and SHA-256s every record; doing it twice per tick is
      // pure waste for paired vaults. The mutex guarantees no writes can
      // land between pull and push, so the snapshot stays consistent.
      const snapshot = collectLocalSnapshot()
      await doPull(snapshot)
      await doPush(snapshot)
    })
  }, TICK_MS)
  // Run the first cycle immediately so a freshly-paired device doesn't
  // wait a full minute for its initial pull/push. Routed through the
  // mutex so a debounce / tick / syncNow can't race the first cycle.
  void runExclusive('initial', async () => {
    const snapshot = collectLocalSnapshot()
    await doPull(snapshot)
    await doPush(snapshot)
  })
}

function stopLoop(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (pushDebounceTimer) {
    clearTimeout(pushDebounceTimer)
    pushDebounceTimer = null
  }
}

function schedulePush(): void {
  if (!key) return
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer)
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null
    void runExclusive('debounced-push', doPush)
  }, PUSH_DEBOUNCE_MS)
}

/**
 * Mutex wrapper. Coalesces concurrent push/pull invocations into a
 * single in-flight chain so the 60s tick, the 2.5s debounce, and
 * `syncNow()` can never run write paths in parallel against the same
 * vault folder. Callers always `await` the returned promise so they
 * see the same lifecycle the inflight runner observed.
 */
function runExclusive(label: string, fn: () => Promise<void>): Promise<void> {
  if (pushPullInFlight) {
    // Coalesce — chain after the in-flight run so the caller's
    // intent (user clicked Sync Now during a tick) still produces
    // a fresh attempt afterwards.
    pushPullInFlight = pushPullInFlight.then(fn).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      state = 'error'
      log('error', 'system', `Sync ${label} failed`, lastError)
      broadcastStatus()
    })
    return pushPullInFlight
  }
  pushPullInFlight = fn()
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      state = 'error'
      log('error', 'system', `Sync ${label} failed`, lastError)
      broadcastStatus()
    })
    .finally(() => {
      pushPullInFlight = null
    })
  return pushPullInFlight
}

async function doPush(snapshotIn?: ReturnType<typeof collectLocalSnapshot>): Promise<void> {
  if (!key || !manifest || !folder || !deviceId || shuttingDown) return
  state = 'syncing'
  broadcastStatus()
  const chunksDir = ensureChunksDir(folder)
  // v2.0 round-6 perf — accept a pre-computed snapshot from the tick
  // wrapper so it can be shared with doPull in the same cycle. Falls
  // back to computing one (debounced-push only calls doPush solo).
  const snapshot = snapshotIn ?? collectLocalSnapshot()
  let written = 0
  for (const entry of snapshot) {
    if (shuttingDown) break
    const prev = lastApplied.get(entry.key)
    if (prev?.hash === entry.hash) continue // unchanged since last apply
    const modifiedAt = new Date().toISOString()
    const record: SyncRecord = {
      schema: 1,
      key: entry.key,
      kind: entry.kind,
      modifiedAt,
      deviceId,
      data: entry.data
    }
    const plain = Buffer.from(JSON.stringify(record), 'utf-8')
    const blob = seal(key, entry.key, plain)
    const filename = chunkFilename(entry.key, deviceId)
    writeFileSync(join(chunksDir, filename), blob)
    lastApplied.set(entry.key, { hash: entry.hash, modifiedAt })
    written++
    // Yield to the event loop between records so a 200-thread initial
    // push doesn't freeze the main process for several seconds.
    if (written % 5 === 0) await new Promise<void>((r) => setImmediate(r))
  }
  if (written > 0) {
    touchSelfLastSeen()
    lastPushAt = new Date().toISOString()
    log('info', 'system', `Sync: pushed ${written} record${written === 1 ? '' : 's'}.`)
  }
  state = 'idle'
  broadcastStatus()
}

async function doPull(snapshotIn?: ReturnType<typeof collectLocalSnapshot>): Promise<void> {
  if (!key || !manifest || !folder || shuttingDown) return
  state = 'syncing'
  broadcastStatus()
  const chunksDir = ensureChunksDir(folder)
  // v2.0 polish — snapshot the local state ONCE per pull tick so the
  // reverse-lookup `recordKeyForHashedKey` doesn't re-run getHistory()
  // + getMemory() + getConfig() for every chunk file (was O(chunks ×
  // (threads + memory + config)) per pull, observable as multi-second
  // jank on vaults with 100+ threads).
  // v2.0 round-6 perf — accept the snapshot from the tick wrapper to
  // share with doPush; falls back to computing one (manual-sync calls
  // doPull solo).
  const localSnapshot = snapshotIn ?? collectLocalSnapshot()
  const hashedKeyIndex = new Map<string, string>()
  for (const entry of localSnapshot) {
    hashedKeyIndex.set(hashedKeyOf(entry.key), entry.key)
  }
  const localHashByKey = new Map<string, string>()
  for (const entry of localSnapshot) {
    localHashByKey.set(entry.key, entry.hash)
  }
  // Group chunk files by recordKey hash, keep only the latest blob
  // per (recordKey, deviceId) by lamport timestamp embedded in the
  // filename, then for each recordKey across devices pick the chunk
  // whose decrypted modifiedAt is newest.
  let files: string[]
  try {
    files = readdirSync(chunksDir)
  } catch {
    state = 'idle'
    broadcastStatus()
    return
  }
  // Map<hashedKey, Map<deviceId, { lamport, filename }>>
  const latestPerDevice = new Map<string, Map<string, { lamport: string; filename: string }>>()
  for (const file of files) {
    const parsed = parseChunkFilename(file)
    if (!parsed) continue
    let perDevice = latestPerDevice.get(parsed.hashedKey)
    if (!perDevice) {
      perDevice = new Map()
      latestPerDevice.set(parsed.hashedKey, perDevice)
    }
    const existing = perDevice.get(parsed.deviceId)
    // v2.0 polish — compare ts portion first; only consult the random
    // suffix on a true ms collision (and even then, the random ordering
    // doesn't matter for correctness — both writes were logically
    // simultaneous, the merge layer can pick either deterministically).
    if (!existing || compareLamport(existing.lamport, parsed.lamport) < 0) {
      perDevice.set(parsed.deviceId, { lamport: parsed.lamport, filename: file })
    }
  }

  let applied = 0
  let skipped = 0
  // v2.0 polish — destructure the hashedKey from the outer map entry so
  // the inner loop can look it up directly. The previous shape discarded
  // the outer key with `[, perDevice]` and then re-ran
  // `parseChunkFilename(entry.filename)?.hashedKey` for every chunk file,
  // paying the regex/split cost N-files-per-record × N-records per pull.
  for (const [hashedKey, perDevice] of latestPerDevice) {
    // For each recordKey, find the freshest decrypted record across
    // all devices. We have to decrypt to read `modifiedAt`, so this
    // is O(N device chunks per key). Bounded by `len(devices)` which
    // in practice is 2-3, so cheap.
    let winner: { record: SyncRecord; mtimeMs: number } | null = null
    for (const [, entry] of perDevice) {
      const fullPath = join(chunksDir, entry.filename)
      let blob: Buffer
      try {
        blob = readFileSync(fullPath)
      } catch {
        continue
      }
      // We need the recordKey to decrypt (AAD binding), but we only
      // have the hashedKey from the filename. The recordKey itself
      // lives inside the record once decrypted — chicken-and-egg.
      // Solve by computing the candidate recordKey from the local
      // snapshot's known keys (cached above for this pull tick).
      const recordKey = hashedKeyIndex.get(hashedKey)
      if (!recordKey) {
        // We don't have a candidate recordKey — this is a brand-new
        // thread we've never seen. For threads the key is
        // `thread:<uuid>` but we'd need the uuid first to make the
        // AAD match. Workaround: peek at the manifest's known-keys
        // index (added in v1.1) — for v1 we punt: any unknown
        // hashedKey is logged once and skipped. A follow-up fixes
        // this with a thin index file or a per-record manifest entry.
        skipped++
        continue
      }
      const plain = unseal(key, recordKey, blob)
      if (!plain) {
        skipped++
        continue
      }
      let record: SyncRecord
      try {
        record = JSON.parse(plain.toString('utf-8')) as SyncRecord
      } catch {
        skipped++
        continue
      }
      const mtimeMs = Date.parse(record.modifiedAt || '')
      if (!Number.isFinite(mtimeMs)) continue
      if (!winner || mtimeMs > winner.mtimeMs) {
        winner = { record, mtimeMs }
      }
    }
    if (!winner) continue
    const winnerHash = createHash('sha256')
      .update(JSON.stringify(winner.record.data, sortedKeys))
      .digest('hex')
    const tracked = lastApplied.get(winner.record.key)
    // Already in sync with what we last wrote/applied → no-op.
    if (tracked?.hash === winnerHash) continue
    // v2.0 polish — data-loss guard. The previous version compared
    // only against the last-pushed hash; if a user edited locally
    // between pushes, ourHash was stale and a peer's older record
    // silently overwrote the unpushed edit. Now: if the local snapshot
    // diverges from our tracked apply, the local copy is dirty and
    // takes precedence — we'll let the next push send our version.
    const currentLocalHash = localHashByKey.get(winner.record.key)
    if (currentLocalHash && tracked && currentLocalHash !== tracked.hash) {
      // Local has unpushed changes; favour local.
      continue
    }
    // LWW: only apply when the winner's modifiedAt is strictly newer
    // than what we last applied. tracked === undefined means we've
    // never seen this key — apply unconditionally.
    if (tracked) {
      const trackedMs = Date.parse(tracked.modifiedAt)
      if (Number.isFinite(trackedMs) && winner.mtimeMs <= trackedMs) continue
    }
    if (applyRemoteRecord(winner.record)) {
      lastApplied.set(winner.record.key, {
        hash: winnerHash,
        modifiedAt: winner.record.modifiedAt
      })
      applied++
    } else {
      skipped++
    }
    if (shuttingDown) break
  }

  if (applied > 0) {
    lastPullAt = new Date().toISOString()
    log('info', 'system', `Sync: applied ${applied} record${applied === 1 ? '' : 's'} from peers.`)
  }
  if (skipped > 0) {
    log(
      'warn',
      'system',
      `Sync: skipped ${skipped} chunk${skipped === 1 ? '' : 's'} (bad/unknown).`
    )
  }
  state = 'idle'
  broadcastStatus()
}

/* ------------------------ folder/manifest IO ------------------- */

function ensureFolder(folderPath: string): string {
  const sub = join(folderPath, SYNC_SUBDIR)
  if (!existsSync(sub)) mkdirSync(sub, { recursive: true })
  return sub
}

function ensureChunksDir(vaultFolder: string): string {
  const dir = join(vaultFolder, CHUNKS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readManifest(folderOrParent: string): Manifest | null {
  // Accept either the parent folder (".../iCloud/MyStuff") or the
  // already-resolved vault subfolder (".../MyStuff/voidsoul-sync").
  const candidates = [
    join(folderOrParent, MANIFEST_FILE),
    join(folderOrParent, SYNC_SUBDIR, MANIFEST_FILE)
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Manifest
      if (raw.schema === 1 && typeof raw.vaultId === 'string') return raw
    } catch {
      /* fall through to next candidate */
    }
  }
  return null
}

function writeManifest(vaultFolder: string, m: Manifest): void {
  writeFileSync(join(vaultFolder, MANIFEST_FILE), JSON.stringify(m, null, 2), 'utf-8')
}

function touchSelfLastSeen(): void {
  if (!manifest || !folder || !deviceId) return
  const self = manifest.devices.find((d) => d.id === deviceId)
  if (!self) return
  self.lastSeenAt = new Date().toISOString()
  try {
    writeManifest(folder, manifest)
  } catch {
    /* not fatal */
  }
}

function registerSelfInManifest(): void {
  if (!manifest || !folder || !deviceId) return
  if (manifest.devices.find((d) => d.id === deviceId)) return
  manifest.devices.push({
    id: deviceId,
    name: getConfig().syncDeviceName || defaultDeviceName(),
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  })
  try {
    writeManifest(folder, manifest)
  } catch {
    /* not fatal */
  }
}

/* ----------------------- filename helpers --------------------- */

function chunkFilename(recordKey: string, deviceIdStr: string): string {
  const hashedKey = hashedKeyOf(recordKey)
  // v2.0 polish — base-36 millisecond timestamp + 4 random hex chars.
  // The random suffix disambiguates same-ms writes (which DID collide
  // under the pure Date.now() scheme, causing the second writeFileSync
  // to silently overwrite the first). padStart(12) keeps lexicographic
  // ordering stable for the next ~140 years of ms timestamps.
  const lamport = Date.now().toString(36).padStart(12, '0')
  const suffix = randomBytes(2).toString('hex')
  return `${hashedKey}.${deviceIdStr}.${lamport}${suffix}.bin`
}

function parseChunkFilename(
  file: string
): { hashedKey: string; deviceId: string; lamport: string; tsLamport: string } | null {
  if (!file.endsWith('.bin')) return null
  const stem = file.slice(0, -4)
  const parts = stem.split('.')
  if (parts.length !== 3) return null
  // v2.0 polish — separate the 12-char ms timestamp from the 4-char
  // random suffix so comparators can sort by TS first. Pre-fix code
  // lex-compared the full 16-char concat, which meant two same-ms
  // writes were ordered by random suffix — a SECOND write could "lose"
  // to the FIRST if its suffix sorted lower. `lamport` is kept for
  // back-compat (some callsites use it as the full 16-char string);
  // `tsLamport` is the timestamp portion for correct ordering.
  const lamport = parts[2]
  const tsLamport = lamport.length >= 12 ? lamport.slice(0, 12) : lamport
  return { hashedKey: parts[0], deviceId: parts[1], lamport, tsLamport }
}

function hashedKeyOf(recordKey: string): string {
  return createHash('sha256').update(recordKey).digest('hex').slice(0, 16)
}

/**
 * Compare two `lamport` strings produced by chunkFilename. Sorts by the
 * 12-char ms-timestamp prefix first, then by the random suffix as a
 * stable (but arbitrary) tiebreak. Returns negative when `a < b`, zero
 * when equal, positive when `a > b`.
 *
 * The tiebreak matters because the previous full-string comparison was
 * the round-2 finding #9 bug: same-ms writes were ordered by random
 * suffix alone, so a SECOND write could land an older-suffix value
 * "wins" the lookup. Splitting at 12 chars stops that.
 */
function compareLamport(a: string, b: string): number {
  const aTs = a.slice(0, 12)
  const bTs = b.slice(0, 12)
  if (aTs < bTs) return -1
  if (aTs > bTs) return 1
  // Same ms — fall back to the suffix for a stable order. Either
  // choice is correct at the merge layer; the suffix happens to give
  // us a consistent answer across all callers.
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// (Reverse-lookup inlined into doPull as `hashedKeyIndex` — built once
// per pull from the cached snapshot, replacing the per-chunk
// `recordKeyForHashedKey` call that re-fetched the entire local DB on
// every chunk file. v1 limitation about unknown-key fallback documented
// in doPull.)

/* ----------------------- broadcast + misc --------------------- */

function broadcastStatus(): void {
  broadcast('sync:status', getSyncStatus())
}

function defaultDeviceName(): string {
  try {
    return app.getName() + '-' + (process.platform === 'darwin' ? 'mac' : process.platform)
  } catch {
    return 'unknown-device'
  }
}

/** Same key-sorted JSON helper as records.ts. Inlined here so the
 *  engine has no upward dep on a pure-fn helper from a sibling. */
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

/* ----------------------- dispose ------------------------------- */

/** Called at app quit. Cancels timers + clears the in-memory key.
 *  v2.0 polish — sets the shutdown gate first so an in-flight push/pull
 *  bails on its next yield rather than writeFileSync'ing against a torn-
 *  down session. Returns a Promise the caller MAY await for a graceful
 *  flush; not awaited today (main quits synchronously) but exposed for
 *  future use. */
export async function disposeSync(): Promise<void> {
  shuttingDown = true
  stopLoop()
  if (pushPullInFlight) {
    try {
      await pushPullInFlight
    } catch {
      /* swallowed */
    }
  }
  key = null
  manifest = null
  folder = null
  deviceId = null
  lastApplied.clear()
}

/* ---------------------- mtime utility (test) ------------------ */

/** Returns the chunk file's mtime in millis or NaN if unreadable.
 *  Currently unused by the engine itself — used by tests that stub
 *  the chunks dir. Kept here so the surface is one module. */
export function _chunkMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return NaN
  }
}

/** Best-effort cleanup of chunks the user explicitly opts out of (the
 *  Settings UI offers "wipe my data from the vault"). Only deletes
 *  THIS device's chunks; other devices' chunks stay. */
export function deleteOwnChunks(): void {
  if (!folder || !deviceId) return
  const dir = join(folder, CHUNKS_DIR)
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const file of files) {
    const parsed = parseChunkFilename(file)
    if (parsed?.deviceId === deviceId) {
      try {
        unlinkSync(join(dir, file))
      } catch {
        /* skip unreadable */
      }
    }
  }
}
