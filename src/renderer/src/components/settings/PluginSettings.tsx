/**
 * Plugin manager. Lists installed workflow packs, lets each be enabled or
 * disabled, surfaces validation errors, and runs a plugin's quick actions
 * directly. Plugins are declarative JSON — no code execution.
 */
import { useEffect } from 'react'
import { FolderOpen, RefreshCw, Puzzle, AlertTriangle } from 'lucide-react'
import { usePluginStore } from '../../store/usePluginStore'
import { runAction } from '../../lib/actions'
import { resolveIcon } from '../../lib/icons'
import { vs } from '../../lib/bridge'
import { EmptyState, Toggle } from '../common/ui'
import { CollapsibleSection } from './CollapsibleSection'

export function PluginSettings(): JSX.Element {
  const plugins = usePluginStore((s) => s.plugins)
  const actions = usePluginStore((s) => s.actions)
  const load = usePluginStore((s) => s.load)
  const setEnabled = usePluginStore((s) => s.setEnabled)
  const reload = usePluginStore((s) => s.reload)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <CollapsibleSection
      title="Plugins"
      hint="Declarative JSON workflow packs that add quick actions. No code runs — they only bundle the same permission-gated actions VoidSoul already has."
    >
      <div className="mb-2 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={() => void reload()}
          className="flex items-center gap-1 text-[10px] text-slate-400 transition hover:text-white"
        >
          <RefreshCw size={11} />
          Reload
        </button>
        <button
          type="button"
          onClick={() => void vs.plugins.openFolder()}
          className="flex items-center gap-1 text-[10px] text-slate-400 transition hover:text-white"
        >
          <FolderOpen size={11} />
          Folder
        </button>
      </div>

      <div className="space-y-1.5">
        {plugins.length === 0 && (
          <EmptyState
            icon={<Puzzle size={20} />}
            title="No plugins installed yet"
            hint="Drop a plugin folder into the plugins directory to extend VoidSoul with custom actions and tools."
            action={{
              label: 'Open plugins folder',
              onClick: () => void vs.plugins.openFolder()
            }}
          />
        )}
        {plugins.map((plugin) => {
          const pluginActions = actions.filter((a) => a.id.startsWith(`${plugin.id}:`))
          return (
            <div key={plugin.file} className="glass-soft rounded-lg px-2.5 py-2">
              <div className="flex items-start gap-2">
                <Puzzle size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[11px] font-semibold text-white">{plugin.name}</p>
                    {plugin.version && (
                      <span className="text-[9px] text-slate-500">v{plugin.version}</span>
                    )}
                  </div>
                  <p
                    className={
                      plugin.error
                        ? 'text-[10px] text-rose-400'
                        : 'text-[10px] leading-snug text-slate-400'
                    }
                  >
                    {plugin.error ?? plugin.description}
                  </p>
                  {!plugin.error && (
                    <p className="mt-0.5 text-[9px] text-slate-500">
                      {plugin.author} · {plugin.actionCount} action
                      {plugin.actionCount === 1 ? '' : 's'}
                    </p>
                  )}
                </div>
                {plugin.error ? (
                  <AlertTriangle size={14} className="shrink-0 text-rose-400" />
                ) : (
                  <Toggle
                    checked={plugin.enabled}
                    onChange={(value) => void setEnabled(plugin.id, value)}
                  />
                )}
              </div>

              {plugin.enabled && pluginActions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {pluginActions.map((action) => {
                    const Icon = resolveIcon(action.icon)
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => void runAction(action.action, action.label)}
                        className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                      >
                        <Icon size={11} />
                        {action.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Plugins are declarative JSON workflow packs. They bundle permission-gated quick actions —
        no code execution. Copy <span className="text-slate-400">example-pack.json</span> in the
        plugins folder to build your own.
      </p>
    </CollapsibleSection>
  )
}
