/**
 * Backup & Sync. Exports/imports a portable bundle (settings, memory,
 * plugins), and offers a "sync folder" — point it at a Dropbox/Drive folder
 * and it becomes cloud sync through the user's own cloud. API keys are never
 * included; they stay encrypted to each machine's keychain.
 */
import { useState } from 'react'
import { Download, Upload, FolderOpen, CloudUpload, CloudDownload } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { usePluginStore } from '../../store/usePluginStore'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { CollapsibleSection } from './CollapsibleSection'
import type { SyncResult } from '@shared/types'

const BTN =
  'flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] text-slate-200 transition hover:bg-white/5 disabled:opacity-40'

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
      hint="Export or import your whole setup as one file, or point a sync folder at Dropbox/Drive for cross-machine sync. API keys are never included."
    >

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
          Sync folder
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
                Sync now
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => vs.sync.pull(), true)}
                className={BTN}
              >
                <CloudDownload size={13} />
                Pull
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
              Pick a folder inside your Dropbox / OneDrive / Drive — VoidSoul writes a sync file
              there, and your other machines read it. That makes it cloud sync, through your own
              cloud.
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
