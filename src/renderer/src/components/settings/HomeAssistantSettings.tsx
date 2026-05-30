/**
 * Home Assistant integration — Settings panel + setup wizard.
 *
 * The marketplace card for HA's "builtin" entry opens
 * `HomeAssistantWizardDialog` directly; ongoing config lives in the
 * `HomeAssistantSettings` section under Settings → Tools.
 *
 * Token lives in the OS keychain — we never display it after the
 * initial paste, and the UI reads "Token: stored ✓" instead of
 * surfacing the raw value (mirrors how the provider API-key fields
 * work elsewhere in Settings).
 */
import { useEffect, useState } from 'react'
import {
  Home,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Settings as SettingsIcon,
  Plug
} from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { useConfigStore } from '../../store/useConfigStore'
import { CollapsibleSection } from './CollapsibleSection'
import { Toggle } from '../common/ui'
import { HomeAssistantWizardDialog } from './HomeAssistantWizardDialog'
import type { HomeAssistantStatus } from '@shared/types'

const BTN =
  'flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] text-slate-200 transition hover:bg-white/5 disabled:opacity-40'

export function HomeAssistantSettings(): JSX.Element {
  const [status, setStatus] = useState<HomeAssistantStatus | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const pushToast = useUiStore((s) => s.pushToast)

  const refresh = async (): Promise<void> => {
    setStatus(await vs.homeAssistant.refresh())
  }

  useEffect(() => {
    void vs.homeAssistant.status().then(setStatus)
  }, [])

  return (
    <CollapsibleSection
      title="Home Assistant"
      hint="Control your smart home from chat — lights, locks, thermostat, scenes, scripts and anything else HA exposes. Connects over your HA instance's REST API; no external server to install."
    >
      <div className="glass-soft rounded-lg border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-100">
            <Home size={12} className="text-[var(--accent)]" />
            Connection
          </p>
          {status && <StatusBadge status={status} />}
        </div>

        {!status?.configured ? (
          <>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
              Set up the integration once with your HA URL + a long-lived access token. The agent
              gains three tools: list entities, read state, call service.
            </p>
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-2 text-[11px] font-semibold text-white transition hover:brightness-110"
            >
              <Plug size={13} />
              Set up Home Assistant
            </button>
          </>
        ) : (
          <>
            <p className="mb-1 truncate text-[10px] text-slate-300" title={status.url ?? ''}>
              <span className="text-slate-500">URL: </span>
              {status.url}
            </p>
            {status.instanceName && (
              <p className="mb-1 text-[10px] text-slate-300">
                <span className="text-slate-500">Instance: </span>
                {status.instanceName}
                {status.version && <span className="text-slate-500"> · HA {status.version}</span>}
              </p>
            )}
            {status.entityCount !== null && (
              <p className="mb-2 text-[10px] text-slate-300">
                <span className="text-slate-500">Entities: </span>
                {status.entityCount}
              </p>
            )}

            <label className="mb-2 flex items-center justify-between gap-2 rounded-md bg-black/20 px-2 py-1.5">
              <span className="text-[11px] text-slate-200">
                Enabled
                <span className="ml-1 text-[10px] text-slate-500">— agent tools active</span>
              </span>
              <Toggle
                checked={status.enabled}
                onChange={async (v) => {
                  if (v) {
                    // Re-enabling without re-running the wizard:
                    // re-write the same URL with enabled:true.
                    if (!status.url) return
                    setStatus(
                      await vs.homeAssistant
                        .configure({
                          url: status.url,
                          // The keychain still has the token; this IPC call
                          // re-writes it from the OS store, but we need a
                          // value to pass through. The wizard is the canonical
                          // way to re-pair if the keychain entry vanished.
                          token: '__keep__',
                          enabled: true
                        })
                        .catch(async () => {
                          // If `__keep__` round-tripping fails (token would
                          // be wiped), fall back to opening the wizard.
                          setWizardOpen(true)
                          return status
                        })
                    )
                  } else {
                    setStatus(await vs.homeAssistant.disable())
                    pushToast('info', 'Home Assistant disabled.')
                  }
                }}
              />
            </label>

            {status.error && (
              <p className="mt-2 rounded-md bg-rose-500/10 p-1.5 text-[10px] text-rose-200">
                {status.error}
              </p>
            )}

            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => void refresh()} className={BTN}>
                <RefreshCw size={11} />
                Refresh
              </button>
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className={BTN}
                title="Re-run the setup wizard to change URL or rotate the token."
              >
                <SettingsIcon size={11} />
                Reconfigure
              </button>
            </div>

            <div className="mt-2 flex justify-end">
              {confirmingClear ? (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      setStatus(await vs.homeAssistant.clear())
                      setConfirmingClear(false)
                      pushToast('info', 'Home Assistant credentials cleared.')
                    }}
                    className="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-500/30"
                  >
                    Confirm clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingClear(false)}
                    className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingClear(true)}
                  className="flex items-center gap-1 rounded-md p-1 text-[10px] text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200"
                >
                  <Trash2 size={10} />
                  Clear credentials
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {wizardOpen && (
        <HomeAssistantWizardDialog
          initialUrl={status?.url ?? ''}
          onClose={() => setWizardOpen(false)}
          onDone={async () => {
            setWizardOpen(false)
            await refresh()
            await useConfigStore.getState().load()
          }}
        />
      )}
    </CollapsibleSection>
  )
}

function StatusBadge({ status }: { status: HomeAssistantStatus }): JSX.Element {
  if (!status.configured) return <span className="text-[10px] text-slate-500">Not set up</span>
  if (!status.enabled)
    return (
      <span className="rounded bg-slate-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        Disabled
      </span>
    )
  if (status.connected)
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-300">
        <CheckCircle2 size={10} />
        Connected
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-[10px] text-rose-300" title={status.error ?? ''}>
      <AlertCircle size={10} />
      Error
    </span>
  )
}
