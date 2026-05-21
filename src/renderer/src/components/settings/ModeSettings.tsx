/**
 * Workflow-mode selector. Choosing a mode swaps its curated permission set,
 * quick actions, system-prompt fragment and accent colour.
 */
import { useConfigStore } from '../../store/useConfigStore'
import { MODES, getMode } from '@shared/modes'
import { CollapsibleSection } from './CollapsibleSection'
import type { ModeId } from '@shared/types'

export function ModeSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setActiveMode = useConfigStore((s) => s.setActiveMode)
  const setAppearance = useConfigStore((s) => s.setAppearance)
  if (!config) return null

  const mode = getMode(config.activeMode)

  return (
    <CollapsibleSection
      title="Workflow Mode"
      hint="Curated profiles — each bundles its own permissions, quick actions and assistant tone. Switch to match what you're doing."
    >
      <select
        value={config.activeMode}
        onChange={async (e) => {
          const next = getMode(e.target.value as ModeId)
          await setActiveMode(next.id)
          await setAppearance({ accent: next.accent })
        }}
        className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id} className="bg-void-700">
            {m.name} — {m.tagline}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[10px] text-slate-400">
        {mode.permissions.length} permissions · {mode.quickActions.length} quick actions in this mode.
      </p>
    </CollapsibleSection>
  )
}
