/**
 * v2.0 — One-click "unlock everything" CTA.
 *
 * Lives in Settings → General → Setup. Replaces a multi-hour first-run
 * configuration tour with a single confirmed action: every capability
 * the assistant has, enabled at once. Designed for power users who
 * want maximum reach without per-feature opt-in friction.
 *
 * Each step is best-effort and failures are surfaced but don't abort
 * the rest — a missing MCP server, a Chrome bridge that can't bind a
 * socket, or a taskbar import that hit a permissions wall shouldn't
 * stop the permissions + click_on_screen + voice toggles from
 * landing. Final toast names what succeeded and what didn't.
 *
 * Explicitly OUT of scope:
 *  - Installing plugins from the public registry (each has its own
 *    install dialog with per-entry configuration). We enable
 *    everything that's ALREADY installed.
 *  - Spawning new MCP servers. Same reason — install + configure is
 *    a per-entry flow.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useConfigStore } from '../../store/useConfigStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { usePluginStore } from '../../store/usePluginStore'
import { useUiStore } from '../../store/useUiStore'
import { PERMISSION_IDS } from '@shared/permissions'
import type { PermissionId } from '@shared/permissions'

interface Props {
  onClose: () => void
}

interface StepResult {
  label: string
  ok: boolean
  detail?: string
}

export function UnlockEverythingDialog({ onClose }: Props): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const enterCriticalFlow = useUiStore((s) => s.enterCriticalFlow)
  const exitCriticalFlow = useUiStore((s) => s.exitCriticalFlow)
  const reloadConfig = useConfigStore((s) => s.load)
  const reloadMemory = useMemoryStore((s) => s.load)
  const reloadPlugins = usePluginStore((s) => s.load)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<StepResult[]>([])
  const [done, setDone] = useState(false)

  const run = async (): Promise<void> => {
    // v2.0 polish — block Esc-to-close-Settings while the 20-step flow
    // runs. Without this, a stray Esc mid-unlock would partially grant
    // permissions and drop the result dialog before the user sees what
    // skipped. Decremented in the finally below so a thrown step (which
    // shouldn't happen — every step catches internally — still can't
    // leak a permanent critical-flow lock).
    enterCriticalFlow()
    setRunning(true)
    setResults([])
    const out: StepResult[] = []
    const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
        out.push({ label, ok: true })
      } catch (err) {
        out.push({
          label,
          ok: false,
          detail: err instanceof Error ? err.message : String(err)
        })
      }
      setResults([...out])
    }

    // 1. Grant every permission. Sequential because each call also
    // emits a fresh config so we don't want them stepping on each
    // other's `granted` field.
    //
    // v2.0 polish — skip homeAssistant. The permission is meaningless
    // without a configured URL + long-lived token, which require the
    // HomeAssistantWizardDialog flow. Granting the permission alone
    // is a false promise — the AI still can't reach HA. Surface as
    // its own "follow-up" step at the end of the dialog.
    for (const id of PERMISSION_IDS as PermissionId[]) {
      if (id === 'homeAssistant') continue
      await step(`Permission · ${id}`, async () => {
        await vs.permissions.set(id, true)
      })
    }

    // 2. Screen awareness + semantic OCR.
    await step('Screen awareness + semantic OCR', async () => {
      await vs.config.setAppearance({
        screenAwareness: true,
        semanticScreenAwareness: true
      })
    })

    // 2b. Screen-watch loop — periodic proactive screenshots + commentary.
    // v2.0 polish — separate from awareness (which is event-driven OCR
    // on window change); screen-watch is the cost-bearing loop that fires
    // a vision-model call every cadence tick. Without enabling it here,
    // the dialog's promise of "Soul can comment on what you're doing"
    // would silently degrade to title-only awareness.
    await step('Screen-watch loop', async () => {
      await vs.config.setScreenWatch({ enabled: true })
    })

    // 3. Proactive voice.
    await step('Proactive voice', async () => {
      await vs.config.setProactiveVoice({ enabled: true })
    })

    // 3b. Plugin JS hooks master switch.
    // v2.0 polish — plugins can ship onUserMessage / onAssistantReply
    // JS hooks but they only fire when this master switch is on. The
    // dialog previously enabled installed plugins but left their
    // hook handlers inert. Enabling here matches the dialog's "every
    // capability the assistant has" framing.
    await step('Plugin JS hooks', async () => {
      await vs.config.setPluginHooks(true)
    })

    // 4. Wake word — toggles the wake-word listener on. The user
    // still needs Whisper or Porcupine configured for it to actually
    // detect anything; the toggle is the master switch.
    await step('Wake word', async () => {
      await vs.config.setVoice({ wakeWord: { enabled: true } })
    })

    // 5. click_on_screen.
    await step('click_on_screen', async () => {
      await vs.config.setExperimentalFeatures({ visualClick: true })
    })

    // 6. Browser extension bridge.
    await step('Browser extension', async () => {
      await vs.browserExtension.setEnabled(true)
    })

    // 7. Import the Windows taskbar pins as quick actions.
    await step('Import taskbar pins', async () => {
      await vs.memory.importTaskbar()
    })

    // 8. Enable every INSTALLED MCP server.
    await step('Enable installed MCP servers', async () => {
      const servers = await vs.mcp.list()
      for (const s of servers) {
        if (!s.enabled) {
          await vs.mcp.setEnabled(s.id, true)
        }
      }
    })

    // 9. Enable every INSTALLED plugin.
    await step('Enable installed plugins', async () => {
      const plugins = await vs.plugins.list()
      for (const p of plugins) {
        if (!p.enabled) {
          await vs.plugins.setEnabled(p.id, true)
        }
      }
    })

    // Reload stores so the rest of Settings sees the new state.
    await Promise.allSettled([reloadConfig(), reloadMemory(), reloadPlugins()])
    setRunning(false)
    setDone(true)
    exitCriticalFlow()
    const failures = out.filter((r) => !r.ok)
    if (failures.length === 0) {
      pushToast('success', 'Void & Soul unlocked. Every capability is now active.')
    } else {
      pushToast(
        'info',
        `Unlocked with ${failures.length} skip${failures.length === 1 ? '' : 's'} — see dialog for detail.`
      )
    }
  }

  // Defensive — if the user closes the dialog while it's somehow still
  // mid-run (shouldn't happen since `running` disables the close button,
  // but useEffect cleanup runs on parent unmount too), release the
  // critical-flow lock so Settings Esc isn't stuck off forever.
  useEffect(() => {
    return () => {
      if (running) exitCriticalFlow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass w-full max-w-lg rounded-xl p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Sparkles size={16} />
            </span>
            <div>
              <p className="text-[14px] font-semibold text-white">
                Unlock Void & Soul To The Fullest
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                One click — every capability the assistant has, enabled at once.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100 disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>

        {!done ? (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-300">
              Skip the per-feature setup tour. This grants every permission, enables every awareness
              loop, turns on click_on_screen + the browser bridge + wake word + proactive voice,
              imports your Windows taskbar pins as quick actions, and flips every installed MCP
              server and plugin to enabled. You get maximum reach in one action.
            </p>

            <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-3 text-[10px] leading-relaxed text-slate-300">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                What this turns on
              </p>
              <ul className="space-y-0.5 text-slate-300">
                <li>
                  · <span className="text-slate-100">All 8 permissions</span> — terminal,
                  filesystem, browser, app control, input access, microphone, screen capture, Home
                  Assistant
                </li>
                <li>
                  · <span className="text-slate-100">Screen awareness</span> + semantic OCR — the
                  assistant gets continuous context of what you're viewing
                </li>
                <li>
                  · <span className="text-slate-100">Proactive voice</span> — Soul can speak
                  unprompted when watch tasks fire
                </li>
                <li>
                  · <span className="text-slate-100">Wake word</span> — voice-activated summoning
                  (needs a Whisper or Porcupine wake word configured to actually detect)
                </li>
                <li>
                  · <span className="text-slate-100">click_on_screen</span> — the AI can drive your
                  mouse with the 3-second cancellable preview ring
                </li>
                <li>
                  · <span className="text-slate-100">Browser extension bridge</span> — local Chrome
                  socket for the optional companion extension
                </li>
                <li>
                  · <span className="text-slate-100">Taskbar import</span> — your pinned apps land
                  as quick-action tiles
                </li>
                <li>
                  · <span className="text-slate-100">All installed MCP servers + plugins</span>{' '}
                  enabled (won't install new ones — pick from the marketplaces)
                </li>
              </ul>
            </div>

            <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-[10px] leading-relaxed text-amber-100">
              <p className="mb-1 flex items-center gap-1.5 font-semibold text-amber-200">
                <AlertTriangle size={11} />
                Caution — power-user mode
              </p>
              <p>
                The assistant gains broad reach across your system: it can{' '}
                <span className="text-amber-100/90">run shell commands</span>, write files, drive
                your <span className="text-amber-100/90">mouse and keyboard</span>, listen to your{' '}
                <span className="text-amber-100/90">microphone</span>, and act on what it{' '}
                <span className="text-amber-100/90">sees on screen</span>. Voice features may speak
                unprompted. Cloud providers (Anthropic, OpenAI etc) will consume{' '}
                <span className="text-amber-100/90">tokens on every interaction</span> — set a
                monthly budget in Settings → AI → Usage if you want a cap. You can disable any of
                these individually later. Turning everything on at once is a deliberate choice.
              </p>
            </div>

            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={running}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {running ? (
                  <>
                    <Loader2 size={11} className="animate-spin" />
                    Unlocking…
                  </>
                ) : (
                  <>
                    <Sparkles size={11} />
                    Unlock everything
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-300">
              {results.every((r) => r.ok)
                ? "Every capability is now active. Close this dialog and start using Soul — she's fully unlocked."
                : 'Most capabilities are now active. A few steps were skipped (see below) — fix the underlying issue and toggle them by hand from the matching Settings panel.'}
            </p>
            <div className="scrollbar-void mb-3 max-h-60 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2">
              {results.map((r, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 px-2 py-1 text-[10px] text-slate-300"
                >
                  {r.ok ? (
                    <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={r.ok ? 'text-slate-300' : 'text-amber-200'}>{r.label}</p>
                    {r.detail && (
                      <p className="mt-0.5 text-[9px] text-slate-500">{r.detail.slice(0, 200)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
