/**
 * Appearance and behaviour controls: accent colour, animation, panel
 * translucency, always-on-top, startup launch and screen awareness.
 */
import type { ReactNode } from 'react'
import { useConfigStore } from '../../store/useConfigStore'
import { useUiStore } from '../../store/useUiStore'
import { Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'
import { ACCENTS, cn } from '../../lib/utils'
import { useDraftField } from '../../lib/useDraftField'
import type { AccentColor, LocaleCode, NexusStyle, ThemeMode } from '@shared/types'
import { useT } from '../../lib/i18n'

const ACCENT_OPTIONS: AccentColor[] = [
  'violet',
  'cyan',
  'magenta',
  'green',
  'amber',
  'rose',
  'blue',
  'teal'
]

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-[12px] text-slate-200">{label}</p>
        {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export function AppearanceSettings(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const setAppearance = useConfigStore((s) => s.setAppearance)
  const pushToast = useUiStore((s) => s.pushToast)
  // Reactive `t` — without this the picker labels would lag one render
  // behind a locale change (the i18n module's store subscription notifies
  // *after* React has already painted with the new config).
  const t = useT()
  if (!config) return null

  const appearance = config.appearance

  return (
    <CollapsibleSection
      title="Appearance"
      hint="Accent colour, animations, panel translucency, always-on-top and launch-on-startup behaviour."
    >
      <p className="mb-1.5 text-[10px] text-slate-400">Accent colour</p>
      <div className="mb-1 flex flex-wrap gap-2">
        {ACCENT_OPTIONS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            onClick={() => void setAppearance({ accent: color })}
            className={cn(
              'h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-void-700 transition',
              appearance.accent === color ? 'ring-white' : 'ring-transparent'
            )}
            style={{ background: ACCENTS[color].hex }}
          />
        ))}
      </div>

      <Row label={t('appearance.theme')} hint={t('appearance.theme.hint')}>
        <select
          value={appearance.theme}
          onChange={(e) => void setAppearance({ theme: e.target.value as ThemeMode })}
          className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
        >
          <option value="dark" className="bg-void-700">
            {t('appearance.theme.dark')}
          </option>
          <option value="light" className="bg-void-700">
            {t('appearance.theme.light')}
          </option>
          <option value="system" className="bg-void-700">
            {t('appearance.theme.system')}
          </option>
        </select>
      </Row>

      <Row label={t('appearance.language')} hint={t('appearance.language.hint')}>
        <select
          value={appearance.locale}
          onChange={(e) => void setAppearance({ locale: e.target.value as LocaleCode })}
          className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
        >
          <option value="system" className="bg-void-700">
            System
          </option>
          <option value="en" className="bg-void-700">
            English
          </option>
          <option value="es" className="bg-void-700">
            Español
          </option>
          <option value="de" className="bg-void-700">
            Deutsch
          </option>
          <option value="ja" className="bg-void-700">
            日本語
          </option>
        </select>
      </Row>

      <Row
        label="Nexus style"
        hint="Simple — a clean app launcher · Advanced — the full radial HUD with telemetry"
      >
        <select
          value={appearance.nexusStyle}
          onChange={(e) => void setAppearance({ nexusStyle: e.target.value as NexusStyle })}
          className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)]"
        >
          <option value="simple" className="bg-void-700">
            Simple
          </option>
          <option value="advanced" className="bg-void-700">
            Advanced
          </option>
        </select>
      </Row>

      <Row label="Animations" hint="Orb and panel motion">
        <Toggle
          checked={appearance.animations}
          onChange={(value) => void setAppearance({ animations: value })}
        />
      </Row>

      <Row label="Panel translucency">
        <input
          type="range"
          min={0.4}
          max={1}
          step={0.02}
          value={appearance.glassOpacity}
          onChange={(e) => void setAppearance({ glassOpacity: Number(e.target.value) })}
          className="w-28 accent-[var(--accent)]"
        />
      </Row>

      <Row label="Always on top">
        <Toggle
          checked={appearance.alwaysOnTop}
          onChange={(value) => void setAppearance({ alwaysOnTop: value })}
        />
      </Row>

      <Row label="Launch on startup">
        <Toggle
          checked={appearance.launchOnStartup}
          onChange={(value) => void setAppearance({ launchOnStartup: value })}
        />
      </Row>

      <Row label="Screen awareness" hint="Continuously share the focused window with the AI">
        <Toggle
          checked={appearance.screenAwareness}
          onChange={(value) => {
            if (value && !config.permissions.screenCapture.granted) {
              pushToast('info', 'Grant the Screen Capture permission first.')
              return
            }
            void setAppearance({ screenAwareness: value })
          }}
        />
      </Row>

      <div className="mt-2 border-t border-white/5 pt-2">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
          Quiet mode (DND)
        </p>
        <Row
          label="Do not disturb"
          hint="Orb dims, voice replies suppressed, summon-hotkey still works"
        >
          <Toggle
            checked={appearance.dnd.enabled}
            onChange={(value) =>
              void setAppearance({ dnd: { ...appearance.dnd, enabled: value } })
            }
          />
        </Row>
        <QuietHoursRow appearance={appearance} setAppearance={setAppearance} />
      </div>
    </CollapsibleSection>
  )
}

/**
 * Standalone row so quietStart/quietEnd can each own a `useDraftField` —
 * keeps the parent's selector subscriptions narrow and lets the hook's
 * dirty-flag isolation work cleanly per input. Without this, a broadcast
 * triggered by flipping the DND checkbox above would re-render the parent
 * with a fresh `appearance.dnd` object, and the bare-bound time inputs
 * would snap back to whatever was persisted at broadcast time — overwriting
 * whatever the user was mid-clicking in the time picker.
 */
function QuietHoursRow({
  appearance,
  setAppearance
}: {
  appearance: NonNullable<ReturnType<typeof useConfigStore.getState>['config']>['appearance']
  setAppearance: ReturnType<typeof useConfigStore.getState>['setAppearance']
}): JSX.Element {
  const start = useDraftField<string>({
    source: appearance.dnd.quietStart ?? '',
    commit: (value) =>
      setAppearance({ dnd: { ...appearance.dnd, quietStart: value || null } })
  })
  const end = useDraftField<string>({
    source: appearance.dnd.quietEnd ?? '',
    commit: (value) =>
      setAppearance({ dnd: { ...appearance.dnd, quietEnd: value || null } })
  })
  return (
    <Row
      label="Quiet hours"
      hint="Auto-DND between these times (24h, e.g. 22:00 to 07:00). Blank to disable."
    >
      <div className="flex items-center gap-1">
        <input
          type="time"
          value={start.value}
          onChange={(e) => start.onChange(e.target.value)}
          onBlur={start.onBlur}
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
        />
        <span className="text-[10px] text-slate-500">→</span>
        <input
          type="time"
          value={end.value}
          onChange={(e) => end.onChange(e.target.value)}
          onBlur={end.onBlur}
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-[var(--accent-ring)]"
        />
      </div>
    </Row>
  )
}

