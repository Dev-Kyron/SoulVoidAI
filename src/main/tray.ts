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
import { getRunningCheckpoints } from './services/storage/agent-checkpoints'
import { MODES } from '@shared/modes'
import { isQuietNow, type AgentCheckpoint } from '@shared/types'
import { broadcast } from './events'
import { beginQuit } from './lifecycle'

let tray: Tray | null = null
/** Snapshot of agent runs at the last poll — drives tooltip + menu copy. */
let agentRuns: AgentCheckpoint[] = []
let agentPollTimer: NodeJS.Timeout | null = null

/** Tray-poll cadence. 4 seconds is fast enough that the user sees the
 *  step counter tick visibly while they're watching, slow enough that
 *  the SQLite SELECT + tray menu rebuild doesn't add measurable
 *  background CPU. */
const AGENT_POLL_INTERVAL_MS = 4000

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

/**
 * Trims a checkpoint's first-user-turn down to a short tray-menu label.
 * The tray menu is narrow; keep snippets ≤ 50 chars including the
 * "Agent: " prefix the caller adds.
 */
function taskSnippet(cp: AgentCheckpoint): string {
  const first = cp.turns.find((t) => t.role === 'user' && t.content)
  const text = first?.content?.replace(/\s+/g, ' ').trim() ?? 'task'
  return text.length > 42 ? `${text.slice(0, 39)}…` : text
}

/**
 * Most agent runs we surface as individual rows in the tray menu before
 * collapsing the rest into a single "+N more" overflow. Three keeps the
 * menu compact even on the unusual day someone has many concurrent
 * agent loops in flight across threads.
 */
const TRAY_AGENT_DISPLAY_CAP = 3

/**
 * Builds the "Agent activity" section of the menu — one disabled label
 * per running checkpoint, capped at TRAY_AGENT_DISPLAY_CAP. Returns an
 * empty array when nothing is in flight so the menu doesn't get
 * cluttered with a hollow header.
 */
function agentActivityItems(): MenuItemConstructorOptions[] {
  if (agentRuns.length === 0) return []
  const items: MenuItemConstructorOptions[] = []
  const visible = agentRuns.slice(0, TRAY_AGENT_DISPLAY_CAP)
  for (const cp of visible) {
    items.push({
      label: `⚙ step ${cp.step} — ${taskSnippet(cp)}`,
      enabled: false
    })
  }
  const overflow = agentRuns.length - visible.length
  if (overflow > 0) {
    items.push({
      label: `…and ${overflow} more run${overflow === 1 ? '' : 's'}`,
      enabled: false
    })
  }
  items.push({
    label: agentRuns.length === 1 ? 'Open the panel to follow' : 'Open the panel to follow runs',
    click: () => openPanelForAgent()
  })
  items.push({ type: 'separator' as const })
  return items
}

/**
 * Surfaces the panel and switches to the chat tab. Used by the
 * "Open the panel to follow" menu item AND by the tray single-click
 * when there's an active agent run — both UX paths are "user wants to
 * see what's happening", and what's happening is in the chat view.
 */
function openPanelForAgent(): void {
  showWindow()
  broadcast('tray:open-tab', 'chat')
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
    // Live agent runs — surfaces between the header and the show/hide so a
    // user with a long task running sees its progress at a glance without
    // opening the panel.
    ...agentActivityItems(),
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

  // Single click toggles the widget. If an agent run is in flight and
  // the panel was hidden, the user almost certainly clicked the tray
  // to peek at progress — so jump straight into the chat tab where
  // they can see the live activity, rather than dropping them on
  // whatever tab they happened to last leave open.
  tray.on('click', () => {
    const win = getWindow()
    const wasHidden = !(win?.isVisible() ?? false)
    if (wasHidden && agentRuns.length > 0) {
      openPanelForAgent()
    } else {
      toggleWindow()
    }
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

/* ------------------------- agent progress polling -------------------------
 *
 * Periodically reads the agent_checkpoints table and reflects any
 * `running` rows on the tray. Pure pull-based design — the renderer
 * doesn't push events; the tray reads the persisted state directly.
 * This keeps the tray correct even when the panel is hidden + the
 * agent loop is running headless (the whole point of B4).
 *
 * Change-detection: only updates the tooltip / rebuilds the menu when
 * the (requestId, step) tuples actually changed since the last tick,
 * so an idle app burns ~zero CPU on the poll.
 * --------------------------------------------------------------------------
 */

function agentStateSignature(runs: AgentCheckpoint[]): string {
  return runs.map((r) => `${r.requestId}:${r.step}`).join('|')
}

function tooltipFor(runs: AgentCheckpoint[]): string {
  if (runs.length === 0) return 'VoidSoul Assistant'
  if (runs.length === 1) return `VoidSoul · agent step ${runs[0].step}`
  return `VoidSoul · ${runs.length} agent runs (latest step ${runs[0].step})`
}

function pollAgentProgress(): void {
  if (!tray) return
  let next: AgentCheckpoint[]
  try {
    next = getRunningCheckpoints()
  } catch {
    // Best-effort. If the DB read fails for any reason, leave the tray
    // showing the last known state rather than thrashing the menu.
    return
  }
  if (agentStateSignature(next) === agentStateSignature(agentRuns)) return
  agentRuns = next
  tray.setToolTip(tooltipFor(next))
  refreshTray()
}

/**
 * Starts the periodic poll. Idempotent — calling twice doesn't stack
 * timers. `.unref()` on the interval handle so a phantom running loop
 * doesn't block app quit if the cleanup path forgets to stop it.
 */
export function startAgentProgressPolling(): void {
  if (agentPollTimer) return
  // Run once immediately so the first poll happens at boot, not 4s later.
  pollAgentProgress()
  agentPollTimer = setInterval(pollAgentProgress, AGENT_POLL_INTERVAL_MS)
  agentPollTimer.unref?.()
}

export function stopAgentProgressPolling(): void {
  if (agentPollTimer) {
    clearInterval(agentPollTimer)
    agentPollTimer = null
  }
}
