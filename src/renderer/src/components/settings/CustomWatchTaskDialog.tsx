/**
 * v1.6.0 — custom watch-task builder.
 *
 * Modal form that lets the user assemble a `WatchSpec` and persist it
 * via `vs.proactive.add`. The four built-in tasks shipped in v1.5.0
 * (Task complete / Long idle / Stuck loop / Morning recap) covered the
 * common cases, but the proactive subsystem was always designed as a
 * platform; this dialog flips that design intent into a feature the
 * user can actually use.
 *
 * Form shape:
 *   · Name (free text)
 *   · Condition type (one of 4) — picking this swaps in type-specific
 *     parameter inputs below
 *   · Type-specific params (minutes / active hours / target sentiment / etc.)
 *   · Throttle (don't re-fire within N minutes)
 *   · What Soul says (free text + tone dropdown + interrupt toggle)
 *
 * Saving builds a fully-formed `WatchSpec` and hands it to main; the
 * persisted task lands enabled-by-default (the user just created it on
 * purpose, no reason to make them toggle it on too).
 */
import { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { Toggle } from '../common/ui'
import { TONE_TAGS, type ToneTag } from '@shared/voiceMarkers'
import type { SessionSentimentLabel, WatchConditionType, WatchSpec } from '@shared/types'

const CONDITION_OPTIONS: ReadonlyArray<{
  type: WatchConditionType
  label: string
  hint: string
}> = [
  {
    type: 'idle-duration',
    label: 'Long idle',
    hint: 'Fires when you haven’t typed for N minutes (with optional active-hours window).'
  },
  {
    type: 'task-complete',
    label: 'Task complete',
    hint: 'Fires when a long-running tool call wraps (search, scan, etc).'
  },
  {
    type: 'sentiment-shift',
    label: 'Sentiment shift',
    hint: 'Fires when the emotional context classifier flips to a target label.'
  },
  {
    type: 'time-of-day-window',
    label: 'Time of day',
    hint: 'Daily nudge at a specific local HH:mm.'
  }
]

const SENTIMENT_OPTIONS: ReadonlyArray<{ value: SessionSentimentLabel; label: string }> = [
  { value: 'stressed', label: 'Stressed' },
  { value: 'productive', label: 'Productive' },
  { value: 'stuck', label: 'Stuck' },
  { value: 'excited', label: 'Excited' },
  { value: 'neutral', label: 'Neutral' }
]

// Per-tone human-readable labels. Mirrors the tone catalogue in
// `voicePersona.ts` but kept inline so this component doesn't pull a
// dependency just for one dropdown.
const TONE_LABELS: Record<ToneTag, string> = {
  casual: 'Casual',
  focused: 'Focused',
  excited: 'Excited',
  serious: 'Serious',
  dry: 'Dry',
  encouraging: 'Encouraging',
  playful: 'Playful',
  warm: 'Warm',
  curious: 'Curious',
  thinking: 'Thinking'
}

interface FormState {
  name: string
  type: WatchConditionType
  // idle-duration params
  idleMinutes: number
  idleActiveFrom: string
  idleActiveTo: string
  idleUseActiveHours: boolean
  // task-complete params
  taskMinDurationSec: number
  // sentiment-shift params
  sentimentTo: SessionSentimentLabel
  // time-of-day-window params
  timeAt: string
  // throttle + action
  throttleMinutes: number
  content: string
  tone: ToneTag
  allowInterrupt: boolean
}

const INITIAL_STATE: FormState = {
  name: '',
  type: 'idle-duration',
  idleMinutes: 30,
  idleActiveFrom: '09:00',
  idleActiveTo: '23:00',
  idleUseActiveHours: true,
  taskMinDurationSec: 10,
  sentimentTo: 'stuck',
  timeAt: '09:00',
  throttleMinutes: 60,
  content: '',
  tone: 'warm',
  allowInterrupt: false
}

/** Per-type sensible defaults for throttle so the user doesn't have to
 *  think about it. Override-able on the form. */
const DEFAULT_THROTTLES: Record<WatchConditionType, number> = {
  'idle-duration': 60,
  'task-complete': 1,
  'sentiment-shift': 30,
  'time-of-day-window': 720
}

interface CustomWatchTaskDialogProps {
  open: boolean
  onClose(): void
  /** Called after a successful add so the parent can refresh its list. */
  onAdded(): void
}

export function CustomWatchTaskDialog({
  open,
  onClose,
  onAdded
}: CustomWatchTaskDialogProps): JSX.Element | null {
  const pushToast = useUiStore((s) => s.pushToast)
  const [state, setState] = useState<FormState>(INITIAL_STATE)
  const [submitting, setSubmitting] = useState(false)

  if (!open) return null

  // Swap the throttle default when the type changes so the user lands
  // on a sensible cadence per condition. They can still override.
  const onTypeChange = (next: WatchConditionType): void => {
    setState((s) => ({ ...s, type: next, throttleMinutes: DEFAULT_THROTTLES[next] }))
  }

  const validate = (): string | null => {
    if (!state.name.trim()) return 'Give your task a name.'
    if (!state.content.trim()) return 'What should Soul say when this fires?'
    if (state.throttleMinutes < 1) return 'Throttle must be at least 1 minute.'
    if (state.type === 'idle-duration' && state.idleMinutes < 1) {
      return 'Idle minutes must be at least 1.'
    }
    if (state.type === 'task-complete' && state.taskMinDurationSec < 1) {
      return 'Minimum duration must be at least 1 second.'
    }
    if (state.type === 'time-of-day-window' && !/^\d{1,2}:\d{2}$/.test(state.timeAt)) {
      return 'Time must be in HH:mm format (e.g. 09:00).'
    }
    return null
  }

  const buildSpec = (): WatchSpec => {
    const params: Record<string, unknown> = {}
    if (state.type === 'idle-duration') {
      params.minutes = state.idleMinutes
      if (state.idleUseActiveHours) {
        params.activeFrom = state.idleActiveFrom
        params.activeTo = state.idleActiveTo
      }
    } else if (state.type === 'task-complete') {
      params.minDurationSec = state.taskMinDurationSec
    } else if (state.type === 'sentiment-shift') {
      params.to = state.sentimentTo
    } else if (state.type === 'time-of-day-window') {
      params.at = state.timeAt
    }
    return {
      type: state.type,
      params,
      throttleMinutes: state.throttleMinutes,
      action: {
        type: 'speak',
        content: state.content.trim(),
        tone: state.tone,
        allowInterrupt: state.allowInterrupt
      }
    }
  }

  const onSubmit = async (): Promise<void> => {
    const error = validate()
    if (error) {
      pushToast('error', error)
      return
    }
    setSubmitting(true)
    try {
      await vs.proactive.add({
        name: state.name.trim(),
        spec: buildSpec(),
        // Newly-created tasks land enabled — the user opted in by
        // bothering to build it. They can toggle off in the list if
        // they change their mind.
        enabled: true
      })
      pushToast('success', `Created watch task "${state.name.trim()}".`)
      setState(INITIAL_STATE)
      onAdded()
      onClose()
    } catch (err) {
      pushToast(
        'error',
        err instanceof Error ? `Couldn’t save: ${err.message}` : 'Couldn’t save the task.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="scrollbar-void max-h-[88vh] w-[440px] max-w-[92vw] overflow-y-auto rounded-2xl border border-white/10 bg-void-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
              Proactive voice
            </p>
            <p className="text-[14px] font-semibold text-white">New watch task</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X size={14} />
          </button>
        </header>

        <div className="space-y-4 px-4 py-4">
          <Field label="Name" hint="What you'll see in the task list.">
            <input
              type="text"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              placeholder="e.g. Afternoon break check-in"
              className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white placeholder:text-slate-600 outline-none focus:border-[var(--accent-ring)]"
            />
          </Field>

          <Field label="Condition" hint="What triggers Soul to speak.">
            <select
              value={state.type}
              onChange={(e) => onTypeChange(e.target.value as WatchConditionType)}
              className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
            >
              {CONDITION_OPTIONS.map((o) => (
                <option key={o.type} value={o.type}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-slate-500">
              {CONDITION_OPTIONS.find((o) => o.type === state.type)?.hint}
            </p>
          </Field>

          {state.type === 'idle-duration' && (
            <IdleParams state={state} setState={setState} />
          )}
          {state.type === 'task-complete' && (
            <TaskCompleteParams state={state} setState={setState} />
          )}
          {state.type === 'sentiment-shift' && (
            <SentimentParams state={state} setState={setState} />
          )}
          {state.type === 'time-of-day-window' && (
            <TimeOfDayParams state={state} setState={setState} />
          )}

          <Field
            label="Throttle (minutes)"
            hint="After firing, don't fire again until this many minutes have passed."
          >
            <input
              type="number"
              min={1}
              value={state.throttleMinutes}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  throttleMinutes: Math.max(1, Number(e.target.value) || 1)
                }))
              }
              className="w-32 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
            />
          </Field>

          <div className="border-t border-white/5 pt-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              What Soul says
            </p>

            <Field label="Spoken line">
              <textarea
                value={state.content}
                onChange={(e) => setState((s) => ({ ...s, content: e.target.value }))}
                placeholder="e.g. Hey — quick stretch break?"
                rows={2}
                className="w-full resize-none rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white placeholder:text-slate-600 outline-none focus:border-[var(--accent-ring)]"
              />
            </Field>

            <Field label="Tone">
              <select
                value={state.tone}
                onChange={(e) => setState((s) => ({ ...s, tone: e.target.value as ToneTag }))}
                className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
              >
                {TONE_TAGS.map((tone) => (
                  <option key={tone} value={tone}>
                    {TONE_LABELS[tone]}
                  </option>
                ))}
              </select>
            </Field>

            <div className="mt-3 flex items-center justify-between rounded-md border border-white/5 bg-black/20 px-2.5 py-2">
              <div className="pr-3">
                <p className="text-[11px] text-slate-200">Allow interrupt</p>
                <p className="text-[10px] text-slate-500">
                  If on, this nudge can cut off an in-flight voice clip.
                </p>
              </div>
              <Toggle
                checked={state.allowInterrupt}
                onChange={(v) => setState((s) => ({ ...s, allowInterrupt: v }))}
              />
            </div>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/5 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/5"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={submitting}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-[var(--accent)]/85 disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Create task'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/* -------- generic field row -------- */

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-slate-500">{hint}</p>}
    </div>
  )
}

/* -------- per-type parameter sub-forms -------- */

interface ParamProps {
  state: FormState
  setState: React.Dispatch<React.SetStateAction<FormState>>
}

function IdleParams({ state, setState }: ParamProps): JSX.Element {
  return (
    <>
      <Field label="Minutes idle" hint="Soul measures from your last sent message.">
        <input
          type="number"
          min={1}
          value={state.idleMinutes}
          onChange={(e) =>
            setState((s) => ({ ...s, idleMinutes: Math.max(1, Number(e.target.value) || 1) }))
          }
          className="w-32 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
        />
      </Field>
      <div className="flex items-center justify-between rounded-md border border-white/5 bg-black/20 px-2.5 py-2">
        <div>
          <p className="text-[11px] text-slate-200">Only during active hours</p>
          <p className="text-[10px] text-slate-500">
            Stops Soul from nudging you at 3am if you fell asleep at the keyboard.
          </p>
        </div>
        <Toggle
          checked={state.idleUseActiveHours}
          onChange={(v) => setState((s) => ({ ...s, idleUseActiveHours: v }))}
        />
      </div>
      {state.idleUseActiveHours && (
        <div className="flex gap-3">
          <Field label="From">
            <input
              type="time"
              value={state.idleActiveFrom}
              onChange={(e) => setState((s) => ({ ...s, idleActiveFrom: e.target.value }))}
              className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
            />
          </Field>
          <Field label="To">
            <input
              type="time"
              value={state.idleActiveTo}
              onChange={(e) => setState((s) => ({ ...s, idleActiveTo: e.target.value }))}
              className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
            />
          </Field>
        </div>
      )}
    </>
  )
}

function TaskCompleteParams({ state, setState }: ParamProps): JSX.Element {
  return (
    <Field
      label="Minimum duration (seconds)"
      hint="Only fire for tool calls slower than this — keeps noise out of fast actions."
    >
      <input
        type="number"
        min={1}
        value={state.taskMinDurationSec}
        onChange={(e) =>
          setState((s) => ({
            ...s,
            taskMinDurationSec: Math.max(1, Number(e.target.value) || 1)
          }))
        }
        className="w-32 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
      />
    </Field>
  )
}

function SentimentParams({ state, setState }: ParamProps): JSX.Element {
  return (
    <Field label="Target sentiment" hint="Soul fires when the classifier shifts to this label.">
      <select
        value={state.sentimentTo}
        onChange={(e) =>
          setState((s) => ({ ...s, sentimentTo: e.target.value as SessionSentimentLabel }))
        }
        className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
      >
        {SENTIMENT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

function TimeOfDayParams({ state, setState }: ParamProps): JSX.Element {
  return (
    <Field label="Fire at" hint="Local time. Soul fires once per day in the minute matching this.">
      <input
        type="time"
        value={state.timeAt}
        onChange={(e) => setState((s) => ({ ...s, timeAt: e.target.value }))}
        className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[var(--accent-ring)]"
      />
    </Field>
  )
}
