/**
 * Command palette — a Ctrl/Cmd+K overlay for fuzzy-running anything: tab
 * navigation, mode switching, voice control and automation quick actions.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search, CornerDownLeft } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useConfigStore } from '../../store/useConfigStore'
import { useWidgetStore, type PanelTab } from '../../store/useWidgetStore'
import { useChatStore } from '../../store/useChatStore'
import { usePluginStore } from '../../store/usePluginStore'
import { MODES, getMode } from '@shared/modes'
import { runAction } from '../../lib/actions'
import { cn } from '../../lib/utils'
import { vs } from '../../lib/bridge'

interface Command {
  id: string
  label: string
  group: string
  run: () => void
}

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

export function CommandPalette(): JSX.Element {
  const open = useUiStore((s) => s.paletteOpen)
  const setPalette = useUiStore((s) => s.setPalette)
  const config = useConfigStore((s) => s.config)
  const pluginActions = usePluginStore((s) => s.actions)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = useMemo<Command[]>(() => {
    if (!config) return []
    const close = (): void => setPalette(false)
    const widget = useWidgetStore.getState()
    const cfg = useConfigStore.getState()
    const chat = useChatStore.getState()
    const list: Command[] = []

    for (const tab of ['nexus', 'chat', 'logs', 'settings'] as PanelTab[]) {
      list.push({
        id: `nav-${tab}`,
        group: 'Navigate',
        label: `Go to ${capitalise(tab)}`,
        run: () => {
          widget.setTab(tab)
          close()
        }
      })
    }

    for (const mode of MODES) {
      list.push({
        id: `mode-${mode.id}`,
        group: 'Mode',
        label: `Switch to ${mode.name} mode`,
        run: () => {
          void cfg.setActiveMode(mode.id).then(() => cfg.setAppearance({ accent: mode.accent }))
          close()
        }
      })
    }

    list.push({
      id: 'voice-toggle',
      group: 'Voice',
      label: config.voice.enabled ? 'Disable spoken replies' : 'Enable spoken replies',
      run: () => {
        void cfg.setVoice({ enabled: !config.voice.enabled })
        close()
      }
    })

    for (const quickAction of getMode(config.activeMode).quickActions) {
      list.push({
        id: `qa-${quickAction.id}`,
        group: 'Action',
        label: quickAction.label,
        run: () => {
          void runAction(quickAction.action, quickAction.label)
          close()
        }
      })
    }

    for (const pluginAction of pluginActions) {
      list.push({
        id: `plugin-${pluginAction.id}`,
        group: 'Plugin',
        label: pluginAction.label,
        run: () => {
          void runAction(pluginAction.action, pluginAction.label)
          close()
        }
      })
    }

    list.push(
      {
        id: 'act-readscreen',
        group: 'Action',
        label: 'Read screen text (OCR)',
        run: () => {
          void runAction({ type: 'read-screen', params: {} }, 'Read screen text')
          close()
        }
      },
      {
        id: 'chat-clear',
        group: 'Chat',
        label: 'Clear conversation',
        run: () => {
          chat.clear()
          close()
        }
      },
      {
        id: 'sys-data',
        group: 'System',
        label: 'Open data folder',
        run: () => {
          void vs.system.openDataFolder()
          close()
        }
      },
      {
        id: 'sys-collapse',
        group: 'System',
        label: 'Collapse to orb',
        run: () => {
          widget.collapse()
          close()
        }
      }
    )
    return list
  }, [config, pluginActions, setPalette])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setSelected(0)
  }, [query])

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((i) => Math.min(i + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      filtered[selected]?.run()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setPalette(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-start justify-center bg-black/65 p-4 pt-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setPalette(false)}
        >
          <motion.div
            className="glass w-full overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: -12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
              <Search size={15} className="text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Run a command…"
                className="flex-1 bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
              />
              <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-slate-400">ESC</kbd>
            </div>

            <div className="scrollbar-void max-h-72 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-slate-500">No matching command.</p>
              ) : (
                filtered.map((command, i) => (
                  <button
                    key={command.id}
                    type="button"
                    onMouseEnter={() => setSelected(i)}
                    onClick={command.run}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                      i === selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-white/5'
                    )}
                  >
                    <span className="flex-1 text-[12px] text-slate-100">{command.label}</span>
                    <span className="text-[8px] uppercase tracking-wider text-slate-500">
                      {command.group}
                    </span>
                    {i === selected && <CornerDownLeft size={12} className="text-[var(--accent)]" />}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
