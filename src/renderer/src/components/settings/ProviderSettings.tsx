/**
 * Provider configuration: pick the active AI provider from a dropdown, paste
 * an API key (stored encrypted in the OS keychain), choose a model and set the
 * endpoint. Most providers are OpenAI-compatible; "Custom" points at any such
 * endpoint.
 */
import { useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  Sparkles,
  Trash2
} from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { CollapsibleSection } from './CollapsibleSection'
import { modelHasVision } from '@shared/modelCapabilities'
import { cn } from '../../lib/utils'
import type { ProviderId } from '@shared/types'

/** Models first-discovered within this window get a "NEW" badge. */
const NEW_MODEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Providers whose endpoint field is required / commonly edited — keep
 *  the input expanded by default for these; collapse it for cloud-cookie
 *  providers where the default endpoint is correct 99% of the time. */
const ALWAYS_SHOW_ENDPOINT = new Set<ProviderId>(['ollama', 'lmstudio', 'llamacpp', 'custom'])

export function ProviderSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const models = useConfigStore((s) => s.models)
  const setActiveProvider = useConfigStore((s) => s.setActiveProvider)
  const setProviderModel = useConfigStore((s) => s.setProviderModel)
  const setProviderBaseUrl = useConfigStore((s) => s.setProviderBaseUrl)
  const setApiKey = useConfigStore((s) => s.setApiKey)
  const setAutoRoute = useConfigStore((s) => s.setAutoRoute)
  const loadModels = useConfigStore((s) => s.loadModels)

  const [keyInput, setKeyInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [showAllNew, setShowAllNew] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const activeId = config?.activeProvider
  const provider = config?.providers.find((p) => p.id === activeId) ?? null

  useEffect(() => {
    if (!provider) return
    setKeyInput('')
    setBaseUrlInput(provider.baseUrl ?? '')
    setModelDraft(provider.model)
    setShowAllNew(false)
    setAdvancedOpen(false)
    void loadModels(provider.id)
  }, [provider?.id, loadModels])

  if (!config || !provider) return null

  const modelOptions = [
    ...new Set([provider.model, ...(models[provider.id] ?? provider.defaultModels)].filter(Boolean))
  ]

  // Models discovered in the last week are "new" — surfaced as a callout and
  // tagged in the datalist so day-zero releases are obvious.
  const seenForProvider = config.seenModels?.[provider.id] ?? {}
  const cutoff = Date.now() - NEW_MODEL_WINDOW_MS
  const newModels = modelOptions.filter((m) => {
    const iso = seenForProvider[m]
    if (!iso) return false
    return new Date(iso).getTime() >= cutoff
  })

  const commitModel = (): void => {
    const next = modelDraft.trim()
    if (next && next !== provider.model) void setProviderModel(provider.id, next)
  }

  const endpointAlwaysVisible = ALWAYS_SHOW_ENDPOINT.has(provider.id)
  const endpointDiffersFromDefault = baseUrlInput.trim() !== (provider.baseUrl ?? '').trim()

  return (
    <CollapsibleSection
      title="AI Provider"
      hint="Pick the AI service that powers VoidSoul and paste its API key. Keys are encrypted on this machine and never leave it. Required before you can chat."
    >
      <select
        value={provider.id}
        onChange={(e) => void setActiveProvider(e.target.value as ProviderId)}
        className="mb-3 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
      >
        {config.providers.map((p) => {
          // Status badge precedence: a stored key always wins; for local
          // providers, fall back to whether their daemon was detected on
          // the last boot probe; for the rest, "needs key" if applicable.
          const status = p.hasKey
            ? '  ✓ ready'
            : p.localReady === true
              ? '  ✓ detected'
              : p.localReady === false
                ? '  — not running'
                : p.needsKey
                  ? '  — needs key'
                  : ''
          return (
            <option key={p.id} value={p.id} className="bg-void-700">
              {p.label}
              {status}
            </option>
          )
        })}
      </select>

      {/* v1.13.4 — Auto-route toggle. When ON (default), the router can
       * override the Active provider above based on per-prompt
       * capability/cost/speed signals (e.g. push tool-heavy prompts to
       * a fast/cheap model). When OFF, every send goes to the Active
       * pick verbatim. Added after users reported the router routing
       * tool-heavy prompts to gpt-4o-mini and that model refusing tool
       * calls — locking Active = Claude is the workaround, but only
       * works once the user can actually turn the router off. */}
      <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
        <input
          type="checkbox"
          checked={config.chat.autoRoute}
          onChange={(e) => void setAutoRoute(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-semibold text-slate-200">
            Auto-route providers per prompt
          </span>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
            {config.chat.autoRoute
              ? 'On: the router may pick a different provider/model than Active for any given send (e.g. fast model for short answers, vision-capable for images, tool-heavy for agent steps). Watch the Logs tab for routing decisions.'
              : 'Off: every send goes to the Active provider above. Use this when the router is picking a worse model for your task — for example forcing Claude for filesystem work even when faster models exist.'}
          </p>
        </div>
      </label>

      {/* API key row — paste + save. "Remove stored key" is collapsed into
          a tiny trash icon next to the "saved" badge so the destructive
          link doesn't sit loose under the input as a permanent red eyesore. */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] text-slate-400">
            {provider.label} API key{!provider.needsKey && ' (optional)'}
          </label>
          {provider.hasKey && (
            <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
              <Check size={10} />
              saved
              <button
                type="button"
                onClick={() => void setApiKey(provider.id, '')}
                title="Remove stored key"
                aria-label="Remove stored key"
                className="rounded p-0.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
              >
                <Trash2 size={10} />
              </button>
            </span>
          )}
        </div>
        <div className="flex gap-1.5">
          <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2.5">
            <KeyRound size={13} className="text-slate-500" />
            <input
              type="password"
              value={keyInput}
              placeholder={provider.hasKey ? '•••••••••• (replace)' : 'Paste API key'}
              onChange={(e) => setKeyInput(e.target.value)}
              className="flex-1 bg-transparent py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600"
            />
          </div>
          <button
            type="button"
            disabled={keyInput.trim().length === 0}
            onClick={async () => {
              await setApiKey(provider.id, keyInput.trim())
              setKeyInput('')
            }}
            className="rounded-lg bg-[var(--accent)] px-3 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>

      {/* NEW MODELS callout. Used to dump every fresh model name as a chip —
          for a provider like Anthropic with their full Claude lineup that
          was a wall of 12+ chips on every visit. Now collapsed by default:
          show a single inline summary with a "Show all" toggle, expand only
          on demand. Picking a chip still switches the active model. */}
      {newModels.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-2">
          <button
            type="button"
            onClick={() => setShowAllNew((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="flex items-center gap-1.5">
              <Sparkles size={11} className="text-amber-300" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                {newModels.length} new model{newModels.length === 1 ? '' : 's'} this week
              </span>
            </span>
            <span className="flex items-center gap-1 text-[10px] text-amber-200/70">
              {showAllNew ? 'Hide' : 'Show all'}
              <ChevronDown
                size={11}
                className={cn('transition-transform', showAllNew && 'rotate-180')}
              />
            </span>
          </button>
          {showAllNew && (
            <div className="mt-2 flex flex-wrap gap-1">
              {newModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setModelDraft(m)
                    void setProviderModel(provider.id, m)
                  }}
                  title={`Switch to ${m}`}
                  className={cn(
                    'rounded-md border border-amber-400/30 bg-black/30 px-2 py-0.5 font-mono text-[10px] text-amber-100 transition hover:border-amber-300 hover:bg-amber-500/20',
                    m === provider.model && 'border-amber-300 bg-amber-500/25'
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Model row — input + Refresh + inline vision pill (was a separate
          line below the input; now sits right of Refresh to keep the row
          tight). */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="text-[10px] text-slate-400">Model</label>
          <div className="flex items-center gap-2">
            {modelDraft && (
              <span
                title={
                  modelHasVision(modelDraft)
                    ? 'Vision-capable — image attachments are seen by the model.'
                    : "Text-only — images won't be processed."
                }
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px]',
                  modelHasVision(modelDraft)
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 bg-white/5 text-slate-500'
                )}
              >
                {modelHasVision(modelDraft) ? <Eye size={9} /> : <EyeOff size={9} />}
                {modelHasVision(modelDraft) ? 'Vision' : 'Text only'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void loadModels(provider.id)}
              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white"
            >
              <RefreshCw size={10} />
              Refresh
            </button>
          </div>
        </div>
        <input
          list={`models-${provider.id}`}
          value={modelDraft}
          placeholder="Type or pick a model id"
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={commitModel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
        />
        <datalist id={`models-${provider.id}`}>
          {modelOptions.map((model) => {
            // Append a "✨ NEW" suffix to datalist labels so browsers that show
            // them (Chromium does) hint at fresh releases inline.
            const isNew = newModels.includes(model)
            return (
              <option key={model} value={model} label={isNew ? `${model}  ✨ NEW` : undefined} />
            )
          })}
        </datalist>
      </div>

      {/* Endpoint override. Always expanded for local / custom providers
          where users frequently need to edit it; collapsed under an
          "Advanced" disclosure for cloud providers where the default
          endpoint is correct unless the user is routing through a proxy. */}
      {endpointAlwaysVisible ? (
        <EndpointRow
          providerId={provider.id}
          baseUrlInput={baseUrlInput}
          setBaseUrlInput={setBaseUrlInput}
          onSave={() => void setProviderBaseUrl(provider.id, baseUrlInput.trim())}
        />
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-slate-500 transition hover:text-slate-300"
          >
            <ChevronDown
              size={10}
              className={cn('transition-transform', advancedOpen && 'rotate-180')}
            />
            Advanced — endpoint override
            {endpointDiffersFromDefault && (
              <span className="text-[9px] text-amber-300">· customised</span>
            )}
          </button>
          {advancedOpen && (
            <div className="mt-2">
              <EndpointRow
                providerId={provider.id}
                baseUrlInput={baseUrlInput}
                setBaseUrlInput={setBaseUrlInput}
                onSave={() => void setProviderBaseUrl(provider.id, baseUrlInput.trim())}
              />
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  )
}

/**
 * Endpoint URL row — shared between the always-visible local/custom path
 * and the collapsed-by-default cloud path. Renders the input + Save plus
 * the per-provider helper note (llama.cpp / LM Studio launch instructions).
 */
function EndpointRow({
  providerId,
  baseUrlInput,
  setBaseUrlInput,
  onSave
}: {
  providerId: ProviderId
  baseUrlInput: string
  setBaseUrlInput: (v: string) => void
  onSave: () => void
}): JSX.Element {
  const label =
    providerId === 'ollama'
      ? 'Ollama server URL'
      : providerId === 'lmstudio'
        ? 'LM Studio server URL'
        : providerId === 'llamacpp'
          ? 'llama-server URL'
          : providerId === 'custom'
            ? 'Endpoint URL (required)'
            : 'Endpoint override'

  return (
    <>
      <label className="mb-1 block text-[10px] text-slate-400">{label}</label>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={baseUrlInput}
          placeholder="https://…"
          onChange={(e) => setBaseUrlInput(e.target.value)}
          className="flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[12px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
        />
        <button
          type="button"
          onClick={onSave}
          className="rounded-lg border border-white/10 px-3 text-[11px] text-slate-300 transition hover:bg-white/5"
        >
          Save
        </button>
      </div>
      {providerId === 'custom' && (
        <p className="mt-1 text-[10px] text-slate-500">
          Any OpenAI-compatible endpoint — LM Studio, Together, Perplexity, a self-hosted server…
        </p>
      )}
      {providerId === 'llamacpp' && (
        <p className="mt-1 text-[10px] text-slate-500">
          Start <code className="rounded bg-black/40 px-1 py-px text-slate-300">llama-server</code>{' '}
          (bundled with llama.cpp) pointing at your GGUF file — e.g.{' '}
          <code className="rounded bg-black/40 px-1 py-px text-slate-300">
            llama-server -m model.gguf --port 8080
          </code>
          . VoidSoul auto-detects it on this URL.
        </p>
      )}
      {providerId === 'lmstudio' && (
        <p className="mt-1 text-[10px] text-slate-500">
          In LM Studio, open the Developer tab and click <em>Start Server</em>. VoidSoul talks to it
          on the OpenAI-compatible endpoint above.
        </p>
      )}
    </>
  )
}
