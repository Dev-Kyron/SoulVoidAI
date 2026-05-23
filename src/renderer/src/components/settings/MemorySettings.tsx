/**
 * Memory manager: reusable custom prompts, favourite apps (quick-launch) and
 * recently opened project folders.
 */
import { useEffect, useState } from 'react'
import {
  Plus,
  Play,
  Trash2,
  Download,
  FolderGit2,
  Sparkles,
  AppWindow,
  Brain,
  Pencil,
  Check,
  MessageSquarePlus,
  Heart
} from 'lucide-react'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useChatStore } from '../../store/useChatStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useWidgetStore } from '../../store/useWidgetStore'
import { useUiStore } from '../../store/useUiStore'
import { runAction } from '../../lib/actions'
import { resolveIcon } from '../../lib/icons'
import { vs } from '../../lib/bridge'
import { cn, relativeTime } from '../../lib/utils'
import { SectionLabel, Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { MODES } from '@shared/modes'
import type {
  CustomActionKind,
  EmotionalContextSnapshot,
  ModeId
} from '@shared/types'

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

const ADD_BUTTON =
  'flex items-center justify-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40'

/** Mirrors the cap in main/services/storage/memory.ts. Surfaces capacity in the UI. */
const MAX_FACTS = 50

/** Toggle row of mode chips — selected ⇒ fact is scoped to those modes. */
function ModeChips({
  selected,
  onToggle
}: {
  selected: ModeId[]
  onToggle: (mode: ModeId) => void
}): JSX.Element {
  const selectedSet = new Set(selected)
  const global = selected.length === 0
  return (
    <div className="flex flex-wrap items-center gap-1">
      {MODES.map((mode) => {
        const active = selectedSet.has(mode.id)
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onToggle(mode.id)}
            title={
              active ? `Scoped to ${mode.name}` : `Add ${mode.name} to this fact's scope`
            }
            className={cn(
              'rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide transition',
              active
                ? 'border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-white/10 text-slate-500 hover:border-white/25 hover:text-slate-300'
            )}
          >
            {mode.name}
          </button>
        )
      })}
      <span
        className={cn(
          'ml-1 text-[9px] italic',
          global ? 'text-slate-400' : 'text-slate-600'
        )}
      >
        {global ? 'all modes' : `${selected.length}/${MODES.length} mode${selected.length === 1 ? '' : 's'}`}
      </span>
    </div>
  )
}

function AssistantFacts(): JSX.Element {
  const facts = useMemoryStore((s) => s.data?.facts ?? [])
  const addFact = useMemoryStore((s) => s.addFact)
  const updateFact = useMemoryStore((s) => s.updateFact)
  const setFactModes = useMemoryStore((s) => s.setFactModes)
  const removeFact = useMemoryStore((s) => s.removeFact)
  const clearFacts = useMemoryStore((s) => s.clearFacts)
  const autoMemory = useConfigStore((s) => s.config?.chat.autoMemory ?? true)
  const setAutoMemory = useConfigStore((s) => s.setAutoMemory)
  const [text, setText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [newFactModes, setNewFactModes] = useState<ModeId[]>([])

  const submit = async (): Promise<void> => {
    if (!text.trim()) return
    await addFact(text.trim(), newFactModes.length ? newFactModes : undefined)
    setText('')
    setNewFactModes([])
  }

  const toggleNewMode = (mode: ModeId): void => {
    setNewFactModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]
    )
  }

  const toggleFactMode = (factId: string, currentModes: ModeId[] | undefined, mode: ModeId): void => {
    const current = currentModes ?? []
    const next = current.includes(mode)
      ? current.filter((m) => m !== mode)
      : [...current, mode]
    void setFactModes(factId, next)
  }

  const startEdit = (id: string, current: string): void => {
    setEditingId(id)
    setEditText(current)
  }

  const commitEdit = async (): Promise<void> => {
    if (!editingId) return
    const id = editingId
    const trimmed = editText.trim()
    setEditingId(null)
    if (trimmed) await updateFact(id, trimmed)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setEditText('')
  }

  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <SectionLabel hint="Durable facts VoidSoul keeps in mind across every conversation. Pulled in automatically after each reply, and editable here. Older facts drop out when the cap is hit.">
            Things VoidSoul Remembers
          </SectionLabel>
          <p className="mt-0.5 text-[9px] text-slate-500">
            {facts.length}/{MAX_FACTS} stored
            {facts.length >= MAX_FACTS && ' · oldest will be dropped'}
          </p>
        </div>
        {facts.length > 0 && (
          <button
            type="button"
            onClick={() => void clearFacts()}
            title="Forget every long-term memory"
            className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[10px] font-semibold text-slate-400 transition hover:border-rose-400/40 hover:text-rose-400"
          >
            <Trash2 size={11} />
            Forget all
          </button>
        )}
      </div>
      <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
        <div className="min-w-0">
          <p className="text-[11px] text-slate-200">Auto-remember</p>
          <p className="text-[9px] text-slate-500">
            After each reply, ask the model to extract durable facts (~one small extra call).
          </p>
        </div>
        <Toggle checked={autoMemory} onChange={(value) => void setAutoMemory(value)} />
      </div>
      <div className="space-y-1.5">
        {facts.length === 0 && (
          <p className="text-[10px] text-slate-500">
            No long-term memories yet — VoidSoul will fill this in as you chat. You can also add
            your own below.
          </p>
        )}
        {facts.map((fact) => {
          const editing = editingId === fact.id
          return (
            <div
              key={fact.id}
              className="glass-soft flex items-start gap-2 rounded-lg px-2.5 py-1.5"
            >
              <Brain size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                {editing ? (
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEdit()
                      }
                    }}
                    className="w-full rounded border border-[var(--accent-ring)] bg-black/40 px-1.5 py-0.5 text-[11px] text-white outline-none"
                  />
                ) : (
                  <p
                    className="cursor-text text-[11px] leading-snug text-slate-200"
                    onDoubleClick={() => startEdit(fact.id, fact.text)}
                    title="Double-click to edit"
                  >
                    {fact.text}
                  </p>
                )}
                <p className="mt-0.5 text-[9px] text-slate-500">
                  learned {relativeTime(fact.createdAt)}
                  {fact.updatedAt !== fact.createdAt && ` · edited ${relativeTime(fact.updatedAt)}`}
                </p>
                <div className="mt-1">
                  <ModeChips
                    selected={fact.modes ?? []}
                    onToggle={(mode) => toggleFactMode(fact.id, fact.modes, mode)}
                  />
                </div>
              </div>
              {editing ? (
                <button
                  type="button"
                  onClick={() => void commitEdit()}
                  title="Save"
                  className="shrink-0 text-[var(--accent)] transition hover:brightness-125"
                >
                  <Check size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(fact.id, fact.text)}
                  title="Edit"
                  className="shrink-0 text-slate-500 transition hover:text-[var(--accent)]"
                >
                  <Pencil size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={() => void removeFact(fact.id)}
                title="Forget this"
                className="shrink-0 text-slate-500 transition hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 space-y-1.5">
        <div className="flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="Add a fact (e.g. 'prefers concise replies')"
            className={`${FIELD} flex-1`}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim()}
            className={ADD_BUTTON}
          >
            <Plus size={12} />
            Remember
          </button>
        </div>
        <ModeChips selected={newFactModes} onToggle={toggleNewMode} />
      </div>
    </section>
  )
}

interface RagStatusShape {
  available: boolean
  indexed: number
  backfill?: { done: number; total: number }
}

function LongTermRecall(): JSX.Element {
  const ragEnabled = useConfigStore((s) => s.config?.chat.rag ?? false)
  const setRagEnabled = useConfigStore((s) => s.setRagEnabled)
  const pushToast = useUiStore((s) => s.pushToast)
  const [status, setStatus] = useState<RagStatusShape>({ available: false, indexed: 0 })
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setStatus(await vs.rag.status())
  }

  useEffect(() => {
    void refresh()
  }, [])

  // While a backfill is running, poll the status every 600ms so the user
  // sees "indexed N of M…" instead of a silent spinner.
  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(() => void refresh(), 600)
    return () => window.clearInterval(id)
  }, [busy])

  const handleBackfill = async (): Promise<void> => {
    if (!status.available) {
      pushToast(
        'error',
        'Add an OpenAI key (or run Ollama with nomic-embed-text) — embeddings need a provider.'
      )
      return
    }
    setBusy(true)
    const added = await vs.rag.backfill()
    setBusy(false)
    await refresh()
    pushToast(
      added > 0 ? 'success' : 'info',
      added > 0
        ? `Indexed ${added} message${added === 1 ? '' : 's'} for recall.`
        : 'Everything is already indexed.'
    )
  }

  const handleClear = async (): Promise<void> => {
    setBusy(true)
    await vs.rag.clear()
    setBusy(false)
    await refresh()
    pushToast('info', 'Embedding index cleared.')
  }

  const progress = status.backfill
  const progressPct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null

  return (
    <section>
      <SectionLabel hint="Embed every chat message so VoidSoul can recall older conversations on demand. Uses OpenAI's text-embedding-3-small (cheap — fractions of a cent per thousand messages).">
        Long-term Recall (RAG)
      </SectionLabel>
      <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
        <div className="min-w-0">
          <p className="text-[11px] text-slate-200">Recall older conversations</p>
          <p className="text-[9px] text-slate-500">
            On each send, retrieve the most relevant past snippets and add them to context.
          </p>
        </div>
        <Toggle checked={ragEnabled} onChange={(v) => void setRagEnabled(v)} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[10px] text-slate-400">
        <span>
          {status.indexed.toLocaleString()} message{status.indexed === 1 ? '' : 's'} indexed
        </span>
        {!status.available && (
          <span className="text-amber-400">Needs OpenAI or Ollama</span>
        )}
      </div>
      {progress && (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
          <div className="flex justify-between text-[9px] text-slate-400">
            <span>
              Indexing {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
            </span>
            <span>{progressPct ?? 0}%</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{ width: `${progressPct ?? 0}%` }}
            />
          </div>
        </div>
      )}
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          onClick={() => void handleBackfill()}
          disabled={busy || !status.available}
          className={ADD_BUTTON}
        >
          <Brain size={12} />
          {busy ? `Indexing ${progress?.done ?? 0}/${progress?.total ?? 0}…` : 'Index everything'}
        </button>
        {status.indexed > 0 && (
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 transition hover:border-rose-400/40 hover:text-rose-400 disabled:opacity-40"
          >
            <Trash2 size={11} />
            Clear index
          </button>
        )}
      </div>
    </section>
  )
}

function CustomPrompts(): JSX.Element {
  const prompts = useMemoryStore((s) => s.data?.customPrompts ?? [])
  const addPrompt = useMemoryStore((s) => s.addPrompt)
  const removePrompt = useMemoryStore((s) => s.removePrompt)
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')

  const submit = async (): Promise<void> => {
    if (!label.trim() || !text.trim()) return
    await addPrompt(label.trim(), text.trim())
    setLabel('')
    setText('')
  }

  return (
    <section>
      <SectionLabel hint="Reusable prompt snippets. Insert one into chat with its button, or manage them here.">
        Custom Prompts
      </SectionLabel>
      <div className="space-y-1.5">
        {prompts.length === 0 && (
          <p className="text-[10px] text-slate-500">No saved prompts — add reusable instructions below.</p>
        )}
        {prompts.map((prompt) => (
          <div key={prompt.id} className="glass-soft flex items-start gap-2 rounded-lg px-2.5 py-1.5">
            <Sparkles size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-white">{prompt.label}</p>
              <p className="truncate text-[10px] text-slate-400">{prompt.prompt}</p>
            </div>
            <button
              type="button"
              title="Insert into chat"
              onClick={() => {
                useChatStore.getState().requestInsert(prompt.prompt)
                useWidgetStore.getState().setTab('chat')
              }}
              className="shrink-0 text-slate-400 transition hover:text-[var(--accent)]"
            >
              <MessageSquarePlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => void removePrompt(prompt.id)}
              className="shrink-0 text-slate-500 transition hover:text-rose-400"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 space-y-1.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Prompt name"
          className={FIELD}
        />
        <textarea
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder="Prompt text — insert it into chat from the composer"
          className={`${FIELD} resize-none`}
        />
        <button type="button" onClick={() => void submit()} disabled={!label.trim() || !text.trim()} className={ADD_BUTTON}>
          <Plus size={12} />
          Save prompt
        </button>
      </div>
    </section>
  )
}

function FavoriteApps(): JSX.Element {
  const apps = useMemoryStore((s) => s.data?.favoriteApps ?? [])
  const addFavorite = useMemoryStore((s) => s.addFavorite)
  const removeFavorite = useMemoryStore((s) => s.removeFavorite)
  const importTaskbar = useMemoryStore((s) => s.importTaskbar)
  const pushToast = useUiStore((s) => s.pushToast)
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')

  const submit = async (): Promise<void> => {
    if (!label.trim() || !target.trim()) return
    await addFavorite(label.trim(), target.trim())
    setLabel('')
    setTarget('')
  }

  const handleImport = async (): Promise<void> => {
    const added = await importTaskbar()
    pushToast(
      added > 0 ? 'success' : 'info',
      added > 0
        ? `Imported ${added} app${added === 1 ? '' : 's'} from the taskbar.`
        : 'No new taskbar apps to import.'
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel hint="Apps you pin for one-click launch. Import them straight from your Windows taskbar.">
          Favourite Apps
        </SectionLabel>
        <button
          type="button"
          onClick={() => void handleImport()}
          title="Import apps pinned to your Windows taskbar"
          className="flex items-center gap-1.5 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2.5 py-1 text-[10px] font-semibold text-[var(--accent)] shadow-glow transition hover:bg-[var(--accent)] hover:text-white"
        >
          <Download size={12} />
          Import taskbar
        </button>
      </div>
      <div className="space-y-1.5">
        {apps.length === 0 && (
          <p className="text-[10px] text-slate-500">
            Pin apps by name or path — e.g. <span className="text-slate-400">code</span>,{' '}
            <span className="text-slate-400">notepad</span>.
          </p>
        )}
        {apps.map((app) => (
          <div key={app.id} className="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-1.5">
            <AppWindow size={12} className="shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-white">{app.label}</p>
              <p className="truncate text-[10px] text-slate-400">{app.target}</p>
            </div>
            <button
              type="button"
              onClick={() => void runAction({ type: 'open-app', params: { app: app.target } }, app.label)}
              title="Launch"
              className="shrink-0 text-slate-400 transition hover:text-[var(--accent)]"
            >
              <Play size={12} />
            </button>
            <button
              type="button"
              onClick={() => void removeFavorite(app.id)}
              className="shrink-0 text-slate-500 transition hover:text-rose-400"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name"
          className={`${FIELD} flex-1`}
        />
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="App name or path"
          className={`${FIELD} flex-[1.4]`}
        />
        <button type="button" onClick={() => void submit()} disabled={!label.trim() || !target.trim()} className={ADD_BUTTON}>
          <Plus size={12} />
        </button>
      </div>
    </section>
  )
}

function RecentProjects(): JSX.Element {
  const projects = useMemoryStore((s) => s.data?.recentProjects ?? [])
  const rememberProject = useMemoryStore((s) => s.rememberProject)
  const forgetProject = useMemoryStore((s) => s.forgetProject)

  const pin = async (): Promise<void> => {
    const path = await vs.system.pickFolder()
    if (path) await rememberProject(path)
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel hint="Folders you open are remembered here so you can jump back into a project fast.">
          Recent Projects
        </SectionLabel>
        <button
          type="button"
          onClick={() => void pin()}
          className="flex items-center gap-1 text-[10px] text-slate-400 transition hover:text-white"
        >
          <Plus size={11} />
          Pin folder
        </button>
      </div>
      <div className="space-y-1.5">
        {projects.length === 0 && (
          <p className="text-[10px] text-slate-500">
            Folders you open are remembered here automatically.
          </p>
        )}
        {projects.map((project) => (
          <div
            key={project.path}
            className="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-1.5"
          >
            <FolderGit2 size={12} className="shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-white">{project.name}</p>
              <p className="truncate text-[10px] text-slate-400">{project.path}</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                await runAction({ type: 'open-folder', params: { dir: project.path } }, project.name)
                await rememberProject(project.path)
              }}
              title="Open folder"
              className="shrink-0 text-slate-400 transition hover:text-[var(--accent)]"
            >
              <Play size={12} />
            </button>
            <button
              type="button"
              onClick={() => void forgetProject(project.path)}
              className="shrink-0 text-slate-500 transition hover:text-rose-400"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function NexusActions(): JSX.Element {
  const actions = useMemoryStore((s) => s.data?.customActions ?? [])
  const addAction = useMemoryStore((s) => s.addAction)
  const removeAction = useMemoryStore((s) => s.removeAction)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<CustomActionKind>('app')
  const [target, setTarget] = useState('')

  const full = actions.length >= 8
  const placeholder =
    kind === 'app' ? 'App name or path' : kind === 'url' ? 'https://…' : 'Folder path or ~downloads'

  const submit = async (): Promise<void> => {
    if (full || !label.trim() || !target.trim()) return
    await addAction(label.trim(), kind, target.trim())
    setLabel('')
    setTarget('')
  }

  return (
    <section>
      <SectionLabel hint="Your own one-click actions on the Nexus orbit — launch an app, open a website or a folder. The circle holds up to 8 (mode actions counted).">
        Nexus Actions
      </SectionLabel>
      <div className="space-y-1.5">
        {actions.length === 0 && (
          <p className="text-[10px] text-slate-500">
            Add your own shortcuts to the Nexus circle.
          </p>
        )}
        {actions.map((action) => {
          const Icon = resolveIcon(action.icon)
          const value = String(Object.values(action.action.params)[0] ?? '')
          return (
            <div
              key={action.id}
              className="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-1.5"
            >
              <Icon size={12} className="shrink-0 text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-white">{action.label}</p>
                <p className="truncate text-[10px] text-slate-400">{value}</p>
              </div>
              <button
                type="button"
                onClick={() => void runAction(action.action, action.label)}
                title="Run"
                className="shrink-0 text-slate-400 transition hover:text-[var(--accent)]"
              >
                <Play size={12} />
              </button>
              <button
                type="button"
                onClick={() => void removeAction(action.id)}
                className="shrink-0 text-slate-500 transition hover:text-rose-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>
      {full ? (
        <p className="mt-1.5 text-[10px] text-amber-400">The Nexus circle is full (8 actions).</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Action name"
            className={FIELD}
          />
          <div className="flex gap-1.5">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as CustomActionKind)}
              className={`${FIELD} w-[88px]`}
            >
              <option value="app" className="bg-void-700">
                App
              </option>
              <option value="url" className="bg-void-700">
                Website
              </option>
              <option value="folder" className="bg-void-700">
                Folder
              </option>
            </select>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={placeholder}
              className={`${FIELD} flex-1`}
            />
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!label.trim() || !target.trim()}
            className={ADD_BUTTON}
          >
            <Plus size={12} />
            Add to Nexus
          </button>
        </div>
      )}
    </section>
  )
}

type MemoryTab = 'memory' | 'actions' | 'workspace'

const MEMORY_TABS: Array<{ id: MemoryTab; label: string; hint: string }> = [
  { id: 'memory', label: 'AI Memory', hint: 'What VoidSoul remembers about you' },
  { id: 'actions', label: 'Quick Actions', hint: 'Custom shortcuts and reusable prompts' },
  { id: 'workspace', label: 'Workspace', hint: 'Favourite apps and recent project folders' }
]

/**
 * v1.4.0 emotional context — surfaces the sentiment classifier state
 * + master toggle + privacy "forget" button.
 *
 * The classifier itself runs in the main process; this panel is purely
 * UI on top of three IPC calls (snapshot, config setter, forget). The
 * subsystem is opt-in by capability — it silently skips when no usable
 * provider is reachable, so flipping the toggle off explicitly means
 * "I want no sentiment data, even if you could collect it."
 */
function EmotionalContext(): JSX.Element {
  const config = useConfigStore((s) => s.config)
  const setMemory = useConfigStore((s) => s.setMemory)
  const pushToast = useUiStore((s) => s.pushToast)
  const [snapshot, setSnapshot] = useState<EmotionalContextSnapshot | null>(null)
  const [forgetting, setForgetting] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      const snap = await vs.memory.emotionalContext()
      setSnapshot(snap)
    } catch {
      setSnapshot(null)
    }
  }

  useEffect(() => {
    void refresh()
    // 60-second refresh while the panel is open — the classifier may
    // fire in the background and we want the user to see the new state
    // without leaving the Settings tab.
    const id = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(id)
  }, [])

  if (!config) return <></>

  const enabled = config.memory.emotionalContext
  const current = snapshot?.current

  const handleToggle = async (next: boolean): Promise<void> => {
    await setMemory({ emotionalContext: next })
  }

  const handleForget = async (): Promise<void> => {
    if (forgetting) return
    setForgetting(true)
    try {
      const result = await vs.memory.forgetRecentSentiment(7)
      pushToast(
        'success',
        result.deleted === 0
          ? 'No sentiment history to forget — already clean.'
          : `Forgot ${result.deleted} sentiment row${result.deleted === 1 ? '' : 's'} from the last 7 days.`
      )
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushToast('error', `Forget failed: ${msg}`)
    } finally {
      setForgetting(false)
    }
  }

  return (
    <div>
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <Heart size={11} />
          Emotional context
        </span>
      </SectionLabel>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
        VoidSoul periodically reads recent exchanges through a small fast
        model to track session mood (stressed / productive / stuck /
        excited / neutral). The result is added as soft context to the
        system prompt so she can adapt tone — never quoted back to you
        verbatim. Stored locally in the same SQLite as everything else;
        nothing leaves your machine except the classifier call itself,
        which goes through your active AI provider.
      </p>

      <div className="mt-2 flex items-center justify-between rounded-lg border border-white/5 bg-black/20 px-2.5 py-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-200">Enable sentiment</p>
          <p className="text-[10px] text-slate-500">
            Off = no extra model calls, no sentiment context in the prompt.
          </p>
        </div>
        <Toggle checked={enabled} onChange={(v) => void handleToggle(v)} />
      </div>

      {enabled && (
        <>
          <div className="mt-2 rounded-lg border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Current session
            </p>
            {current ? (
              <>
                <p className="mt-0.5 text-[12px] font-semibold text-white">
                  {current.sentiment}{' '}
                  <span className="text-[10px] font-normal text-slate-400">
                    (intensity {current.intensity}/5)
                  </span>
                </p>
                {current.summary && (
                  <p className="mt-0.5 text-[10px] italic text-slate-300">
                    "{current.summary}"
                  </p>
                )}
                <p className="mt-1 text-[9px] text-slate-500">
                  Computed {relativeTime(current.computedAt)}
                </p>
              </>
            ) : (
              <p className="mt-0.5 text-[10px] text-slate-400">
                No sentiment classified yet — send a few messages and check back.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleForget()}
            disabled={forgetting}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2 py-1.5 text-[11px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
          >
            <Trash2 size={11} />
            {forgetting ? 'Forgetting…' : 'Forget last 7 days of emotional context'}
          </button>
        </>
      )}
    </div>
  )
}

export function MemorySettings(): JSX.Element {
  const load = useMemoryStore((s) => s.load)
  const [tab, setTab] = useState<MemoryTab>('memory')
  useEffect(() => {
    void load()
  }, [load])

  return (
    <CollapsibleSection
      title="Memory"
      hint="What VoidSoul remembers — facts, recall, Nexus actions, reusable prompts, favourite apps and recent projects."
    >
      <div className="mb-3 flex gap-1 rounded-lg border border-white/10 bg-black/20 p-0.5">
        {MEMORY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            title={t.hint}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition',
              tab === t.id
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="space-y-5">
        {tab === 'memory' && (
          <>
            <AssistantFacts />
            <EmotionalContext />
            <LongTermRecall />
          </>
        )}
        {tab === 'actions' && (
          <>
            <NexusActions />
            <CustomPrompts />
          </>
        )}
        {tab === 'workspace' && (
          <>
            <FavoriteApps />
            <RecentProjects />
          </>
        )}
      </div>
    </CollapsibleSection>
  )
}
