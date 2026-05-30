/**
 * v2.0 — ambient indicator for proactive watch tasks.
 *
 * Pre-2.0 the user could enable watch tasks (Long-idle nudge, Morning
 * recap, custom watchers) and they'd quietly fire in the background.
 * Nothing in the UI told you "yes, these are armed and watching" — you
 * had to click into Settings → Voice → Watch tasks to verify. If a
 * task hadn't fired in a while you couldn't tell whether it was working
 * but uneventful, or silently broken.
 *
 * This chip:
 *   - Only renders when at least one watch task is enabled
 *   - Shows the count + most-recent-fire relative time
 *   - Live-updates when the proactive subsystem broadcasts a fire
 *   - Hover reveals each task's last activity
 *   - Click opens Settings (where the task list + controls live)
 *
 * Companion of BudgetIndicator (same "ambient awareness in the header"
 * pattern). Together they make the background machinery visible.
 */
import { useEffect, useRef, useState } from 'react'
import { Eye } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { cn, relativeTime } from '../../lib/utils'
import type { WatchTask } from '@shared/types'

// v2.0 round-5 perf — POLL_INTERVAL_MS removed along with the setInterval.
// Refresh fires on initial mount + on every onProactiveSpeak event. Static
// task-list edits (user creates a new watch in Settings) land via the
// config:updated broadcast at the parent shell level; the "last fired N
// min ago" drift between events is acceptable since the relative-time
// label is updated by React's re-render of the parent surface anyway.

export function ProactiveActivityChip(): JSX.Element | null {
  const [tasks, setTasks] = useState<WatchTask[] | null>(null)
  // Track the last received fire so we can highlight the chip briefly
  // for a few seconds when something just happened — visual heartbeat
  // that says "look, it just did a thing".
  const [flashing, setFlashing] = useState(false)
  const flashTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const list = await vs.proactive.list()
        if (!cancelled) setTasks(list)
      } catch {
        /* IPC hiccup — chip stays on the last known list */
      }
    }
    void refresh()

    // v2.0 round-5 perf — drop the 30s setInterval. Every proactive event
    // already round-trips through `onProactiveSpeak` which re-refreshes
    // tasks; if no events fire, nothing in the task list changes, so the
    // poll was steady SQLite work with zero new information. Static
    // task-list edits (user creates a new watch in Settings) land via
    // the `config:updated` broadcast at the parent shell level.
    const unsub = vs.events.onProactiveSpeak(() => {
      setFlashing(true)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlashing(false), 3000)
      window.setTimeout(() => void refresh(), 50)
    })

    return () => {
      cancelled = true
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      unsub()
    }
  }, [])

  if (!tasks) return null
  const enabled = tasks.filter((t) => t.enabled)
  if (enabled.length === 0) return null

  // Newest fire across all enabled tasks. Used for the relative-time
  // label and the "never fired" empty state — distinguishes "armed
  // but uneventful" from "broken".
  const mostRecent = enabled
    .map((t) => t.lastRun)
    .filter((r): r is string => Boolean(r))
    .sort()
    .pop()

  const tooltip = enabled
    .map((t) => {
      const when = t.lastRun ? relativeTime(t.lastRun) : 'never fired yet'
      const error = t.lastError ? ` · ⚠ ${t.lastError}` : ''
      return `• ${t.name} — last ${when}${error}`
    })
    .join('\n')

  // Header real estate is tight — the chip used to spell out "armed ·
  // 3 min ago" inline (~70-90px) and shoved the Private/Agent toggles
  // off-screen on narrow panels. The fire time is still in the
  // tooltip alongside the per-task last-fired breakdown, so the icon +
  // count alone is enough at a glance. Adds a short relative-time
  // suffix only when there's been a fire AND we're not in a tight
  // layout (the chat panel can be 380px wide on docked Electron).
  // Compromise: render the relative time as a separate span the parent
  // could hide via CSS later, but render it inline by default.
  const relTime = mostRecent ? relativeTime(mostRecent) : null

  return (
    <button
      type="button"
      onClick={() => void vs.window.openSettings()}
      title={`${enabled.length} watch task${enabled.length === 1 ? '' : 's'} armed${relTime ? ` · last fired ${relTime}` : ' · no fires yet'}:\n${tooltip}\n\nClick to open Voice settings.`}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-medium tabular-nums transition hover:brightness-110',
        flashing
          ? 'border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)] shadow-glow'
          : 'border-white/10 bg-white/5 text-slate-400'
      )}
    >
      <Eye size={10} />
      {enabled.length}
    </button>
  )
}
