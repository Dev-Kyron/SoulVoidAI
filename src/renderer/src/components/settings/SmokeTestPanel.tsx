/**
 * Permission smoke-test panel. Settings → Advanced surface that actually
 * exercises filesystem / shell / MCP filesystem and reports pass/fail with
 * the underlying error message, so the user can verify the stack works
 * without trial-and-erroring inside chat.
 *
 * v1.13.0–v1.13.4 chased a "the AI can't reach my files" bug that turned
 * out to be the router silently switching providers + gpt-4o-mini refusing
 * tool calls — not a permission failure. This panel makes the permission
 * layer's behaviour observable in one click so future "can it actually
 * read?" questions get a deterministic answer.
 */
import { useState } from 'react'
import { CheckCircle2, CircleSlash, Loader2, ShieldAlert, XCircle } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import { CollapsibleSection } from './CollapsibleSection'
import type { SmokeCheck, SmokeStatus } from '@shared/types'

/** Icon + colour scheme per status. Kept in a lookup so the JSX below
 *  stays readable. */
const STATUS_STYLE: Record<
  SmokeStatus,
  { Icon: typeof CheckCircle2; text: string; ring: string; label: string }
> = {
  pass: {
    Icon: CheckCircle2,
    text: 'text-emerald-400',
    ring: 'border-emerald-500/30 bg-emerald-500/5',
    label: 'Pass'
  },
  fail: {
    Icon: XCircle,
    text: 'text-rose-400',
    ring: 'border-rose-500/30 bg-rose-500/5',
    label: 'Fail'
  },
  skipped: {
    Icon: CircleSlash,
    text: 'text-amber-400',
    ring: 'border-amber-500/30 bg-amber-500/5',
    label: 'Skipped'
  }
}

export function SmokeTestPanel(): JSX.Element {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<SmokeCheck[] | null>(null)
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const pushToast = useUiStore((s) => s.pushToast)

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      const checks = await vs.system.smokeTest()
      setResults(checks)
      setRanAt(new Date())
      const failed = checks.filter((c) => c.status === 'fail')
      if (failed.length > 0) {
        pushToast(
          'error',
          `${failed.length} smoke check${failed.length === 1 ? '' : 's'} failed — see Diagnostics for details.`
        )
      } else {
        const skipped = checks.filter((c) => c.status === 'skipped').length
        pushToast(
          'success',
          skipped > 0
            ? `Smoke test passed (${skipped} skipped — see Diagnostics).`
            : 'Smoke test passed — every capability works.'
        )
      }
    } catch (err) {
      pushToast(
        'error',
        `Smoke test failed to run: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setRunning(false)
    }
  }

  const passCount = results?.filter((c) => c.status === 'pass').length ?? 0
  const failCount = results?.filter((c) => c.status === 'fail').length ?? 0
  const skipCount = results?.filter((c) => c.status === 'skipped').length ?? 0

  return (
    <CollapsibleSection
      title="Diagnostics"
      hint="Runs the actual filesystem / shell / MCP probes the agent uses, so you can see whether the stack works without debugging inside chat."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 text-[11px] leading-snug text-slate-400">
            Click <span className="font-semibold text-slate-200">Run smoke test</span> and the app
            will read, list, write, run a shell command, and inspect any MCP filesystem servers —
            the same operations the AI would attempt. Each row reports pass, fail (with the
            underlying error), or skipped (when the matching permission is off).
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className={cn(
              'no-drag inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-slate-100 transition',
              running
                ? 'cursor-wait opacity-60'
                : 'hover:border-[var(--accent-ring)] hover:bg-white/10'
            )}
          >
            {running ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Running…
              </>
            ) : (
              <>
                <ShieldAlert size={12} />
                Run smoke test
              </>
            )}
          </button>
        </div>

        {results && (
          <>
            <div className="flex items-center gap-3 text-[10px] text-slate-500">
              <span>
                <span className="font-semibold text-emerald-400">{passCount}</span> passed
              </span>
              <span>
                <span className="font-semibold text-rose-400">{failCount}</span> failed
              </span>
              <span>
                <span className="font-semibold text-amber-400">{skipCount}</span> skipped
              </span>
              {ranAt && (
                <span className="ml-auto">
                  Last run:{' '}
                  {ranAt.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {results.map((check) => {
                const style = STATUS_STYLE[check.status]
                const Icon = style.Icon
                return (
                  <li
                    key={check.id}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                      style.ring
                    )}
                  >
                    <Icon size={14} className={cn('mt-0.5 shrink-0', style.text)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[12px] font-medium text-white">{check.label}</p>
                        <span
                          className={cn(
                            'text-[10px] font-semibold uppercase tracking-wider',
                            style.text
                          )}
                        >
                          {style.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-snug text-slate-400">{check.what}</p>
                      <p className="mt-1 text-[10px] leading-snug text-slate-300">{check.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {!results && !running && (
          <p className="text-[10px] italic text-slate-500">
            Smoke test hasn't been run yet — click the button above.
          </p>
        )}
      </div>
    </CollapsibleSection>
  )
}
