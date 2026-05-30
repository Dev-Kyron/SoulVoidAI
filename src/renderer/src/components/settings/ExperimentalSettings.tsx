/**
 * v2.0 — click_on_screen settings panel.
 *
 * Originally lived as "Experimental features" with a BETA banner; after
 * the Tier-S Phase 1-4 work + the massive polish sweep + the
 * hover-to-teach short-circuit, the feature graduated. This panel now
 * owns the click_on_screen knob, the strategy router pick, and the two
 * companion dialogs (taught-clicks + benchmark).
 *
 * Future experimental flags (when they appear) will live in their own
 * section so click_on_screen doesn't drag a BETA badge it no longer
 * deserves.
 */
import { useState } from 'react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { ClickBenchDialog } from './ClickBenchDialog'
import { TaughtClicksDialog } from './TaughtClicksDialog'
import { Beaker, GraduationCap, MousePointerClick } from 'lucide-react'
import type { ClickStrategyMode } from '@shared/types'

export function ExperimentalSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)
  const [benchOpen, setBenchOpen] = useState(false)
  const [taughtOpen, setTaughtOpen] = useState(false)
  if (!config) return null

  const features = config.experimentalFeatures

  const handleVisualClick = async (enabled: boolean): Promise<void> => {
    const next = await vs.config.setExperimentalFeatures({ visualClick: enabled })
    useConfigStore.setState({ config: next })
    pushToast(
      'success',
      enabled
        ? 'click_on_screen enabled — the AI can now click for you.'
        : 'click_on_screen disabled.'
    )
  }

  const handleStrategyChange = async (value: ClickStrategyMode): Promise<void> => {
    const next = await vs.config.setExperimentalFeatures({ clickStrategy: value })
    useConfigStore.setState({ config: next })
    pushToast(
      'success',
      value === 'auto'
        ? 'Strategy: auto — uses Sonnet computer-use when available.'
        : value === 'sonnet-computer-use'
          ? 'Strategy locked to Sonnet computer-use.'
          : 'Strategy locked to UIA → Vision baseline.'
    )
  }

  const currentStrategy = features.clickStrategy ?? 'auto'

  return (
    <CollapsibleSection
      title="click_on_screen"
      hint="Let the AI click UI elements you describe in plain English."
    >
      <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white">
              <MousePointerClick size={12} className="text-[var(--accent)]" />
              Enable click_on_screen
            </p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              Lets the AI click UI elements you describe in plain English ("send the message",
              "close this dialog"). Five-step pipeline: taught clicks → Sonnet computer-use → UIA
              match → UIA candidate pick → vision locate.
            </p>
          </div>
          <Toggle checked={features.visualClick} onChange={(v) => void handleVisualClick(v)} />
        </div>

        <div className="space-y-1 text-[10px] leading-relaxed text-slate-400">
          <p>
            <span className="font-semibold text-emerald-300">Works well:</span> native desktop apps
            with proper accessibility labels — Discord, Slack, Office, Settings, File Explorer, VS
            Code, anything with visible button text.
          </p>
          <p>
            <span className="font-semibold text-amber-300">Best-effort:</span> browser web content,
            icon-only buttons in busy UIs, custom-rendered canvases — Sonnet computer-use closes
            most of the gap when the active model supports it.
          </p>
          <p className="text-slate-500">
            Every click is preceded by a 3-second cancellable preview ring — press Esc to abort.
          </p>
        </div>

        {features.visualClick && (
          <>
            <div className="mt-3 rounded-md border border-white/5 bg-black/30 px-2.5 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Strategy
              </p>
              <select
                value={currentStrategy}
                onChange={(e) => void handleStrategyChange(e.target.value as ClickStrategyMode)}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
              >
                <option value="auto" className="bg-void-700">
                  Auto — Sonnet computer-use on capable models, baseline otherwise
                </option>
                <option value="uia-then-vision" className="bg-void-700">
                  UIA → Vision (baseline — works with any provider)
                </option>
                <option value="sonnet-computer-use" className="bg-void-700">
                  Sonnet computer-use only (needs Anthropic + Sonnet 3.5+)
                </option>
              </select>
              <p className="mt-1 text-[10px] text-slate-500">
                Native computer-use was post-trained on grounded UI clicks — wins on browser content
                and icon-only buttons. The bench harness scores all engines head-to-head against
                your captured ground truth.
              </p>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setTaughtOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-[10px] text-slate-300 transition hover:bg-white/5"
              >
                <GraduationCap size={11} className="text-[var(--accent)]" />
                Teach a click
              </button>
              <button
                type="button"
                onClick={() => setBenchOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-[10px] text-slate-300 transition hover:bg-white/5"
              >
                <Beaker size={11} className="text-[var(--accent)]" />
                Benchmark harness
              </button>
            </div>
          </>
        )}
      </div>

      {benchOpen && <ClickBenchDialog onClose={() => setBenchOpen(false)} />}
      {taughtOpen && <TaughtClicksDialog onClose={() => setTaughtOpen(false)} />}
    </CollapsibleSection>
  )
}
