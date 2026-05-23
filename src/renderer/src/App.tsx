import { useEffect } from 'react'
import { FloatingWidget } from './components/widget/FloatingWidget'
import { Orb } from './components/widget/Orb'
import { QuickAIOverlay } from './components/panel/QuickAIOverlay'
import { GlobalSearchDialog } from './components/chat/GlobalSearchDialog'
import { SetupDiscoveryPanel } from './components/setup/SetupDiscoveryPanel'
import { useConfigStore } from './store/useConfigStore'
import { useUiStore } from './store/useUiStore'
import { useMemoryStore } from './store/useMemoryStore'
import { usePluginStore } from './store/usePluginStore'
import { useProjectsStore } from './store/useProjectsStore'
import {
  useChatStore,
  flushAllPendingSavesAsync,
  subscribeChatChunks
} from './store/useChatStore'
import { CHAT_STRINGS } from './lib/chatStrings'
import { useWidgetStore } from './store/useWidgetStore'
import { vs } from './lib/bridge'
import { useWakeWord } from './lib/useWakeWord'
import { useAccentTheme, useConfigBroadcastSync } from './lib/useConfigBridge'
import { useTheme } from './lib/useTheme'
import { useGlobalSearchHotkey } from './lib/useGlobalSearchHotkey'
import { isQuietNow } from '@shared/types'

export default function App(): JSX.Element {
  const load = useConfigStore((s) => s.load)
  const ready = useConfigStore((s) => s.ready)
  const accent = useConfigStore((s) => s.config?.appearance.accent)
  const glassOpacity = useConfigStore((s) => s.config?.appearance.glassOpacity)
  const onboarded = useConfigStore((s) => s.config?.onboarded)
  const loadMemory = useMemoryStore((s) => s.load)
  const loadPlugins = usePluginStore((s) => s.load)
  const loadChat = useChatStore((s) => s.load)
  const loadProjects = useProjectsStore((s) => s.load)
  const setActiveWindow = useUiStore((s) => s.setActiveWindow)

  useEffect(() => {
    void load()
    void loadMemory()
    void loadPlugins()
    void loadChat()
    void loadProjects()
  }, [load, loadMemory, loadPlugins, loadChat, loadProjects])

  // Wake-word engine — listens continuously when the user has it enabled and
  // a Picovoice access key set. Self-mounts/unmounts based on the toggle.
  useWakeWord()

  // Subscribe to screen-awareness updates from the main process.
  useEffect(() => vs.events.onActiveWindow(setActiveWindow), [setActiveWindow])

  // Streaming-chunks handler — inside useEffect so HMR doesn't stack
  // duplicate listeners on every renderer reload.
  useEffect(() => subscribeChatChunks(), [])

  // Cross-window config sync — picks up edits made in the Settings window.
  useConfigBroadcastSync()

  // Toast the user when a configured monthly-budget threshold is first crossed.
  useEffect(
    () =>
      vs.events.onBudgetWarning(({ level, total, budget }) => {
        const ui = useUiStore.getState()
        const kind = level >= 100 ? 'error' : 'info'
        const dollars = (n: number): string => `$${n.toFixed(2)}`
        ui.pushToast(
          kind,
          level >= 100
            ? `Monthly budget reached — ${dollars(total)} of ${dollars(budget)}.`
            : `Used ${level}% of your ${dollars(budget)} monthly budget (${dollars(total)} so far).`
        )
      }),
    []
  )

  // Toast the user when a freshly-released model lands on a provider they
  // have configured — closes the "day-zero models" gap as fast as the API.
  useEffect(
    () =>
      vs.events.onNewModels(({ provider, models }) => {
        // Reload config so the renderer picks up the updated `seenModels` map.
        void useConfigStore.getState().load()
        const count = models.length
        const preview = models.slice(0, 2).join(', ') + (count > 2 ? `, +${count - 2}` : '')
        useUiStore.getState().pushToast(
          'success',
          `✨ ${count} new ${provider} model${count === 1 ? '' : 's'}: ${preview}`
        )
      }),
    []
  )

  // Scheduled-task completions surface as a toast (in addition to the OS
  // notification the scheduler fires). DND — both the manual override and
  // scheduled quiet hours — suppresses the toast entirely. The scheduler
  // also flags this via the `suppressed` payload field, but we double-check
  // locally in case quiet hours rolled over between the fire and the event.
  useEffect(
    () =>
      vs.events.onScheduledTaskRan(({ name, ok, output, suppressed }) => {
        if (suppressed) return
        const cfg = useConfigStore.getState().config
        if (cfg && isQuietNow(cfg.appearance.dnd)) return
        useUiStore.getState().pushToast(
          ok ? 'success' : 'error',
          ok ? `Scheduled "${name}" ran` : `Scheduled "${name}" failed: ${output.slice(0, 120)}`
        )
      }),
    []
  )

  // Main signals "about to quit — flush debounced saves NOW". We persist
  // every per-thread pending save then ack so main can move on. Without
  // this, the most recent chat turn could be lost if the user quits during
  // the 1.2s debounce window.
  useEffect(
    () =>
      vs.events.onFlushPending(async (token) => {
        try {
          await flushAllPendingSavesAsync()
        } finally {
          // Always ack — even if a save threw, main has its own hard
          // timeout and an absent ack would just delay shutdown.
          await vs.history.flushAllAck(token)
        }
      }),
    []
  )

  // Cmd/Ctrl+F at the app root opens the cross-thread search dialog. The
  // hook lives in `useGlobalSearchHotkey` so SettingsRoot binds the same
  // shortcut — without that, the de-docked Settings window had no Cmd+F.
  useGlobalSearchHotkey('main')

  // When the Settings window asks main to surface the global search (via
  // `vs.window.openGlobalSearch`), main broadcasts this event to the main
  // renderer. We expand the panel so the dialog is visible, then open it.
  useEffect(
    () =>
      vs.events.onOpenGlobalSearch(() => {
        const widget = useWidgetStore.getState()
        if (!widget.expanded) void widget.expand()
        useUiStore.getState().setGlobalSearchOpen(true)
      }),
    []
  )

  // The global summon hotkey: 'toggle' opens/closes the panel, 'expand' opens it.
  useEffect(
    () =>
      vs.events.onSummon((intent) => {
        const widget = useWidgetStore.getState()
        if (intent === 'toggle') void widget.toggle()
        else if (!widget.expanded) void widget.expand()
      }),
    []
  )

  // Tray "Open chat" / "Open logs" → expand the panel and jump to the tab.
  useEffect(
    () =>
      vs.events.onTrayOpenTab(async (tab) => {
        const widget = useWidgetStore.getState()
        if (!widget.expanded) await widget.expand()
        widget.setTab(tab)
      }),
    []
  )

  // Tray quick prompt → expand, jump to chat, send the prompt as a turn.
  // `send()` early-returns when a chat is already streaming, so without an
  // explicit busy guard the user would see "Running …" pop up and then…
  // nothing. Surface a clear "wait for the current reply" toast instead.
  useEffect(
    () =>
      vs.events.onTrayRunPrompt(async ({ prompt, label }) => {
        const widget = useWidgetStore.getState()
        if (!widget.expanded) await widget.expand()
        widget.setTab('chat')
        const ui = useUiStore.getState()
        if (useChatStore.getState().streaming) {
          ui.pushToast('info', `"${label}" — ${CHAT_STRINGS.waitForStream}`)
          return
        }
        ui.pushToast('info', `Running "${label}"…`)
        await useChatStore.getState().send(prompt)
      }),
    []
  )

  // On first ever boot, open the panel so the welcome tour is visible —
  // AND fire the setup-discovery scan once the panel is up, so the magic-
  // moment overlay shows on the user's literal first frame of VoidSoul.
  //
  // We open the discovery panel unconditionally on first launch (even if
  // detection finds nothing) — the panel renders a friendly "nothing
  // found, here's how to configure manually" state in that case. Better
  // to greet every user than silently skip the ones with clean machines.
  useEffect(() => {
    if (ready && onboarded === false) {
      void useWidgetStore.getState().expand()
      useUiStore.getState().setSetupDiscoveryOpen(true)
    }
  }, [ready, onboarded])

  useAccentTheme(accent)
  useTheme()

  // Reflect panel translucency into a CSS custom property.
  useEffect(() => {
    if (glassOpacity === undefined) return
    document.documentElement.style.setProperty('--glass-opacity', String(glassOpacity))
  }, [glassOpacity])

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <Orb size={50} state="processing" />
      </div>
    )
  }

  // Quick AI sits at the top level so the global hotkey works whether the
  // panel is expanded or collapsed (orb-only). Renders nothing until
  // summoned via Ctrl/Cmd+Shift+J.
  return (
    <>
      <FloatingWidget />
      <QuickAIOverlay />
      <GlobalSearchBinding />
      <SetupDiscoveryPanel />
    </>
  )
}

/**
 * Bridges the UI store's `globalSearchOpen` flag to the actual dialog —
 * lives outside the main App body so its selector subscription doesn't
 * re-render the whole tree.
 */
function GlobalSearchBinding(): JSX.Element {
  const open = useUiStore((s) => s.globalSearchOpen)
  const setOpen = useUiStore((s) => s.setGlobalSearchOpen)
  return <GlobalSearchDialog open={open} onClose={() => setOpen(false)} />
}
