/**
 * Settings panel for persona templates (v2.0).
 *
 * Persona templates are sharable presets — system prompt + recommended
 * model + sample prompts — that the user can APPLY to a thread. They
 * layer on top of the 6 built-in MODES rather than replacing them.
 *
 * Surface:
 *   · Built-in modes (read-only) — each has an Export button so users
 *     can grab "Researcher" or "Indie Dev" as a starting point and
 *     edit the JSON before sharing.
 *   · Custom personas (CRUD) — Import / Export / Delete / Apply-to-
 *     current-thread. Imports come from `.voidsoul-persona.json` files
 *     a friend (or future community gallery) shared.
 *
 * Apply-to-thread sets the thread's `pinnedSystemPrompt` to the
 * persona's prompt + (if `baseMode` is set) pinnedMode. Uses the
 * existing per-thread override IPC channels — no new chat-side
 * plumbing needed.
 */
import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Download, Loader2, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { vs } from '../../lib/bridge'
import { useConfigStore } from '../../store/useConfigStore'
import { useChatStore } from '../../store/useChatStore'
import { useUiStore } from '../../store/useUiStore'
import { MODES } from '@shared/modes'
import {
  bundleFilename,
  bundleToTemplate,
  builtInModeToBundle,
  toPersonaBundle
} from '@shared/personas'
import { cn } from '../../lib/utils'
import type { ModeId, PersonaTemplate } from '@shared/types'

export function PersonaSettings(): JSX.Element {
  const config = useConfigStore((s) => s.config)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threads = useChatStore((s) => s.threads)
  const pushToast = useUiStore((s) => s.pushToast)
  const [busyId, setBusyId] = useState<string | null>(null)

  const customs = config?.customPersonas ?? []
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  )

  // Persists the post-mutation config the main returns so the renderer
  // doesn't have to round-trip through reload() to see new imports /
  // deletions land in the UI immediately.
  const setConfig = useConfigStore.setState
  const acceptUpdatedConfig = useCallback(
    (next: import('@shared/types').ClientConfig) => {
      setConfig({ config: next })
    },
    [setConfig]
  )

  const handleExport = async (
    bundleSource: PersonaTemplate | ModeId,
    label: string
  ): Promise<void> => {
    const bundle =
      typeof bundleSource === 'string'
        ? builtInModeToBundle(MODES.find((m) => m.id === bundleSource)!)
        : toPersonaBundle(bundleSource)
    const filename = bundleFilename(bundle)
    // v2.0 polish — wrap the IPC call so disk-full / permission-denied /
    // user-AV-blocking-write failures don't reject unhandled. The handler
    // returns `{ ok: false }` on user-cancel; only real throws land here.
    try {
      const result = await vs.personas.exportToFile(bundle, filename)
      if (result.ok) {
        pushToast('success', `Exported ${label} → ${result.path}`)
      }
      // ok=false = user cancelled; no toast needed.
    } catch (err) {
      pushToast('error', `Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleImport = async (): Promise<void> => {
    const result = await vs.personas.importFromFile()
    if (!result.ok) {
      if (result.reason === 'invalid') {
        pushToast(
          'error',
          `That file isn't a valid VoidSoul persona bundle${result.message ? ` (${result.message})` : ''}.`
        )
      }
      return
    }
    const template = bundleToTemplate(result.bundle)
    const updated = await vs.personas.upsert(template)
    acceptUpdatedConfig(updated)
    pushToast('success', `Imported "${template.name}".`)
  }

  const handleDelete = async (persona: PersonaTemplate): Promise<void> => {
    if (!window.confirm(`Delete persona "${persona.name}"? This can't be undone.`)) return
    setBusyId(persona.id)
    try {
      const updated = await vs.personas.remove(persona.id)
      acceptUpdatedConfig(updated)
      pushToast('info', `Deleted "${persona.name}".`)
    } catch (err) {
      // v2.0 polish — surface delete failures (config write error,
      // permissions). Previously the catch was absent and a rejected
      // promise would leave the row visible with no user feedback.
      pushToast('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleApply = async (persona: PersonaTemplate): Promise<void> => {
    if (!activeThread) {
      pushToast('error', 'Open a thread first — persona templates apply per-thread, not globally.')
      return
    }
    setBusyId(persona.id)
    try {
      const store = useChatStore.getState()
      // Use the chat store's actions (not vs.history directly) so the
      // thread list refresh happens inside the store and the header
      // chip surfaces the new override immediately. The two writes are
      // independent (one sets pinnedSystemPrompt, the other pinnedMode)
      // so we fire them in parallel — saves an IPC round-trip on Apply
      // and the store reconciles both updates into the next thread row.
      const tasks: Array<Promise<unknown>> = [
        store.setThreadSystemPrompt(activeThread.id, persona.prompt)
      ]
      if (persona.baseMode) {
        tasks.push(store.setThreadMode(activeThread.id, persona.baseMode))
      }
      await Promise.all(tasks)
      pushToast(
        'success',
        `Applied "${persona.name}" to ${activeThread.title || 'this thread'}.` +
          (persona.recommendedModel ? ` Author recommends ${persona.recommendedModel}.` : '')
      )
    } catch (err) {
      pushToast('error', `Apply failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyId(null)
    }
  }

  if (!config) return <></>

  return (
    <CollapsibleSection
      title="Personas"
      hint="Sharable presets of system prompt + recommended model + sample prompts. Apply to a thread to set its tone; export to share; import to install."
    >
      <div className="space-y-2">
        {/* Header actions — Import is the primary, Reload after import. */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleImport()}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            <Upload size={11} />
            Import persona
          </button>
          {!activeThread && (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-200">
              <AlertTriangle size={9} />
              Open a thread to apply
            </span>
          )}
        </div>

        {/* Custom personas — only visible when the user has any. */}
        {customs.length > 0 && (
          <div className="space-y-1">
            <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Your personas
            </p>
            {customs.map((persona) => (
              <PersonaRow
                key={persona.id}
                title={persona.name}
                subtitle={
                  persona.tagline ||
                  (persona.recommendedModel ? `Recommends ${persona.recommendedModel}` : '')
                }
                detail={persona.createdBy ? `by ${persona.createdBy}` : ''}
                samples={persona.samplePrompts}
                busy={busyId === persona.id}
                primaryLabel="Apply to thread"
                primaryIcon={<Wand2 size={11} />}
                onPrimary={activeThread ? (): Promise<void> => handleApply(persona) : undefined}
                onExport={(): Promise<void> => handleExport(persona, persona.name)}
                onDelete={(): Promise<void> => handleDelete(persona)}
              />
            ))}
          </div>
        )}

        {/* Built-in modes — exportable starting points. */}
        <div className="space-y-1">
          <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Built-in modes
          </p>
          {MODES.map((mode) => (
            <PersonaRow
              key={mode.id}
              title={mode.name}
              subtitle={mode.tagline}
              detail="Built-in"
              onExport={(): Promise<void> => handleExport(mode.id, mode.name)}
            />
          ))}
        </div>
      </div>
    </CollapsibleSection>
  )
}

/* ---------------------------------- row ---------------------------------- */

function PersonaRow({
  title,
  subtitle,
  detail,
  samples,
  busy,
  primaryLabel,
  primaryIcon,
  onPrimary,
  onExport,
  onDelete
}: {
  title: string
  subtitle?: string
  detail?: string
  samples?: string[]
  busy?: boolean
  primaryLabel?: string
  primaryIcon?: JSX.Element
  onPrimary?: () => Promise<void>
  onExport: () => Promise<void>
  onDelete?: () => Promise<void>
}): JSX.Element {
  return (
    <div className="glass-soft rounded-lg p-2.5">
      <div className="flex items-start gap-2">
        <Sparkles size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold text-slate-100">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-[10px] text-slate-400">{subtitle}</p>}
          {detail && <p className="mt-0.5 text-[9px] text-slate-500">{detail}</p>}
          {samples && samples.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {samples.slice(0, 4).map((sample, i) => (
                <span
                  key={i}
                  className="truncate rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-400"
                  title={sample}
                >
                  {sample.length > 32 ? `${sample.slice(0, 32)}…` : sample}
                </span>
              ))}
              {samples.length > 4 && (
                <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-500">
                  +{samples.length - 4} more
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onPrimary && (
            <button
              type="button"
              onClick={() => void onPrimary()}
              disabled={busy}
              className={cn(
                'flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)] transition hover:brightness-125 disabled:opacity-40'
              )}
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : primaryIcon}
              {primaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onExport()}
            title="Export this persona to a .voidsoul-persona.json file"
            aria-label={`Export persona ${title}`}
            className="rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <Download size={11} />
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={busy}
              title="Delete this persona — can't be undone"
              aria-label={`Delete persona ${title}`}
              className="rounded-md p-1 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
