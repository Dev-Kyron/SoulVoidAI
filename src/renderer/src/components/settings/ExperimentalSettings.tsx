/**
 * v1.10.1 — Experimental feature gates.
 *
 * Soft beta toggles for capabilities that are functional but not yet
 * reliable enough to ship to everyone. Off by default; user opts in
 * with explicit "we know this is rough" copy so expectations are set
 * honestly upfront. When a flag is off, the corresponding tool is
 * filtered out of TOOL_SPECS at compose time so the AI literally can't
 * call it — it's not just hidden in the UI, it's truly disabled.
 *
 * Each entry should call out:
 *   · What works
 *   · What doesn't (the actual failure modes from beta testing)
 *   · What we're waiting for before promoting it out of experimental
 */
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { FlaskConical } from 'lucide-react'

export function ExperimentalSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const pushToast = useUiStore((s) => s.pushToast)
  if (!config) return null

  const features = config.experimentalFeatures

  const handleVisualClick = async (enabled: boolean): Promise<void> => {
    const next = await vs.config.setExperimentalFeatures({ visualClick: enabled })
    useConfigStore.setState({ config: next })
    pushToast(
      enabled ? 'info' : 'success',
      enabled
        ? 'click_on_screen enabled. Heads up — accuracy varies by app and model.'
        : 'click_on_screen disabled. The AI can no longer call it.'
    )
  }

  return (
    <CollapsibleSection
      title="Experimental features"
      hint="Beta capabilities that work but aren't reliable enough to recommend universally."
    >
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
        <FlaskConical size={12} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">These features are in active development.</p>
          <p className="mt-0.5 text-[10px] text-amber-300/80">
            Reliability varies by app, model, and your specific setup. Enable to
            try them — disable any time. The AI only sees enabled features.
          </p>
        </div>
      </div>

      {/* click_on_screen — vision/UIA-driven click */}
      <div className="mb-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
        <div className="mb-1.5 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-white">
              click_on_screen{' '}
              <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                Beta
              </span>
            </p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              Lets the AI click UI elements you describe in plain English
              ("send the message", "close this dialog"). Combines Windows
              accessibility-tree lookup with vision-locate fallback.
            </p>
          </div>
          <Toggle
            checked={features.visualClick}
            onChange={(v) => void handleVisualClick(v)}
          />
        </div>
        <div className="mt-2 space-y-1 text-[10px] leading-relaxed text-slate-400">
          <p>
            <span className="font-semibold text-emerald-300">Works well:</span>{' '}
            native desktop apps with proper accessibility labels — Discord,
            Slack, Office, Settings, File Explorer, VS Code, anything with
            visible button text.
          </p>
          <p>
            <span className="font-semibold text-rose-300">Struggles:</span>{' '}
            browser web content (Messenger/Gmail/etc in a tab), icon-only
            buttons in busy UIs, custom-rendered canvases. Vision models
            commonly mis-click by 50-200 pixels on these.
          </p>
          <p className="text-slate-500">
            Every click is preceded by a 3-second cancellable preview ring,
            so wrong locates fail safe — press Esc to cancel.
          </p>
        </div>
      </div>
    </CollapsibleSection>
  )
}
