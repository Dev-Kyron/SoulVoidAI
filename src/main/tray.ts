/**
 * System tray integration: a persistent VoidSoul orb in the notification area.
 *
 * Beyond the obvious show/hide/quit, the menu also carries the friction-free
 * stuff a "pro" desktop companion is expected to do without opening the
 * panel first: switch mode, run a saved quick prompt, toggle quiet hours.
 */
import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import {
  showWindow,
  toggleWindow,
  getWindow,
  setAlwaysOnTop,
  openSettingsWindow
} from './window'
import { getConfig, getClientConfig, setAppearance, updateConfig } from './services/storage/config'
import { getMemory } from './services/storage/memory'
import { MODES } from '@shared/modes'
import { isQuietNow } from '@shared/types'
import { broadcast } from './events'
import { beginQuit } from './lifecycle'

let tray: Tray | null = null

/** Pushes the latest ClientConfig to every open renderer + refreshes the tray. */
function emitConfigChange(): void {
  broadcast('config:updated', getClientConfig())
  refreshTray()
}

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'tray.png')
    : join(__dirname, '../../resources/tray.png')
}

/** Submenu listing the six modes as radio items; picking one swaps active mode. */
function modeSubmenu(): MenuItemConstructorOptions[] {
  const activeMode = getConfig().activeMode
  return MODES.map((mode) => ({
    label: mode.name,
    type: 'radio' as const,
    checked: mode.id === activeMode,
    click: () => {
      if (mode.id === activeMode) return
      updateConfig({ activeMode: mode.id })
      // The settings window + panel header subtitle listen for this so both
      // surfaces switch instantly without re-fetching config.
      emitConfigChange()
    }
  }))
}

/**
 * Submenu listing the user's saved custom prompts. Picking one summons the
 * panel and fires the prompt into the active chat thread — zero typing.
 */
function quickPromptsSubmenu(): MenuItemConstructorOptions[] {
  const prompts = getMemory().customPrompts
  if (prompts.length === 0) {
    return [
      {
        label: 'No saved prompts yet',
        enabled: false
      },
      { type: 'separator' as const },
      {
        label: 'Add prompts in Settings → Memory',
        click: () => openSettingsWindow()
      }
    ]
  }
  return [
    ...prompts.map<MenuItemConstructorOptions>((prompt) => ({
      label: prompt.label.length > 60 ? `${prompt.label.slice(0, 60)}…` : prompt.label,
      click: () => {
        showWindow()
        // Renderer subscribes to this channel and fires `useChatStore.send`
        // after expanding + switching to the chat tab. See App.tsx.
        broadcast('tray:run-prompt', { prompt: prompt.prompt, label: prompt.label })
      }
    })),
    { type: 'separator' as const },
    {
      label: 'Edit prompts…',
      click: () => openSettingsWindow()
    }
  ]
}

function buildMenu(): Menu {
  const visible = getWindow()?.isVisible() ?? false
  const config = getConfig()
  const onTop = config.appearance.alwaysOnTop
  const dndOn = config.appearance.dnd.enabled
  // Schedule-derived quiet state — distinct from the manual `enabled` toggle.
  // The user can have DND off in the menu (unchecked) yet still be silenced
  // because the scheduled `quietStart → quietEnd` window is active. Surface
  // this on the label so the unchecked box doesn't look like a bug.
  const inQuietHours = isQuietNow(config.appearance.dnd) && !dndOn
  const activeMode = MODES.find((m) => m.id === config.activeMode)?.name ?? config.activeMode

  return Menu.buildFromTemplate([
    { label: 'VoidSoul Assistant', enabled: false },
    { label: `Mode: ${activeMode}`, enabled: false },
    { type: 'separator' },
    {
      label: visible ? 'Hide widget' : 'Show widget',
      click: () => toggleWindow()
    },
    {
      label: 'Open chat',
      click: () => {
        showWindow()
        broadcast('tray:open-tab', 'chat')
      }
    },
    { type: 'separator' },
    {
      label: 'Mode',
      submenu: modeSubmenu()
    },
    {
      // Disable the parent when there's nothing to pick — the user can still
      // see "Quick prompts (empty)" but the menu doesn't open into a near-
      // empty submenu that just says "no prompts yet".
      label:
        getMemory().customPrompts.length === 0
          ? 'Quick prompts (none yet)'
          : 'Quick prompts',
      enabled: getMemory().customPrompts.length > 0,
      submenu: quickPromptsSubmenu()
    },
    { type: 'separator' },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: onTop,
      click: (item) => {
        setAlwaysOnTop(item.checked)
        setAppearance({ alwaysOnTop: item.checked })
        emitConfigChange()
      }
    },
    {
      label: inQuietHours ? 'Do not disturb (quiet hours active)' : 'Do not disturb',
      type: 'checkbox',
      checked: dndOn,
      click: (item) => {
        setAppearance({ dnd: { ...config.appearance.dnd, enabled: item.checked } })
        emitConfigChange()
      }
    },
    {
      label: 'Settings…',
      click: () => {
        openSettingsWindow()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit VoidSoul',
      click: () => {
        beginQuit()
        app.quit()
      }
    }
  ])
}

export function createTray(): Tray {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('VoidSoul Assistant')
  tray.setContextMenu(buildMenu())

  // Single click toggles the widget; refresh the menu so labels stay accurate.
  tray.on('click', () => {
    toggleWindow()
    tray?.setContextMenu(buildMenu())
  })

  // Right-click opens the context menu — rebuild first so time-sensitive
  // labels (e.g. "(quiet hours active)") reflect the schedule at open time
  // rather than at app boot. Cheap; only fires on user interaction.
  tray.on('right-click', () => {
    tray?.setContextMenu(buildMenu())
  })

  return tray
}

export function refreshTray(): void {
  tray?.setContextMenu(buildMenu())
}
