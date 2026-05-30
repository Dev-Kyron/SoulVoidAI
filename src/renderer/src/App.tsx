import { useEffect, useRef } from 'react'
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
  subscribeChatChunks,
  refreshSentimentBlock
} from './store/useChatStore'
import { CHAT_STRINGS } from './lib/chatStrings'
import { useWidgetStore } from './store/useWidgetStore'
import { vs } from './lib/bridge'
import { enqueueSpeak } from './lib/voice'
import { useWakeWord } from './lib/useWakeWord'
import { useWakeBroadcastSync } from './lib/wakeBridge'
import { useAccentTheme, useConfigBroadcastSync } from './lib/useConfigBridge'
import { useTheme } from './lib/useTheme'
import { useGlobalSearchHotkey } from './lib/useGlobalSearchHotkey'
import { isQuietNow } from '@shared/types'
import { resolveEffectivePersona } from '@shared/voicePersona'

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
  const setScreenSnapshot = useUiStore((s) => s.setScreenSnapshot)

  useEffect(() => {
    void load()
    void loadMemory()
    void loadPlugins()
    void loadChat()
    void loadProjects()
    // v1.4.0 — pull the latest sentiment block once on boot so the very
    // first message's system prompt has it (instead of waiting for the
    // 2nd send to populate the cache via the post-classifier refresh).
    void refreshSentimentBlock()
  }, [load, loadMemory, loadPlugins, loadChat, loadProjects])

  // Wake-word engine — listens continuously when the user has it enabled and
  // a Picovoice access key set. Self-mounts/unmounts based on the toggle.
  useWakeWord()

  // Subscribe to screen-awareness updates from the main process.
  useEffect(() => vs.events.onActiveWindow(setActiveWindow), [setActiveWindow])

  // v2.0 — semantic screen-awareness snapshots. Holds the latest OCR
  // text excerpt + window context in the UI store so the chat composer
  // can inject it into the system prompt. Without this subscription
  // the broadcast is dead-letter — main pays the OCR cost for nothing
  // and the system prompt's promise that the model "sees your screen
  // text" is empty. (Bug-sweep #196 fix.)
  useEffect(() => vs.events.onScreenSnapshot(setScreenSnapshot), [setScreenSnapshot])

  // Streaming-chunks handler — inside useEffect so HMR doesn't stack
  // duplicate listeners on every renderer reload.
  useEffect(() => subscribeChatChunks(), [])

  // Cross-window config sync — picks up edits made in the Settings window.
  useConfigBroadcastSync()
  // Cross-window WAKE sync — picks up Arm/Disarm clicks from Settings
  // and mirrors engine state back so Settings shows the truth, not a
  // local-store lie. Both windows mount this; main is the engine host,
  // Settings is the UI control surface.
  useWakeBroadcastSync()

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
        useUiStore
          .getState()
          .pushToast(
            'success',
            `✨ ${count} new ${provider} model${count === 1 ? '' : 's'}: ${preview}`
          )
      }),
    []
  )

  // Update notifier — surface electron-updater state changes as toasts
  // instead of leaving them to passive discovery in the About panel. Beta
  // feedback flagged that auto-updates were technically working but
  // invisible: users only noticed after manually opening Settings → About.
  //
  // Dedupe via a ref tracking the last notified version. Without it the
  // updater's repeated 'available' broadcasts (status snapshot fires on
  // every config reload + every progress tick) would re-toast every few
  // seconds. We notify exactly twice per release: once when the download
  // starts and once when it's ready to install.
  const lastNotifiedUpdate = useRef<{ available?: string; downloaded?: string }>({})
  useEffect(
    () =>
      vs.events.onUpdaterStatus((status) => {
        if (status.kind === 'available') {
          if (lastNotifiedUpdate.current.available === status.version) return
          lastNotifiedUpdate.current.available = status.version
          useUiStore
            .getState()
            .pushToast(
              'info',
              `✨ Update v${status.version} available — downloading in the background.`
            )
        } else if (status.kind === 'downloaded') {
          if (lastNotifiedUpdate.current.downloaded === status.version) return
          lastNotifiedUpdate.current.downloaded = status.version
          // Stickier toast for the "ready to install" state — this is the
          // call-to-action. The pushToast helper doesn't currently support
          // an action button, but mentioning the path in the copy gives
          // the user a concrete next step. Settings → About has the
          // restart button wired already (UpdaterRow.tsx).
          useUiStore
            .getState()
            .pushToast(
              'success',
              `🚀 Update v${status.version} ready. Open Settings → About to restart and install.`
            )
        }
      }),
    []
  )

  // The dispatcher auto-swapped to a different provider mid-request because
  // the user's selection hit a 429 / quota / server-overload. Surface this
  // explicitly — silently switching would be confusing ("why is this reply
  // styled like Claude when I picked Gemini?"). The reason is kept short so
  // the toast doesn't grow into a paragraph.
  useEffect(
    () =>
      vs.events.onProviderFallback(({ fromLabel, toLabel, reason }) => {
        const shortReason = reason.includes('429')
          ? 'quota / rate limit'
          : reason.length > 80
            ? `${reason.slice(0, 77)}…`
            : reason
        useUiStore
          .getState()
          .pushToast(
            'info',
            `${fromLabel} unavailable (${shortReason}) — replied via ${toLabel} instead.`
          )
      }),
    []
  )

  // v1.5.0 — proactive watch tasks. Main process fires a broadcast when
  // a watch task condition trips; we drop the supplied content into the
  // existing Web Audio queue with the supplied tone (or speak a
  // morning-recap placeholder if dynamicRecap is true — real summariser
  // is a v1.5.1 follow-up). DND + voice mute + master toggle are
  // enforced in main before this fires; we re-check voice.enabled
  // defensively in case the config snapshot has drifted between
  // processes.
  useEffect(
    () =>
      vs.events.onProactiveSpeak(({ content, tone, taskName, dynamicRecap }) => {
        const config = useConfigStore.getState().config
        if (!config || !config.voice.enabled) return
        const spoken = dynamicRecap
          ? "Morning. I'll have a proper recap for you in the next update."
          : content
        if (!spoken) return
        // v2.0 — pick the persona via the active mode's per-mode
        // override so proactive nudges speak in the same voice the
        // current chat session would. Without this the proactive
        // subsystem always used the global persona regardless of
        // mode, which breaks the user's "switch from Soul to Void
        // mid-chat" expectation.
        const persona = resolveEffectivePersona(config.voice, config.activeMode)
        enqueueSpeak(spoken, persona, config.voice.rate, config.voice.volume, tone)
        useUiStore.getState().pushToast('info', `Proactive nudge: ${taskName}`)
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
      vs.events.onScheduledTaskRan(({ name, ok, output, suppressed, threadId }) => {
        // Research-mode briefs sidebar-refresh even under DND so the new
        // thread is visible the moment the user returns from quiet hours
        // — the toast is suppressed, not the persistence. A sidebar-only
        // refresh (not the full `load(true)`) preserves any in-flight
        // streaming on the currently-active thread; otherwise a brief
        // landing mid-reply would clobber `streaming` + `pendingRequestId`.
        if (ok && threadId) {
          void vs.history.summaries().then(({ summaries }) => {
            useChatStore.setState({ threads: summaries })
          })
        }
        if (suppressed) return
        const cfg = useConfigStore.getState().config
        if (cfg && isQuietNow(cfg.appearance.dnd)) return
        useUiStore
          .getState()
          .pushToast(
            ok ? 'success' : 'error',
            ok
              ? threadId
                ? `Brief ready for "${name}" — see the new thread`
                : `Scheduled "${name}" ran`
              : `Scheduled "${name}" failed: ${output.slice(0, 120)}`
          )
      }),
    []
  )

  // OS notification click → deep-link to the freshly-saved research thread.
  // The toast above also fires on the same event but doesn't auto-switch
  // threads (that would be disruptive mid-conversation). This handler only
  // runs when the user explicitly clicks the notification, signalling
  // intent to see the brief NOW. switchThread early-returns mid-stream;
  // we surface a toast in that case so the click isn't silently dropped.
  useEffect(
    () =>
      vs.events.onSchedulerOpenBrief(({ threadId, taskName }) => {
        // The subscribe layer doesn't await async handlers, so a throw
        // anywhere in the chain (history IPC rejects during main quit,
        // switchThread races a thread deletion) becomes an unhandled
        // rejection with no toast and only a devtools console warning.
        // Wrap in an explicit catch so the failure mode is at least
        // visible to the user.
        void (async () => {
          try {
            // Sidebar may be stale (the brief just landed); refresh first
            // so switchThread can find the new threadId in state.threads.
            // Sidebar-only refresh — same reasoning as the task-ran handler:
            // a full load(true) would nuke an in-flight stream on the
            // currently-active thread.
            const { summaries } = await vs.history.summaries()
            useChatStore.setState({ threads: summaries })
            const widget = useWidgetStore.getState()
            if (!widget.expanded) await widget.expand()
            widget.setTab('chat')
            const chat = useChatStore.getState()
            if (chat.streaming) {
              useUiStore
                .getState()
                .pushToast(
                  'info',
                  `Brief for "${taskName}" is in the sidebar — finish the current reply to open it.`
                )
              return
            }
            await chat.switchThread(threadId)
          } catch (err) {
            useUiStore
              .getState()
              .pushToast(
                'error',
                `Couldn't open the brief for "${taskName}" — ${err instanceof Error ? err.message : String(err)}`
              )
          }
        })()
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
        // v1.5.0 — any summon (wake-word trigger, hotkey, tray click)
        // is a fresh user signal. Bump the idle tracker so a "Long idle"
        // watch doesn't fire moments after the user just woke Soul up.
        void vs.proactive.bumpInteraction().catch(() => {
          /* non-fatal */
        })
      }),
    []
  )

  // v1.9.0/1.9.1 — visual-click failure + progress toasts. Without this,
  // a failed click_on_screen returns ok:false but the chat surface just
  // renders a green checkmark for "tool dispatched" and the user sees
  // no visible indication that nothing happened. Two toast shapes:
  //   · progress=true   → info toast with a status message ("Looking
  //                       for X…", "Asking the model…") so the user
  //                       knows the pipeline is running during the
  //                       2-8s before the preview HUD appears
  //   · progress absent → error toast with description + reason
  useEffect(
    () =>
      vs.events.onVisualClickFailure(({ description, reason, progress }) => {
        if (progress) {
          useUiStore.getState().pushToast('info', reason)
        } else {
          useUiStore.getState().pushToast('error', `Couldn't click "${description}" — ${reason}`)
        }
      }),
    []
  )

  // v2.0 — Conversation-mode global hotkey. Toggles in/out of the
  // hands-free voice loop. Lazily imports the store so users who never
  // use the hotkey don't pay the cost of constructing the controller.
  useEffect(
    () =>
      vs.events.onConversationToggle(async () => {
        const widget = useWidgetStore.getState()
        if (!widget.expanded) await widget.expand()
        const { useConversationStore } = await import('./store/useConversationStore')
        void useConversationStore.getState().toggle()
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
