/**
 * Settings panel for File RAG. Lets the user register folders the assistant
 * should be able to recall semantically (UE5 project, design docs, research
 * notes…). Each folder shows file/chunk counts and a "last scan" timestamp,
 * with controls to rescan or remove.
 *
 * Indexing happens in the main process. While a scan is running, the panel
 * surfaces a thin progress strip with the current file being processed.
 */
import { useEffect, useState } from 'react'
import { FolderPlus, FolderX, RefreshCcw, Files, Cpu } from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { useConfigStore } from '../../store/useConfigStore'
import { basename } from '../../lib/utils'
import type {
  EmbeddingProvider,
  IndexedFolder,
  ScanProgress,
  ScanResult
} from '@shared/types'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FolderRow({
  folder,
  onChange
}: {
  folder: IndexedFolder
  onChange: () => void
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const shortPath = folder.path.length > 60 ? `…${folder.path.slice(-60)}` : folder.path

  const handleRemove = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.filesRag.removeFolder(folder.path)
      pushToast('info', 'Folder removed from index.')
      onChange()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const handleRescan = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.filesRag.rescan(folder.path)
      pushToast('info', 'Rescan started.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass-soft rounded-lg p-2.5">
      <div className="flex items-start gap-2">
        <Files size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-mono text-[11px] text-slate-100"
            title={folder.path}
          >
            {shortPath}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">
            {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'} ·{' '}
            {folder.chunkCount} chunk{folder.chunkCount === 1 ? '' : 's'} ·{' '}
            {folder.lastScan
              ? `scanned ${new Date(folder.lastScan).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
              : 'never scanned'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRescan()}
          disabled={busy}
          title="Rescan this folder"
          className="rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
        >
          <RefreshCcw size={12} />
        </button>
        {confirming ? (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={busy}
              className="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-500/30"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            title="Remove from index"
            className="rounded-md p-1 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40"
          >
            <FolderX size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

const EMBEDDING_OPTIONS: Array<{
  id: EmbeddingProvider
  label: string
  blurb: string
}> = [
  {
    id: 'auto',
    label: 'Auto',
    blurb: 'OpenAI if a key is set, otherwise Ollama. Sensible default.'
  },
  {
    id: 'local',
    label: 'Local (free)',
    blurb:
      'Runs Transformers.js inside the RAG worker — no API key, no token cost, unlimited indexing. Downloads ~25 MB the first time it runs, then fully offline.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'text-embedding-3-small via your OpenAI key. Fastest, highest quality.'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: 'nomic-embed-text via a local Ollama daemon. Local + free if you already run Ollama.'
  }
]

function EmbeddingProviderPicker(): JSX.Element {
  const selected = useConfigStore(
    (s) => s.config?.chat.embeddingProvider ?? 'auto'
  )
  const setEmbeddingProvider = useConfigStore((s) => s.setEmbeddingProvider)
  const current = EMBEDDING_OPTIONS.find((o) => o.id === selected) ?? EMBEDDING_OPTIONS[0]

  return (
    <div className="glass-soft space-y-1.5 rounded-lg p-2.5">
      <div className="flex items-center gap-1.5">
        <Cpu size={12} className="text-[var(--accent)]" />
        <span className="text-[11px] font-semibold text-slate-200">Embedding engine</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {EMBEDDING_OPTIONS.map((option) => {
          const active = option.id === selected
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => void setEmbeddingProvider(option.id)}
              className={
                'rounded-md px-2 py-1 text-[10px] font-medium transition ' +
                (active
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200')
              }
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">{current.blurb}</p>
    </div>
  )
}

export function FilesRagSettings(): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [folders, setFolders] = useState<IndexedFolder[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = async (): Promise<void> => {
    const next = await vs.filesRag.listFolders()
    setFolders(next)
  }

  useEffect(() => {
    void refresh()
    const unsubProgress = vs.events.onFilesRagProgress((p) => {
      setProgress(p && p.total > 0 ? p : null)
    })
    const unsubDone = vs.events.onFilesRagDone((result: ScanResult | null) => {
      setProgress(null)
      void refresh()
      if (!result) return
      if (result.error) {
        pushToast('error', `Scan failed: ${result.error}`)
        return
      }
      // Distinguish "nothing to index" from a real success. A zero-file walk
      // usually means the folder was unreadable or had no supported files —
      // the user wants a hint, not a fake "Indexed 0 file(s)" thumbs-up.
      if (result.filesScanned === 0) {
        pushToast('info', `No supported files found in ${result.folder}.`)
        return
      }
      pushToast(
        'success',
        `Indexed ${result.filesIndexed} new, ${result.filesSkipped} unchanged · ${result.chunksAdded} chunks.`
      )
    })
    return () => {
      unsubProgress()
      unsubDone()
    }
  }, [pushToast])

  const handleAdd = async (): Promise<void> => {
    setAdding(true)
    try {
      const result = await vs.filesRag.addFolder()
      if (result.ok && result.folder) {
        pushToast('info', `Indexing ${result.folder}…`)
      } else if (!result.ok && result.error) {
        // addFolder validates the path before registering; surface a
        // friendly prefix so the user knows nothing was indexed and what
        // went wrong (path not readable, already indexed, etc).
        pushToast('error', `Couldn't index folder — ${result.error}`)
      }
      setFolders(result.folders)
    } finally {
      setAdding(false)
    }
  }

  const handleRescanAll = async (): Promise<void> => {
    await vs.filesRag.rescanAll()
    pushToast('info', 'Rescanning all folders…')
  }

  return (
    <CollapsibleSection
      title="File Knowledge"
      hint="Folders VoidSoul has indexed for semantic recall. When RAG is on, relevant snippets are injected into chat automatically."
    >
      <div className="space-y-2">
        <EmbeddingProviderPicker />
        {progress && progress.total > 0 && (
          <div className="rounded-lg border border-[var(--accent-ring)]/40 bg-[var(--accent-soft)]/30 px-2.5 py-1.5">
            <div className="flex justify-between text-[10px] text-slate-300">
              <span>
                Scanning {progress.done}/{progress.total}
              </span>
              <span className="truncate pl-2 text-slate-500" title={progress.current}>
                {progress.current ? basename(progress.current) : '…'}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full bg-[var(--accent)] transition-all"
                style={{
                  width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                }}
              />
            </div>
          </div>
        )}

        {folders.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            No folders indexed yet. Add a folder (your UE5 project, a doc tree, a notes
            directory…) and VoidSoul will recall passages from it semantically when you
            ask.
          </p>
        ) : (
          <div className="space-y-1.5">
            {folders.map((f) => (
              <FolderRow key={f.path} folder={f} onChange={() => void refresh()} />
            ))}
            <p className="pt-1 text-[10px] text-slate-500">
              Total: {folders.reduce((sum, f) => sum + f.fileCount, 0)} file(s),{' '}
              {folders.reduce((sum, f) => sum + f.chunkCount, 0)} chunk(s) (~
              {formatBytes(
                folders.reduce((sum, f) => sum + f.chunkCount, 0) * 240
              )}{' '}
              of previews)
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={adding}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            <FolderPlus size={12} />
            Add folder
          </button>
          {folders.length > 0 && (
            <button
              type="button"
              onClick={() => void handleRescanAll()}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/5"
            >
              <RefreshCcw size={12} />
              Rescan all
            </button>
          )}
        </div>
      </div>
    </CollapsibleSection>
  )
}
