/**
 * Provider configuration: pick the active AI provider from a dropdown, paste
 * an API key (stored encrypted in the OS keychain), choose a model and set the
 * endpoint. Most providers are OpenAI-compatible; "Custom" points at any such
 * endpoint.
 */
import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, KeyRound, RefreshCw, Sparkles } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { CollapsibleSection } from './CollapsibleSection'
import { modelHasVision } from '@shared/modelCapabilities'
import type { ProviderId } from '@shared/types'

/** Models first-discovered within this window get a "NEW" badge. */
const NEW_MODEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function ProviderSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const models = useConfigStore((s) => s.models)
  const setActiveProvider = useConfigStore((s) => s.setActiveProvider)
  const setProviderModel = useConfigStore((s) => s.setProviderModel)
  const setProviderBaseUrl = useConfigStore((s) => s.setProviderBaseUrl)
  const setApiKey = useConfigStore((s) => s.setApiKey)
  const loadModels = useConfigStore((s) => s.loadModels)

  const [keyInput, setKeyInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelDraft, setModelDraft] = useState('')

  const activeId = config?.activeProvider
  const provider = config?.providers.find((p) => p.id === activeId) ?? null

  useEffect(() => {
    if (!provider) return
    setKeyInput('')
    setBaseUrlInput(provider.baseUrl ?? '')
    setModelDraft(provider.model)
    void loadModels(provider.id)
  }, [provider?.id, loadModels])

  if (!config || !provider) return null

  const modelOptions = [
    ...new Set(
      [provider.model, ...(models[provider.id] ?? provider.defaultModels)].filter(Boolean)
    )
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

      <div className="mb-3">
        <label className="mb-1 block text-[10px] text-slate-400">
          {provider.label} API key{!provider.needsKey && ' (optional)'}
          {provider.hasKey && (
            <span className="ml-1.5 text-emerald-400">
              <Check size={10} className="inline" /> saved
            </span>
          )}
        </label>
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
        {provider.hasKey && (
          <button
            type="button"
            onClick={() => void setApiKey(provider.id, '')}
            className="mt-1 text-[10px] text-rose-400 hover:underline"
          >
            Remove stored key
          </button>
        )}
      </div>

      {newModels.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5">
            <Sparkles size={11} className="text-amber-300" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-200">
              {newModels.length} new model{newModels.length === 1 ? '' : 's'} available
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {newModels.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModelDraft(m)
                  void setProviderModel(provider.id, m)
                }}
                title={`Switch to ${m}`}
                className="rounded-md border border-amber-400/30 bg-black/30 px-2 py-0.5 text-[10px] font-mono text-amber-100 transition hover:border-amber-300 hover:bg-amber-500/20"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] text-slate-400">Model</label>
          <button
            type="button"
            onClick={() => void loadModels(provider.id)}
            className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white"
          >
            <RefreshCw size={10} />
            Refresh
          </button>
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
            return <option key={model} value={model} label={isNew ? `${model}  ✨ NEW` : undefined} />
          })}
        </datalist>
        {/* Vision-capability badge — pattern-matched against the model id.
            Lets users know at a glance whether attaching images will actually
            reach the model or be discarded silently by the provider. */}
        {modelDraft && (
          <div className="mt-1 flex items-center gap-1 text-[10px]">
            {modelHasVision(modelDraft) ? (
              <>
                <Eye size={10} className="text-emerald-400" />
                <span className="text-emerald-400">Vision-capable</span>
                <span className="text-slate-500">— image attachments are seen by the model</span>
              </>
            ) : (
              <>
                <EyeOff size={10} className="text-slate-500" />
                <span className="text-slate-500">Text-only model — images won't be processed</span>
              </>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="mb-1 block text-[10px] text-slate-400">
          {provider.id === 'ollama'
            ? 'Ollama server URL'
            : provider.id === 'lmstudio'
              ? 'LM Studio server URL'
              : provider.id === 'llamacpp'
                ? 'llama-server URL'
                : provider.id === 'custom'
                  ? 'Endpoint URL (required)'
                  : 'Endpoint override (optional)'}
        </label>
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
            onClick={() => void setProviderBaseUrl(provider.id, baseUrlInput.trim())}
            className="rounded-lg border border-white/10 px-3 text-[11px] text-slate-300 transition hover:bg-white/5"
          >
            Save
          </button>
        </div>
        {provider.id === 'custom' && (
          <p className="mt-1 text-[10px] text-slate-500">
            Any OpenAI-compatible endpoint — LM Studio, Together, Perplexity, a self-hosted server…
          </p>
        )}
        {provider.id === 'llamacpp' && (
          <p className="mt-1 text-[10px] text-slate-500">
            Start <code className="rounded bg-black/40 px-1 py-px text-slate-300">llama-server</code>{' '}
            (bundled with llama.cpp) pointing at your GGUF file — e.g.{' '}
            <code className="rounded bg-black/40 px-1 py-px text-slate-300">
              llama-server -m model.gguf --port 8080
            </code>
            . VoidSoul auto-detects it on this URL.
          </p>
        )}
        {provider.id === 'lmstudio' && (
          <p className="mt-1 text-[10px] text-slate-500">
            In LM Studio, open the Developer tab and click <em>Start Server</em>. VoidSoul talks to
            it on the OpenAI-compatible endpoint above.
          </p>
        )}
      </div>
    </CollapsibleSection>
  )
}
