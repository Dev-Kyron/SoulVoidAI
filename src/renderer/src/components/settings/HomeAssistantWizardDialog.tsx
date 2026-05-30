/**
 * Home Assistant setup wizard — modal that walks the user through URL
 * + long-lived token entry, runs a live connection test against
 * `/api/config` and `/api/states`, shows a sample of detected entities,
 * then persists the config + flips `enabled` on.
 *
 * Lives in its own file (separate from HomeAssistantSettings) so the
 * Settings root's lazy loader doesn't try to infer a single prop type
 * across both the settings panel (no props) and the wizard (initialUrl /
 * onClose / onDone).
 */
import { useState } from 'react'
import { Home, CheckCircle2, RefreshCw, ExternalLink, Plug } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import { BTN, FIELD } from './styles'
import type { HomeAssistantEntitySummary } from '@shared/types'

type WizardStep = 'url' | 'token' | 'test' | 'enabled'

export function HomeAssistantWizardDialog({
  initialUrl,
  onClose,
  onDone
}: {
  initialUrl?: string
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const [step, setStep] = useState<WizardStep>('url')
  const [url, setUrl] = useState(initialUrl ?? '')
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    | {
        ok: true
        url: string
        instanceName: string | null
        version: string | null
        entityCount: number
        sample: HomeAssistantEntitySummary[]
      }
    | { ok: false; error: string }
    | null
  >(null)
  const pushToast = useUiStore((s) => s.pushToast)

  const runTest = async (): Promise<void> => {
    if (!url.trim() || !token.trim()) {
      pushToast('error', 'URL and token are both required.')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await vs.homeAssistant.test({ url: url.trim(), token: token.trim() })
      setTestResult(result)
      if (result.ok) setStep('test')
    } finally {
      setTesting(false)
    }
  }

  const enable = async (): Promise<void> => {
    setTesting(true)
    try {
      await vs.homeAssistant.configure({
        url: url.trim(),
        token: token.trim(),
        enabled: true
      })
      pushToast('success', 'Home Assistant connected. Agent tools are now live.')
      setStep('enabled')
      await onDone()
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass max-w-md rounded-xl p-4">
        <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-slate-100">
          <Home size={13} className="text-[var(--accent)]" />
          Set up Home Assistant
        </p>
        <p className="mb-3 text-[10px] leading-relaxed text-slate-400">
          Two fields. Token first if you don&apos;t have one yet — open HA → click your profile in
          the bottom-left → scroll to <b>Long-lived access tokens</b> → <b>Create token</b>.
        </p>

        <label className="mb-2 block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            Home Assistant URL
          </span>
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setTestResult(null)
              setStep('url')
            }}
            placeholder="http://homeassistant.local:8123"
            className={cn(FIELD, 'w-full')}
            autoFocus
          />
          <p className="mt-1 text-[10px] text-slate-500">
            Local: <code className="font-mono">http://homeassistant.local:8123</code> · Remote (Nabu
            Casa): <code className="font-mono">https://abcdef.ui.nabu.casa</code>
          </p>
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            Long-lived access token
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
              setTestResult(null)
              setStep('token')
            }}
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
            className={cn(FIELD, 'w-full font-mono')}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            Stored in the OS keychain — never written to disk in plaintext, never synced.
          </p>
        </label>

        <button
          type="button"
          onClick={() => void runTest()}
          disabled={testing || !url.trim() || !token.trim()}
          className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] font-semibold text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
        >
          {testing ? <RefreshCw size={12} className="animate-spin" /> : <Plug size={12} />}
          Test connection
        </button>

        {testResult?.ok === false && (
          <div className="mb-2 rounded-md bg-rose-500/10 p-2 text-[10px] text-rose-200">
            <p className="font-semibold">Connection failed</p>
            <p className="mt-0.5">{testResult.error}</p>
          </div>
        )}

        {testResult?.ok === true && (
          <div className="mb-2 rounded-md bg-emerald-500/10 p-2">
            <p className="flex items-center gap-1 text-[11px] font-semibold text-emerald-200">
              <CheckCircle2 size={11} />
              Connected to {testResult.instanceName || testResult.url}
            </p>
            <p className="mt-0.5 text-[10px] text-emerald-100/70">
              HA {testResult.version} · {testResult.entityCount} entit
              {testResult.entityCount === 1 ? 'y' : 'ies'} discovered
            </p>
            {testResult.sample.length > 0 && (
              <div className="mt-1.5 max-h-32 overflow-y-auto rounded bg-black/20 p-1.5">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-200/60">
                  Sample
                </p>
                {testResult.sample.map((s) => (
                  <p
                    key={s.entity_id}
                    className="flex justify-between gap-2 font-mono text-[10px] text-emerald-100/80"
                  >
                    <span className="truncate">{s.entity_id}</span>
                    <span className="shrink-0 text-emerald-100/50">{s.state}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-1.5">
          <a
            href="https://www.home-assistant.io/docs/authentication/#your-account-profile"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-[var(--accent)]"
          >
            How to make a token <ExternalLink size={10} />
          </a>
          <div className="flex gap-1.5">
            <button type="button" onClick={onClose} className={BTN}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void enable()}
              disabled={testing || testResult?.ok !== true || step === 'enabled'}
              className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
            >
              <Plug size={11} />
              Enable
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
