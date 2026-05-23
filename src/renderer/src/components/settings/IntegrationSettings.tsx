/**
 * Settings panel for non-AI integration keys (Tavily for web search, etc.).
 * Keys are encrypted at rest with the OS keychain the same way AI provider
 * keys are — the renderer only ever sees whether one is set, never its value.
 */
import { useEffect, useState } from 'react'
import { KeyRound, Search, Github, ExternalLink, Image as ImageIcon, Mic } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { CollapsibleSection } from './CollapsibleSection'
import { cn } from '../../lib/utils'

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600 font-mono'

interface ActiveBackend {
  /** Short backend name shown on the badge, e.g. "DuckDuckGo". */
  name: string
  /** One-line description shown beside the name. */
  detail: string
}

function SecretField({
  id,
  label,
  hint,
  signupUrl,
  freeBackend,
  upgradedBackend
}: {
  id: string
  label: string
  hint: string
  signupUrl?: string
  /** Backend that runs when no key is configured — shown as the "active" badge. */
  freeBackend?: ActiveBackend
  /** Backend that takes over once the key is saved. */
  upgradedBackend?: ActiveBackend
}): JSX.Element {
  const [stored, setStored] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    void vs.secrets.has(id).then(setStored)
  }, [id])

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const has = await vs.secrets.set(id, draft)
    setStored(has)
    setBusy(false)
    setDraft('')
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1500)
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    await vs.secrets.set(id, '')
    setStored(false)
    setBusy(false)
  }

  // Which backend is *actually running right now* — drives the "active" badge.
  // Reframes this whole row from "you need this key" to "this is what's
  // running, here's how to upgrade it".
  const active = stored ? upgradedBackend : freeBackend

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <KeyRound size={12} className="text-[var(--accent)]" />
        <span className="text-[11px] font-semibold text-slate-200">{label}</span>
        {stored && (
          <span
            className={cn(
              'text-[9px] font-semibold uppercase tracking-wide transition',
              savedFlash ? 'text-emerald-400' : 'text-emerald-400/70'
            )}
          >
            ✓ saved
          </span>
        )}
        {signupUrl && (
          <button
            type="button"
            onClick={() => void vs.automation.execute({ type: 'open-url', params: { url: signupUrl } })}
            className="ml-auto flex items-center gap-1 text-[9px] text-slate-500 transition hover:text-[var(--accent)]"
          >
            get a key <ExternalLink size={9} />
          </button>
        )}
      </div>
      {active && (
        <div
          className={cn(
            'flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-[10px]',
            stored
              ? 'border-emerald-400/30 bg-emerald-400/5'
              : 'border-cyan-400/20 bg-cyan-400/5'
          )}
        >
          <span
            className={cn(
              'font-semibold uppercase tracking-wide',
              stored ? 'text-emerald-300' : 'text-cyan-300'
            )}
          >
            Active: {active.name}
          </span>
          <span className="text-slate-400">{active.detail}</span>
        </div>
      )}
      <p className="text-[10px] text-slate-500">{hint}</p>
      <div className="flex gap-1.5">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={stored ? '••••••••• (replace)' : 'paste key…'}
          className={FIELD}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!draft.trim() || busy}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {stored && (
        <button
          type="button"
          onClick={() => void clear()}
          className="text-[10px] text-rose-400 transition hover:underline"
        >
          Remove stored key
        </button>
      )}
    </div>
  )
}

export function IntegrationSettings(): JSX.Element {
  return (
    <CollapsibleSection
      title="Integrations"
      hint="Optional upgrades. Each row already has a free backend running — paste a key to swap in a higher-quality one. Encrypted the same way as your AI provider keys."
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <Search size={11} className="text-[var(--accent)]" />
            Web Search
          </div>
          <SecretField
            id="tavily"
            label="Tavily API key"
            hint="The web_search tool works out of the box via DuckDuckGo. Tavily adds ranked results and an LLM-summarised quick answer — free tier covers 1,000 queries/month."
            signupUrl="https://tavily.com"
            freeBackend={{ name: 'DuckDuckGo', detail: 'free · no signup' }}
            upgradedBackend={{ name: 'Tavily', detail: 'ranked results + AI summary' }}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <Github size={11} className="text-[var(--accent)]" />
            GitHub
          </div>
          <SecretField
            id="github"
            label="GitHub Personal Access Token"
            hint='Optional. Adds "Share as Gist" exports (and the GitHub MCP server). Needs the `gist` scope at minimum — add `repo` if you also want the GitHub MCP server to read your repos. Without it, you can still copy or save threads to disk.'
            signupUrl="https://github.com/settings/tokens"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <ImageIcon size={11} className="text-[var(--accent)]" />
            Image generation
          </div>
          <SecretField
            id="stability"
            label="Stability AI key"
            hint="Image generation works keyless via Pollinations (Flux). Stability AI unlocks Stable Diffusion 3 Core for higher-quality renders. DALL·E 3 and Imagen also kick in automatically when their AI provider keys are present."
            signupUrl="https://platform.stability.ai/account/keys"
            freeBackend={{ name: 'Pollinations', detail: 'free · no signup · Flux model' }}
            upgradedBackend={{ name: 'Stable Diffusion 3', detail: 'higher quality renders' }}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <Mic size={11} className="text-[var(--accent)]" />
            Wake word
          </div>
          <SecretField
            id="picovoice"
            label="Picovoice access key"
            hint={`Wake word works keyless via the local Whisper model (matches "Hey Void", "Hey Soul", "Hey Companion" — same model used for voice input; pre-v1.6 "Hey Assistant" also still triggers). Picovoice Porcupine is an OPTIONAL upgrade for lower CPU + faster detection — but heads-up: Picovoice signup currently gates on a "company email", so it's mostly for enterprise. Whisper is the supported default for solo users.`}
            signupUrl="https://console.picovoice.ai"
            freeBackend={{ name: 'Whisper', detail: 'free · no signup · matches any phrase' }}
            upgradedBackend={{ name: 'Porcupine', detail: 'lower CPU · faster detection' }}
          />
        </div>
      </div>
    </CollapsibleSection>
  )
}
