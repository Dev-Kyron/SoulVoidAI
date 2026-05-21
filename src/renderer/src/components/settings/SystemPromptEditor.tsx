/**
 * Editor for the base system prompt every conversation inherits. Mode prompts
 * and long-term facts append below it; this is the canonical voice/policy
 * baseline the user controls.
 *
 * Uses the shared `useDraftField` hook so a config broadcast (e.g. the user
 * changes a different setting in the panel window) can't snap the textarea
 * back to the persisted value while they're mid-typing.
 */
import { useState } from 'react'
import { CollapsibleSection } from './CollapsibleSection'
import { useConfigStore } from '../../store/useConfigStore'
import { useDraftField } from '../../lib/useDraftField'

export function SystemPromptEditor(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setSystemPrompt = useConfigStore((s) => s.setSystemPrompt)
  // `dirty` mirror in component state so the Save/Reset buttons appear at
  // the right moments. The hook owns the actual dirty bookkeeping; we just
  // observe value-divergence here for the UI affordance.
  const [showActions, setShowActions] = useState(false)

  const prompt = useDraftField<string>({
    source: config?.systemPrompt ?? '',
    // Trim on commit so trailing whitespace from a paste doesn't get saved.
    // The button onClicks below already trim; this debounce path mirrors them.
    commit: async (next) => {
      await setSystemPrompt(next.trim())
      setShowActions(false)
    },
    // System prompt edits are intentional, not character-by-character — give
    // the user a moment to settle before auto-saving so multi-paragraph
    // edits don't fire mid-thought.
    debounceMs: 800
  })

  if (!config) return null

  const isDirty = prompt.value !== config.systemPrompt
  // Show actions the moment the draft diverges from the persisted value, and
  // keep them visible while the user might still want to Reset.
  if (isDirty && !showActions) setShowActions(true)

  return (
    <CollapsibleSection
      title="System Prompt"
      hint="The base instructions the AI receives on every message. Sets its overall behaviour and tone."
    >
      <textarea
        value={prompt.value}
        rows={4}
        onChange={(e) => prompt.onChange(e.target.value)}
        onBlur={prompt.onBlur}
        className="scrollbar-void w-full resize-none rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] leading-relaxed text-slate-100 outline-none focus:border-[var(--accent-ring)]"
      />
      {showActions && isDirty && (
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={() => void setSystemPrompt(prompt.value.trim())}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            Save prompt
          </button>
          <button
            type="button"
            onClick={() => {
              prompt.onChange(config.systemPrompt)
              setShowActions(false)
            }}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/5"
          >
            Reset
          </button>
        </div>
      )}
    </CollapsibleSection>
  )
}
