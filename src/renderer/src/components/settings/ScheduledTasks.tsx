/**
 * Scheduled tasks panel. Lets the user define prompts that fire on a schedule
 * ("Every morning at 9: list my GitHub issues"). Three schedule kinds are
 * supported — daily HH:mm, every N minutes, or one-shot at a future timestamp.
 *
 * Each task runs headlessly through the active provider; results land as an
 * OS notification + a toast + a "last result" preview in this panel.
 */
import { useEffect, useState } from 'react'
import { Plus, Play, Trash2, Clock, RefreshCw, AlarmClock, Telescope } from 'lucide-react'
import { CollapsibleSection } from './CollapsibleSection'
import { EmptyState, Toggle } from '../common/ui'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import type { ScheduledTask, ScheduleKind, TaskMode } from '@shared/types'

const FIELD =
  'rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

function describeSchedule(kind: ScheduleKind, value: string): string {
  if (kind === 'daily') return `Daily at ${value}`
  if (kind === 'interval') return `Every ${value} minute${value === '1' ? '' : 's'}`
  if (kind === 'once') {
    try {
      return `Once on ${new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
    } catch {
      return `Once on ${value}`
    }
  }
  return value
}

function relativeFuture(iso: string | null): string {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'due now'
  const m = Math.round(diff / 60_000)
  if (m < 60) return `in ${m} min`
  const h = Math.round(diff / 3_600_000)
  if (h < 24) return `in ${h}h`
  const d = Math.round(diff / 86_400_000)
  return `in ${d}d`
}

function TaskRow({ task, onChange }: { task: ScheduledTask; onChange: () => void }): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await vs.scheduler.runNow(task.id)
    } catch (err) {
      pushToast(
        'error',
        `Couldn't run "${task.name}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
    setBusy(false)
    onChange()
  }
  // v2.0 round-3 polish — wrap remove/toggle in try/catch + error toast so
  // a failed IPC (file locked, scheduler died, malformed entry) doesn't
  // silently show a success toast and leave the user wondering why the
  // task reappears next refresh.
  const remove = async (): Promise<void> => {
    try {
      await vs.scheduler.remove(task.id)
      pushToast('info', `Removed "${task.name}".`)
    } catch (err) {
      pushToast(
        'error',
        `Couldn't remove "${task.name}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
    onChange()
  }
  const toggle = async (enabled: boolean): Promise<void> => {
    try {
      await vs.scheduler.setEnabled(task.id, enabled)
    } catch (err) {
      pushToast(
        'error',
        `Couldn't ${enabled ? 'enable' : 'disable'} "${task.name}": ${err instanceof Error ? err.message : String(err)}`
      )
    }
    onChange()
  }

  const isResearch = task.mode === 'research'
  return (
    <div className="glass-soft space-y-1.5 rounded-lg p-2.5">
      <div className="flex items-start gap-2">
        {isResearch ? (
          <Telescope size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        ) : (
          <AlarmClock size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[12px] font-medium text-slate-100">
            <span className="truncate">{task.name}</span>
            {isResearch && (
              <span className="rounded bg-[var(--accent)]/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                Research
              </span>
            )}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-400">{task.prompt}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <Clock size={9} /> {describeSchedule(task.scheduleKind, task.scheduleValue)}
            </span>
            <span>next: {relativeFuture(task.nextRun)}</span>
            {task.lastRun && (
              <span>
                last:{' '}
                {new Date(task.lastRun).toLocaleString([], {
                  dateStyle: 'short',
                  timeStyle: 'short'
                })}
              </span>
            )}
          </p>
        </div>
        <Toggle checked={task.enabled} onChange={(v) => void toggle(v)} />
      </div>

      {(task.lastResult || task.lastError) && (
        <div
          className={cn(
            'rounded-md px-2 py-1 text-[10px]',
            task.lastError ? 'bg-rose-500/10 text-rose-200' : 'bg-emerald-500/10 text-emerald-100'
          )}
        >
          <p className="line-clamp-3 whitespace-pre-wrap">{task.lastError ?? task.lastResult}</p>
        </div>
      )}

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? <RefreshCw size={10} className="animate-spin" /> : <Play size={10} />}
          Run now
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => void remove()}
              className="rounded-md bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-500/30"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Delete"
            className="rounded-md p-1 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

function NewTaskForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<ScheduleKind>('daily')
  const [value, setValue] = useState('09:00')
  const [mode, setMode] = useState<TaskMode>('prompt')
  const [busy, setBusy] = useState(false)

  const placeholder =
    kind === 'daily'
      ? '09:00'
      : kind === 'interval'
        ? '60'
        : new Date(Date.now() + 60_000).toISOString().slice(0, 16)

  const submit = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim() || !value.trim()) {
      pushToast(
        'error',
        mode === 'research'
          ? 'Name, topic and schedule are all required.'
          : 'Name, prompt and schedule are all required.'
      )
      return
    }
    setBusy(true)
    try {
      const normValue =
        kind === 'once' && value.length === 16
          ? new Date(value).toISOString() // local datetime-local → ISO
          : value
      await vs.scheduler.add({
        name: name.trim(),
        prompt: prompt.trim(),
        scheduleKind: kind,
        scheduleValue: normValue,
        mode
      })
      setName('')
      setPrompt('')
      pushToast(
        'success',
        mode === 'research' ? `Scheduled research "${name.trim()}".` : `Scheduled "${name.trim()}".`
      )
      onCreated()
    } finally {
      setBusy(false)
    }
  }

  // Research-mode reframes the form: the "prompt" is actually a research
  // topic, and the placeholder hints at the overnight briefing workflow.
  // The label + placeholder change only — submit + storage shape stay
  // identical so toggling the switch mid-typing doesn't clear the field.
  const promptPlaceholder =
    mode === 'research'
      ? 'Topic to research (e.g. "What launched in AI tooling this week — focus on coding agents and dev workflows.")'
      : 'Prompt to send headlessly (e.g. List my open GitHub issues assigned to me, ranked by priority.)'

  return (
    <div className="glass-soft space-y-1.5 rounded-lg p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">New task</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={
          mode === 'research'
            ? 'Name (e.g. Morning AI roundup)'
            : 'Name (e.g. Morning GitHub digest)'
        }
        className={cn(FIELD, 'w-full')}
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={promptPlaceholder}
        rows={3}
        className={cn(FIELD, 'w-full resize-none')}
      />
      <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-white/5 bg-black/20 px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-200">
          <Telescope size={11} className="text-[var(--accent)]" />
          Deep research
          <span className="text-[10px] text-slate-500">
            — runs the multi-step pipeline and saves the brief to a new chat
          </span>
        </span>
        <Toggle
          checked={mode === 'research'}
          onChange={(v) => setMode(v ? 'research' : 'prompt')}
        />
      </label>
      <div className="flex gap-1.5">
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as ScheduleKind
            setKind(k)
            setValue(
              k === 'daily'
                ? '09:00'
                : k === 'interval'
                  ? '60'
                  : new Date(Date.now() + 60_000).toISOString().slice(0, 16)
            )
          }}
          className={FIELD}
        >
          <option value="daily" className="bg-void-700">
            Daily at…
          </option>
          <option value="interval" className="bg-void-700">
            Every N minutes
          </option>
          <option value="once" className="bg-void-700">
            Once at…
          </option>
        </select>
        <input
          type={kind === 'daily' ? 'time' : kind === 'once' ? 'datetime-local' : 'number'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          min={kind === 'interval' ? 1 : undefined}
          className={cn(FIELD, 'flex-1')}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          <Plus size={12} />
          Add
        </button>
      </div>
    </div>
  )
}

export function ScheduledTasks(): JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])

  const refresh = async (): Promise<void> => {
    setTasks(await vs.scheduler.list())
  }

  useEffect(() => {
    void refresh()
    const off = vs.events.onScheduledTaskRan(() => void refresh())
    return off
  }, [])

  return (
    <CollapsibleSection
      title="Scheduled tasks"
      hint='Prompts that fire on a schedule. Headless — uses the active provider/model. Flip "Deep research" on and the task will plan, search, fetch and brief you in a new thread instead.'
    >
      <div className="space-y-2">
        <NewTaskForm onCreated={() => void refresh()} />
        {tasks.length === 0 ? (
          <EmptyState
            icon={<AlarmClock size={20} />}
            title="No scheduled tasks yet"
            hint='Add one above — try "Daily at 09:00 · List my open GitHub issues" or "Every 60 minutes · Summarise what changed in my Spiritless folder."'
          />
        ) : (
          tasks.map((task) => <TaskRow key={task.id} task={task} onChange={() => void refresh()} />)
        )}
      </div>
    </CollapsibleSection>
  )
}
