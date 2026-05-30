/**
 * Granular permission manager. Every automation capability is listed with its
 * risk level and an explicit, revocable toggle. Nothing is granted by default.
 */
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { vs } from '../../lib/bridge'
import { Toggle, RiskBadge } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { AgentReadinessNotice } from './AgentReadinessNotice'
import { PERMISSIONS } from '@shared/permissions'

export function PermissionsManager(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setPermission = useConfigStore((s) => s.setPermission)
  const load = useConfigStore((s) => s.load)
  const pushToast = useUiStore((s) => s.pushToast)
  if (!config) return null

  const anyGranted = PERMISSIONS.some((p) => config.permissions[p.id]?.granted)

  return (
    <CollapsibleSection
      title="Permissions"
      hint="Control what VoidSoul may do on your computer. Everything stays off until you grant it, and you can revoke any of it anytime."
    >
      {/* v1.12.6 — see McpSettings for the same banner; both panels render
       * inert tool surface when Agent mode is off, so both deserve the
       * heads-up. */}
      <AgentReadinessNotice />
      {anyGranted && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={async () => {
              await vs.permissions.revokeAll()
              await load()
              pushToast('info', 'All permissions revoked.')
            }}
            className="text-[10px] text-rose-400 hover:underline"
          >
            Revoke all
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        {PERMISSIONS.map((permission) => {
          const granted = config.permissions[permission.id]?.granted ?? false
          return (
            <div
              key={permission.id}
              className="glass-soft flex items-center gap-2.5 rounded-lg px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12px] font-medium text-white">{permission.label}</p>
                  <RiskBadge risk={permission.risk} />
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                  {permission.description}
                </p>
              </div>
              <Toggle
                checked={granted}
                onChange={(value) => void setPermission(permission.id, value)}
                label={permission.label}
              />
            </div>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}
