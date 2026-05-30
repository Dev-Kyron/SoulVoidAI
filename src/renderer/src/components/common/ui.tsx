/**
 * Small shared UI primitives used across the panel.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '../../lib/utils'

export function IconButton({
  className,
  children,
  title,
  'aria-label': ariaLabel,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  // Icon-only buttons need an accessible name for screen readers and for
  // automated tests. We default `aria-label` to whatever was passed as
  // `title` (which already exists on every IconButton call site) so a11y
  // gets fixed across the app without touching every consumer. If a caller
  // wants different copy for the tooltip vs. SR text they pass both.
  const accessibleName = ariaLabel ?? title
  return (
    <button
      type="button"
      title={title}
      aria-label={accessibleName}
      {...props}
      className={cn(
        'no-drag inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-300',
        'transition hover:bg-white/10 hover:text-white active:scale-95',
        'disabled:pointer-events-none disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'no-drag relative h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-[var(--accent)]' : 'bg-white/15'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
          checked ? 'left-[18px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

/** An info dot that reveals a mini explanation on hover. */
export function SectionHint({ text }: { text: string }): JSX.Element {
  return (
    <span className="group relative inline-flex items-center">
      <Info
        size={11}
        className="cursor-help text-slate-500 transition group-hover:text-[var(--accent)]"
      />
      <span className="pointer-events-none absolute left-0 top-5 z-50 w-56 rounded-lg border border-white/10 bg-void-800 px-2.5 py-2 text-[10px] font-normal normal-case leading-relaxed tracking-normal text-slate-300 opacity-0 shadow-panel transition-opacity duration-150 group-hover:opacity-100">
        {text}
      </span>
    </span>
  )
}

/**
 * A settings section header — an accent tick, the title, and an optional
 * hover hint that explains what the section is for.
 */
export function SectionLabel({
  children,
  hint
}: {
  children: ReactNode
  hint?: string
}): JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="h-3 w-[3px] shrink-0 rounded-full bg-[var(--accent)]" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">
        {children}
      </span>
      {hint && <SectionHint text={hint} />}
    </div>
  )
}

export function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }): JSX.Element {
  const styles: Record<typeof risk, string> = {
    low: 'bg-emerald-500/15 text-emerald-300',
    medium: 'bg-amber-500/15 text-amber-300',
    high: 'bg-rose-500/15 text-rose-300'
  }
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase', styles[risk])}>
      {risk}
    </span>
  )
}

/**
 * Friendly empty state with an optional title, hint, and call-to-action.
 * The single `text` prop stays supported for legacy call sites; new callers
 * should pass `title` + `hint` for a richer "this is what you can do here"
 * affordance, optionally with a primary action button to fill the gap.
 */
export function EmptyState({
  icon,
  text,
  title,
  hint,
  action
}: {
  icon: ReactNode
  /** Single-line caption (legacy). Ignored when `title`/`hint` are passed. */
  text?: string
  /** Larger headline. Pair with `hint` for the richer two-line empty state. */
  title?: string
  /** Secondary explanatory copy under the title. */
  hint?: string
  /** Optional CTA — `{ label, onClick }` renders as a primary button. */
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="rounded-full bg-white/5 p-3 text-slate-400 ring-1 ring-white/10">{icon}</div>
      {title ? <p className="mt-1 text-[12px] font-semibold text-slate-200">{title}</p> : null}
      {hint || text ? (
        <p className="max-w-[280px] text-[11px] leading-relaxed text-slate-500">{hint ?? text}</p>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
