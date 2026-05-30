/**
 * Editor for the base system prompt every conversation inherits. Mode prompts
 * and long-term facts append below it; this is the canonical voice/policy
 * baseline the user controls.
 *
 * Uses the shared `useDraftField` hook so a config broadcast (e.g. the user
 * changes a different setting in the panel window) can't snap the textarea
 * back to the persisted value while they're mid-typing.
 *
 * v2.0 — added "Restore default" button distinct from "Reset". Reset only
 * reverts the unsaved draft to whatever is currently persisted; Restore
 * default loads the canonical DEFAULT_SYSTEM_PROMPT (shared/defaultPrompts.ts)
 * so pre-v2.0 users who customised their prompt (or even just persisted the
 * v1.x default text) can OPT-IN to the v2.0 capability-awareness block,
 * click_on_screen pipeline description, and semantic-awareness OCR rule
 * without uninstalling.
 */
import { CollapsibleSection } from './CollapsibleSection'
import { useConfigStore } from '../../store/useConfigStore'
import { useDraftField } from '../../lib/useDraftField'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/defaultPrompts'

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
  // The Restore button is offered whenever the persisted prompt has drifted
  // from the canonical default — covers both the customised case AND the
  // legacy v1.x default-text case (since that string differs from v2.0).
  const isAtDefault = prompt.value === DEFAULT_SYSTEM_PROMPT
  const canRestoreDefault = !isAtDefault

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
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {isDirty && (
          <>
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
              Reset draft
            </button>
          </>
        )}
        {canRestoreDefault && (
          <button
            type="button"
            title="Replace the prompt with the v2.0 default — gets you the latest capability awareness, click_on_screen pipeline, and semantic-awareness rules."
            onClick={() => {
              // Stages the canonical default into the draft so the user
              // can review it before Save. Save commits it. This is the
              // ONLY path that gives pre-v2.0 users the new prompt body
              // short of a full reinstall.
              prompt.onChange(DEFAULT_SYSTEM_PROMPT)
            }}
            className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-[11px] text-violet-200 transition hover:bg-violet-500/20"
          >
            Restore default
          </button>
        )}
      </div>
      {canRestoreDefault && !isDirty && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400">
          Your prompt differs from the current default. Restoring loads the v2.0 baseline
          (capability awareness, click_on_screen pipeline, semantic screen rules) — you can edit
          before saving.
        </p>
      )}
    </CollapsibleSection>
  )
}
