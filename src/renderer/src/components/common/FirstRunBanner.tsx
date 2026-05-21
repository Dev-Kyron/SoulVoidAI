/**
 * First-run guidance banner. Shows when the user's active AI provider can't
 * actually answer requests right now — either it's a keyed provider without
 * a stored key, or it's a local provider (Ollama / LM Studio) whose daemon
 * isn't reachable. Bridges the "I installed VoidSoul, why doesn't anything
 * happen?" gap with three clear actions:
 *
 *   1. Install Ollama — opens the download page; the auto-detect on next
 *      launch (or via the model-refresh tick) picks it up automatically.
 *   2. Add an API key — opens the dedicated Settings window straight to the
 *      AI Provider section.
 *   3. Dismiss — hides the banner for the lifetime of this install (stored
 *      in localStorage, so reinstalls re-prompt). The banner naturally
 *      stops showing the moment a provider becomes usable anyway.
 *
 * Dismissal is a UI-only concern, not a synced config setting — localStorage
 * is the right scope. If the user adds a key later, the `usable` check
 * starts returning true and the banner disappears without dismissal logic.
 */
import { useState } from 'react'
import { Download, ExternalLink, KeyRound, X } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { vs } from '../../lib/bridge'

const DISMISS_KEY = 'voidsoul:first-run-banner-dismissed'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

/**
 * Selector that returns a single boolean — derived from the smallest slice of
 * config we care about. Zustand short-circuits the render when the bool
 * doesn't change, so unrelated config edits (DND, theme, voice rate) don't
 * re-run the banner.
 */
function selectIsUsable(state: ReturnType<typeof useConfigStore.getState>): boolean {
  const config = state.config
  if (!config) return false
  const active = config.providers.find((p) => p.id === config.activeProvider)
  if (!active) return false
  return active.hasKey || active.localReady === true
}

export function FirstRunBanner(): JSX.Element | null {
  // Subscribe to the usability boolean, not the whole config — narrow
  // selector means unrelated config edits don't re-render the banner.
  const usable = useConfigStore(selectIsUsable)
  const configReady = useConfigStore((s) => s.config !== null)
  const [dismissed, setDismissed] = useState(() => {
    // localStorage can throw on quota-exceeded or in private-mode browsers
    // (rare in Electron, but the panel runs in a Chromium context that
    // honours those errors). Default to "not dismissed" on read failure
    // rather than blanking the whole onboarding banner.
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  if (!configReady || dismissed || usable) return null

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // If we can't persist the dismissal, the banner will return on next
      // launch — acceptable, vs. throwing uncaught and breaking the UI.
    }
    setDismissed(true)
  }

  const installOllama = (): void => {
    void vs.automation.execute({ type: 'open-url', params: { url: OLLAMA_DOWNLOAD_URL } })
  }

  const addApiKey = (): void => {
    void vs.window.openSettings()
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mt-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-amber-200">
            VoidSoul has no AI provider configured
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-300">
            Install Ollama for a free local model — no account, no key — or paste any AI provider
            key you already have.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={installOllama}
              className="flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-100 transition hover:bg-amber-400/20"
            >
              <Download size={10} />
              Install Ollama
              <ExternalLink size={9} className="opacity-60" />
            </button>
            <button
              type="button"
              onClick={addApiKey}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-slate-200 transition hover:bg-white/10"
            >
              <KeyRound size={10} />
              Add an API key
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss"
          className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
