/**
 * Backup & Sync.
 *
 * Two coexisting subsystems:
 *
 *   1. **Manual backup** (legacy) — one-click Export / Import of the
 *      entire app state as a portable JSON file. Always available;
 *      doesn't engage the engine. Useful for one-off transfers.
 *
 *   2. **Encrypted sync (v2.0)** — continuous E2E-encrypted folder sync
 *      between two or more devices. Pair once via 24-word recovery
 *      phrase; the engine pushes/pulls per-record blobs every 60s.
 *      Renderer here is purely a control surface — pairing flow,
 *      device list, recovery-phrase backup. All state lives in main.
 */
import { useEffect, useState } from 'react'
import {
  Download,
  Upload,
  FolderOpen,
  CloudUpload,
  CloudDownload,
  Lock,
  RefreshCw,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  PlusCircle,
  LogIn,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { usePluginStore } from '../../store/usePluginStore'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { copyToClipboard } from '../../lib/clipboard'
import { CollapsibleSection } from './CollapsibleSection'
import type { SyncResult, SyncStatus } from '@shared/types'

const BTN =
  'flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] text-slate-200 transition hover:bg-white/5 disabled:opacity-40'

const FIELD =
  'rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

export function SyncSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  if (!config) return null

  const toastFor = (result: SyncResult): void => {
    const cancelled = /cancelled/i.test(result.message)
    pushToast(result.ok ? 'success' : cancelled ? 'info' : 'error', result.message)
  }

  const refreshStores = async (): Promise<void> => {
    await useConfigStore.getState().load()
    await useMemoryStore.getState().load()
    await usePluginStore.getState().load()
    await useChatStore.getState().load(true)
  }

  const run = async (action: () => Promise<SyncResult>, isImport: boolean): Promise<void> => {
    setBusy(true)
    const result = await action()
    if (result.ok && isImport) await refreshStores()
    setBusy(false)
    toastFor(result)
  }

  return (
    <CollapsibleSection
      title="Backup & Sync"
      hint="Manual backup writes one portable JSON file. Encrypted sync (v2.0 beta) continuously syncs threads, memory and prefs across devices via a shared folder — fully E2E encrypted, no backend."
    >
      <EncryptedSyncSection />

      <div className="mt-3 mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
        <span>Manual backup</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => vs.sync.export(), false)}
          className={BTN}
        >
          <Download size={13} />
          Export backup
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => vs.sync.import(), true)}
          className={BTN}
        >
          <Upload size={13} />
          Import backup
        </button>
      </div>

      <div className="glass-soft rounded-lg p-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Sync folder (legacy bundle)
        </p>
        {config.syncFolder ? (
          <>
            <p className="mb-2 truncate text-[11px] text-slate-300" title={config.syncFolder}>
              {config.syncFolder}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => vs.sync.push(), false)}
                className={BTN}
              >
                <CloudUpload size={13} />
                Push bundle
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => vs.sync.pull(), true)}
                className={BTN}
              >
                <CloudDownload size={13} />
                Pull bundle
              </button>
            </div>
            <button
              type="button"
              onClick={async () => {
                useConfigStore.setState({ config: await vs.sync.clearFolder() })
              }}
              className="mt-1.5 text-[10px] text-rose-400 hover:underline"
            >
              Stop using this folder
            </button>
          </>
        ) : (
          <>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
              Pick a folder inside your Dropbox / OneDrive / Drive — VoidSoul writes one JSON bundle
              there each time you click Push. Not encrypted; use Encrypted sync above for continuous
              E2E protection.
            </p>
            <button
              type="button"
              onClick={async () => {
                useConfigStore.setState({ config: await vs.sync.chooseFolder() })
              }}
              className={BTN}
            >
              <FolderOpen size={13} />
              Choose sync folder
            </button>
          </>
        )}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Backups include settings, memory and plugins. API keys are never exported — they stay
        encrypted to each machine's keychain, so re-enter them after a restore.
      </p>
    </CollapsibleSection>
  )
}

/* ============================================================== */
/*  v2.0 — Encrypted sync section                                  */
/* ============================================================== */

function EncryptedSyncSection(): JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [pairOpen, setPairOpen] = useState(false)

  // Initial load + live updates from main.
  useEffect(() => {
    void vs.sync.status().then(setStatus)
    const off = vs.events.onSyncStatus((s) => setStatus(s))
    return off
  }, [])

  return (
    <div className="glass-soft mb-2 rounded-lg border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-100">
          <Lock size={12} className="text-[var(--accent)]" />
          Encrypted sync
          <span className="rounded bg-[var(--accent)]/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
            Beta
          </span>
        </p>
        <StatusBadge status={status} />
      </div>

      {status?.paired ? (
        <PairedView status={status} />
      ) : (
        <UnpairedView onSetup={() => setPairOpen(true)} />
      )}

      {pairOpen && (
        <PairingDialog
          onClose={() => setPairOpen(false)}
          onDone={() => {
            setPairOpen(false)
            void vs.sync.status().then(setStatus)
          }}
        />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: SyncStatus | null }): JSX.Element {
  if (!status || !status.paired)
    return <span className="text-[10px] text-slate-500">Not set up</span>
  if (status.state === 'syncing')
    return (
      <span className="flex items-center gap-1 text-[10px] text-[var(--accent)]">
        <RefreshCw size={9} className="animate-spin" />
        Syncing
      </span>
    )
  if (status.state === 'error')
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-rose-300"
        title={status.lastError ?? ''}
      >
        <AlertCircle size={10} />
        Error
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-[10px] text-emerald-300">
      <CheckCircle2 size={10} />
      Synced
    </span>
  )
}

function UnpairedView({ onSetup }: { onSetup: () => void }): JSX.Element {
  return (
    <>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
        End-to-end encrypted continuous sync between your devices via a shared folder (iCloud,
        Dropbox, OneDrive, Syncthing or Tailscale-mounted). Threads, memory and preferences sync
        every 60 seconds. Your recovery phrase is the only key — even the cloud provider can't read
        your data.
      </p>
      <button
        type="button"
        onClick={onSetup}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-2 text-[11px] font-semibold text-white transition hover:brightness-110"
      >
        <Lock size={13} />
        Set up sync
      </button>
    </>
  )
}

function PairedView({ status }: { status: SyncStatus }): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  const [confirmingUnpair, setConfirmingUnpair] = useState(false)
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null)

  const syncNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.sync.syncNow()
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (): Promise<void> => {
    const m = await vs.sync.getMnemonic()
    if (m) setRevealedMnemonic(m)
    else pushToast('error', 'Recovery phrase is missing from the keychain.')
  }

  const unpair = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.sync.unpair()
      pushToast('info', 'Sync unpaired on this device.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="mb-1 truncate text-[10px] text-slate-400" title={status.folder ?? ''}>
        <span className="text-slate-500">Folder: </span>
        {status.folder}
      </p>
      <p className="mb-2 text-[10px] text-slate-400">
        <span className="text-slate-500">This device: </span>
        {status.deviceName || 'unnamed'}
        {status.lastPushAt && (
          <span className="ml-1.5 text-slate-500">
            · last push {relativePast(status.lastPushAt)}
          </span>
        )}
      </p>

      {status.devices.length > 1 && (
        <div className="mb-2 rounded-md bg-black/20 p-1.5">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Devices on this vault
          </p>
          {status.devices.map((d) => (
            <p
              key={d.id}
              className="flex items-center justify-between gap-2 text-[10px] text-slate-300"
            >
              <span className="truncate">
                {d.name}
                {d.id === status.deviceId && (
                  <span className="ml-1 text-[9px] text-[var(--accent)]">(this device)</span>
                )}
              </span>
              <span className="shrink-0 text-[9px] text-slate-500">
                {relativePast(d.lastSeenAt)}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={busy} onClick={() => void syncNow()} className={BTN}>
          {busy ? <RefreshCw size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          Sync now
        </button>
        {revealedMnemonic ? (
          <button type="button" onClick={() => setRevealedMnemonic(null)} className={BTN}>
            <EyeOff size={10} />
            Hide phrase
          </button>
        ) : (
          <button type="button" onClick={() => void reveal()} className={BTN}>
            <Eye size={10} />
            Show phrase
          </button>
        )}
      </div>

      {revealedMnemonic && <MnemonicReveal mnemonic={revealedMnemonic} />}

      {status.lastError && (
        <p className="mt-2 rounded-md bg-rose-500/10 p-1.5 text-[10px] text-rose-200">
          {status.lastError}
        </p>
      )}

      <div className="mt-2 flex justify-end">
        {confirmingUnpair ? (
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void unpair()}
              className="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-500/30"
            >
              Confirm unpair
            </button>
            <button
              type="button"
              onClick={() => setConfirmingUnpair(false)}
              className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingUnpair(true)}
            className="flex items-center gap-1 rounded-md p-1 text-[10px] text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200"
          >
            <Trash2 size={10} />
            Unpair this device
          </button>
        )}
      </div>
    </>
  )
}

function MnemonicReveal({ mnemonic }: { mnemonic: string }): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const words = mnemonic.split(/\s+/)
  return (
    <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/[0.06] p-2">
      <p className="mb-1.5 text-[10px] text-amber-200">
        Write this down. It's the only way to recover your sync vault — anyone with it can read all
        your synced data.
      </p>
      <div className="grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-[10px]">
        {words.map((w, i) => (
          <span key={i} className="text-slate-200">
            <span className="text-slate-500">{i + 1}.</span> {w}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={async () => {
          await copyToClipboard(mnemonic)
          pushToast('success', 'Recovery phrase copied to clipboard.')
        }}
        className="mt-2 flex items-center gap-1 text-[10px] text-amber-300 hover:underline"
      >
        <Copy size={10} />
        Copy phrase
      </button>
    </div>
  )
}

/* ============================================================== */
/*  Pairing dialog (create new / join existing)                    */
/* ============================================================== */

type PairingMode = 'choose' | 'creating' | 'joining' | 'created'

function PairingDialog({
  onClose,
  onDone
}: {
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [mode, setMode] = useState<PairingMode>('choose')
  const [folder, setFolder] = useState('')
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName())
  const [mnemonic, setMnemonic] = useState('')
  const [createdMnemonic, setCreatedMnemonic] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickFolder = async (): Promise<void> => {
    // v2.0 polish — the wizard uses the NON-persisting picker so an
    // aborted setup doesn't leave config.syncFolder pointing at a random
    // Dropbox/iCloud folder (which would then misdirect the legacy
    // "Push bundle" button on subsequent clicks). The sync engine's
    // setup/join treats the picked folder as the parent — `voidsoul-sync`
    // subfolder is created/expected inside it.
    const picked = await vs.sync.pickVaultFolder()
    if (picked) setFolder(picked)
  }

  const create = async (): Promise<void> => {
    if (!folder || !deviceName.trim()) {
      pushToast('error', 'Pick a folder and give this device a name.')
      return
    }
    setBusy(true)
    try {
      const result = await vs.sync.setupNew({ folder, deviceName: deviceName.trim() })
      setCreatedMnemonic(result.mnemonic)
      setMode('created')
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const join = async (): Promise<void> => {
    if (!folder || !deviceName.trim() || !mnemonic.trim()) {
      pushToast('error', 'Folder, device name and recovery phrase are all required.')
      return
    }
    setBusy(true)
    try {
      await vs.sync.join({
        folder,
        deviceName: deviceName.trim(),
        mnemonic: mnemonic.trim()
      })
      pushToast('success', 'Joined the sync vault. First pull running in the background.')
      onDone()
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass max-w-md rounded-xl p-4">
        <p className="mb-3 text-[12px] font-semibold text-slate-100">
          {mode === 'choose' && 'Set up encrypted sync'}
          {mode === 'creating' && 'Create new vault'}
          {mode === 'joining' && 'Join existing vault'}
          {mode === 'created' && 'Vault created — save your recovery phrase'}
        </p>

        {mode === 'choose' && (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
              Pick the path that matches what you're doing on this device.
            </p>
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => setMode('creating')}
                className={`${BTN} justify-start gap-2 py-3`}
              >
                <PlusCircle size={14} className="text-[var(--accent)]" />
                <span className="flex-1 text-left">
                  <span className="block text-[12px] text-slate-100">Create new vault</span>
                  <span className="block text-[10px] text-slate-500">
                    First device — generates a fresh recovery phrase.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode('joining')}
                className={`${BTN} justify-start gap-2 py-3`}
              >
                <LogIn size={14} className="text-[var(--accent)]" />
                <span className="flex-1 text-left">
                  <span className="block text-[12px] text-slate-100">Join existing vault</span>
                  <span className="block text-[10px] text-slate-500">
                    Already paired another device — type the phrase here.
                  </span>
                </span>
              </button>
            </div>
          </>
        )}

        {(mode === 'creating' || mode === 'joining') && (
          <>
            <label className="mb-2 block">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Shared folder
              </span>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  readOnly
                  value={folder || ''}
                  placeholder="Click to pick a folder…"
                  className={`${FIELD} flex-1 truncate`}
                />
                <button type="button" onClick={() => void pickFolder()} className={BTN}>
                  <FolderOpen size={11} />
                  Pick
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                Point this at an iCloud / Dropbox / OneDrive / Syncthing / Tailscale-mounted folder.
                VoidSoul creates a <code className="font-mono">voidsoul-sync</code> subfolder
                inside.
              </p>
            </label>

            <label className="mb-2 block">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                This device's name
              </span>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Kyron-Desktop"
                className={`${FIELD} w-full`}
              />
            </label>

            {mode === 'joining' && (
              <label className="mb-2 block">
                <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                  24-word recovery phrase
                </span>
                <textarea
                  value={mnemonic}
                  onChange={(e) => setMnemonic(e.target.value)}
                  placeholder="abandon abandon abandon …"
                  rows={3}
                  className={`${FIELD} w-full resize-none font-mono`}
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Type or paste the phrase exactly as the first device showed it. Order matters;
                  capitalisation and whitespace are normalised.
                </p>
              </label>
            )}

            <div className="mt-3 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setMode('choose')}
                disabled={busy}
                className={BTN}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void (mode === 'creating' ? create() : join())}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {busy && <RefreshCw size={11} className="animate-spin" />}
                {mode === 'creating' ? 'Create vault' : 'Join vault'}
              </button>
            </div>
          </>
        )}

        {mode === 'created' && createdMnemonic && (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-amber-200">
              This is your recovery phrase. Write it down or store it in a password manager — it's
              the only way to add another device or restore from this vault. Anyone with it can read
              everything you sync.
            </p>
            <MnemonicReveal mnemonic={createdMnemonic} />
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setCreatedMnemonic(null)
                  onDone()
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
              >
                I've saved it
              </button>
            </div>
          </>
        )}

        {mode === 'choose' && (
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onClose} className={BTN}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------- helpers --------------------------- */

function defaultDeviceName(): string {
  try {
    const host =
      (typeof navigator !== 'undefined' && navigator.userAgent.match(/\((.*?)\)/)?.[1]) || ''
    if (host) return host.split(';')[0].trim().slice(0, 30)
  } catch {
    /* noop */
  }
  return 'VoidSoul Device'
}

function relativePast(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} d ago`
}
