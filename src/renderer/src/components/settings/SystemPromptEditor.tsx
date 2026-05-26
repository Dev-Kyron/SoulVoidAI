/**
 * Editor for the base system prompt every conversation inherits. Mode prompts
 * and long-term facts append below it; this is the canonical voice/policy
 * baseline the user controls.
 *
 * Uses the shared `useDraftField` hook so a config broadcast (e.g. the user
 * changes a different setting in the panel window) can't snap the textarea
 * back to the persisted value while they're mid-typing.
 */
import { CollapsibleSection } from './CollapsibleSection'
import { useConfigStore } from '../../store/useConfigStore'
import { useDraftField } from '../../lib/useDraftField'

export function SystemPromptEditor(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setSystemPrompt = useConfigStore((s) => s.setSystemPrompt)

  const prompt = useDraftField<string>({
    source: config?.systemPrompt ?? '',
    // Trim on commit so trailing whitespace from a paste doesn't get saved.
    // The button onClicks below already trim; this debounce path mirrors them.
    commit: async (next) => {
      await setSystemPrompt(next.trim())
    },
    // System prompt edits are intentional, not character-by-character — give
    // the user a moment to settle before auto-saving so multi-paragraph
    // edits don't fire mid-thought.
    debounceMs: 800
  })

  if (!config) return null

  // v1.12.7 — derived directly from value divergence instead of
  // mirrored to local state. Previous version did `setShowActions(true)`
  // during render which was a React rule-of-hooks violation (setState in
  // render path → React warning, double render).
  const isDirty = prompt.value !== config.systemPrompt
  const showActions = isDirty

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
              // Reverting the draft to the source value makes isDirty
              // false, which derives showActions back to false next
              // render — no setShowActions needed (v1.12.7 cleanup).
              prompt.onChange(config.systemPrompt)
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
