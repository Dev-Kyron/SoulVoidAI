/**
 * Click-benchmark dialog.
 *
 * Lives under Settings → Advanced → Experimental → click_on_screen → "Open
 * benchmark". Three modes:
 *
 *   list     — see all benchmarks, run selected strategies × selected
 *              benchmarks, view past reports
 *   capture  — take a screenshot, click on the target, drag a bounding
 *              box; save ground truth + metadata
 *   running  — progress ribbon while a run is in flight
 *
 * The dialog deliberately surfaces the SHAPE of the data, not just the
 * verdict. Per-strategy hit counts + average pixel error give the dev a
 * "I can see what's happening" feeling instead of a single number. The
 * HTML report opens in the default browser for sharing / archiving.
 */
import { useEffect, useState } from 'react'
import { Beaker, Camera, CheckCircle2, FileText, Loader2, Play, Plus, Save, X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import { BTN, FIELD } from './styles'
import type { ClickBenchBenchmark } from '@shared/types'

interface Props {
  onClose: () => void
}

interface BenchmarkRow {
  id: string
  label: string
  category: string
  hasGroundTruth: boolean
  inWindow: string | null
  capturedAt: string | null
}

interface StrategyRow {
  id: string
  label: string
}

interface RunSummary {
  htmlPath: string
  csvPath: string
  totalCells: number
  summary: Array<{
    strategyId: string
    total: number
    hits: number
    hitsBbox: number
    hitsRadius: number
    misses: number
    noPrediction: number
    avgPixelError: number | null
    avgMs: number
  }>
}

type Mode = 'list' | 'capture' | 'running'

export function ClickBenchDialog({ onClose }: Props): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [mode, setMode] = useState<Mode>('list')
  const [benchmarks, setBenchmarks] = useState<BenchmarkRow[]>([])
  const [strategies, setStrategies] = useState<StrategyRow[]>([])
  const [selectedBenchmarkIds, setSelectedBenchmarkIds] = useState<Set<string>>(new Set())
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<Set<string>>(new Set())
  const [progressLabel, setProgressLabel] = useState<string>('')
  const [lastResult, setLastResult] = useState<RunSummary | null>(null)

  /**
   * Single source of truth for "load list + populate defaults". Takes
   * an `isCancelled` thunk so the initial mount-effect path can guard
   * against setState-on-unmounted, while the post-save path (still
   * mounted, by construction) passes a stable `false` thunk.
   */
  const loadList = async (isCancelled: () => boolean): Promise<void> => {
    const data = await vs.clickBench.list()
    if (isCancelled()) return
    setBenchmarks(data.benchmarks)
    setStrategies(data.strategies)
    // Default-select everything captured + every strategy on first
    // load only — re-loads after a save preserve user toggles.
    if (selectedBenchmarkIds.size === 0) {
      setSelectedBenchmarkIds(
        new Set(data.benchmarks.filter((b) => b.hasGroundTruth).map((b) => b.id))
      )
    }
    if (selectedStrategyIds.size === 0) {
      setSelectedStrategyIds(new Set(data.strategies.map((s) => s.id)))
    }
  }

  const refresh = (): Promise<void> => loadList(() => false)

  useEffect(() => {
    // Mounted-guard — without it, closing the dialog mid-fetch lands a
    // setState on an unmounted component and React warns in dev.
    let cancelled = false
    void loadList(() => cancelled)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live progress ribbon — fires once per (benchmark × strategy) cell.
  // Wiring this finally makes the dialog feel responsive during a long
  // run; pre-wire we showed "Running…" for 60s with no detail.
  useEffect(() => {
    return vs.events.onClickBenchProgress((info) => {
      setProgressLabel(
        `${info.benchmarkLabel} · ${info.strategyLabel} (${info.benchmarkIndex * info.strategyTotal + info.strategyIndex + 1} / ${info.benchmarkTotal * info.strategyTotal})`
      )
    })
  }, [])

  const toggleSet = (
    set: Set<string>,
    setter: (s: Set<string>) => void
  ): ((id: string) => void) => {
    return (id: string) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setter(next)
    }
  }

  const runSelected = async (): Promise<void> => {
    if (selectedBenchmarkIds.size === 0) {
      pushToast('error', 'Select at least one benchmark.')
      return
    }
    if (selectedStrategyIds.size === 0) {
      pushToast('error', 'Select at least one strategy.')
      return
    }
    setMode('running')
    setProgressLabel('Starting…')
    try {
      const result = await vs.clickBench.run({
        benchmarkIds: Array.from(selectedBenchmarkIds),
        strategyIds: Array.from(selectedStrategyIds),
        openReportWhenDone: true
      })
      setLastResult(result)
      pushToast(
        'success',
        `Bench complete — ${result.summary.reduce((a, s) => a + s.hits, 0)}/${result.totalCells} hits.`
      )
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setMode('list')
      setProgressLabel('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass w-full max-w-2xl rounded-xl p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-100">
            <Beaker size={13} className="text-[var(--accent)]" />
            click_on_screen — benchmark
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
          >
            <X size={14} />
          </button>
        </div>

        {mode === 'capture' ? (
          <CaptureForm
            onSaved={async () => {
              await refresh()
              setMode('list')
            }}
            onCancel={() => setMode('list')}
          />
        ) : (
          <>
            <div className="mb-3 text-[10px] leading-relaxed text-slate-400">
              Measures each strategy's locate accuracy against captured ground truth. Strategies run
              sequentially per benchmark so screenshots don't fight for the GPU. Reports land at{' '}
              <code>userData/clickbench/reports/</code>.
            </div>

            {/* Strategies */}
            <div className="mb-3">
              <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                Strategies ({selectedStrategyIds.size}/{strategies.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {strategies.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSet(selectedStrategyIds, setSelectedStrategyIds)(s.id)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] transition',
                      selectedStrategyIds.has(s.id)
                        ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-slate-100'
                        : 'border-white/10 text-slate-400 hover:bg-white/5'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Benchmarks */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Benchmarks ({selectedBenchmarkIds.size}/{benchmarks.length})
                </p>
                <button
                  type="button"
                  onClick={() => setMode('capture')}
                  className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
                >
                  <Plus size={10} />
                  New benchmark
                </button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-1.5">
                {benchmarks.length === 0 && (
                  <p className="p-2 text-[10px] text-slate-500">
                    No benchmarks yet — click "New benchmark" to capture one.
                  </p>
                )}
                {benchmarks.map((b) => (
                  <label
                    key={b.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-white/5',
                      selectedBenchmarkIds.has(b.id) && 'bg-[var(--accent)]/10'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedBenchmarkIds.has(b.id)}
                      onChange={() =>
                        toggleSet(selectedBenchmarkIds, setSelectedBenchmarkIds)(b.id)
                      }
                      className="mt-0.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] text-slate-100">{b.label}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
                        <span className="rounded bg-white/5 px-1 py-px">{b.category}</span>
                        {b.inWindow && <span>in_window=&quot;{b.inWindow}&quot;</span>}
                        {!b.hasGroundTruth && (
                          <span className="text-amber-400">⚠ no ground truth yet</span>
                        )}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {mode === 'running' && (
              <div className="mb-3 flex items-center gap-2 rounded-md bg-[var(--accent)]/10 p-2 text-[11px] text-[var(--accent)]">
                <Loader2 size={12} className="animate-spin" />
                {progressLabel || 'Running benchmarks…'}
              </div>
            )}

            {lastResult && mode !== 'running' && (
              <div className="mb-3 rounded-md bg-emerald-500/10 p-2 text-[11px] text-emerald-200">
                <p className="flex items-center gap-1 font-semibold">
                  <CheckCircle2 size={11} />
                  Last run — {lastResult.totalCells} cells
                </p>
                <div className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 text-[10px] sm:grid-cols-2">
                  {lastResult.summary.map((s) => (
                    <p key={s.strategyId} className="text-emerald-100/80">
                      <span className="text-emerald-200 font-semibold">{s.strategyId}:</span>{' '}
                      {s.hits}/{s.total} hits
                      {s.avgPixelError !== null && ` · ${s.avgPixelError.toFixed(0)}px err`}
                      {` · ${s.avgMs.toFixed(0)}ms`}
                    </p>
                  ))}
                </div>
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-emerald-300/70">
                  <FileText size={10} />
                  Report opened in your browser{' '}
                  <span className="text-emerald-100/40">({lastResult.htmlPath})</span>
                </p>
              </div>
            )}

            <div className="flex justify-end gap-1.5">
              <button type="button" onClick={onClose} className={BTN}>
                Close
              </button>
              <button
                type="button"
                onClick={() => void runSelected()}
                disabled={mode === 'running'}
                className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {mode === 'running' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Play size={11} />
                )}
                Run selected
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ============================================================== */
/*  Capture mode — screenshot + click target + drag bbox          */
/* ============================================================== */

interface CaptureScreenshot {
  dataUrl: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  /** v2.0 polish — total connected displays. >1 means the user may be
   *  capturing the wrong monitor; we warn but don't block. */
  displayCount: number
}

interface CaptureBbox {
  /** Screenshot-relative pixel coords. Converted to logical display
   *  coords on save via displayWidth/displayHeight ratio. */
  x: number
  y: number
  w: number
  h: number
}

function CaptureForm({
  onSaved,
  onCancel
}: {
  onSaved: () => void
  onCancel: () => void
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [step, setStep] = useState<'form' | 'shooting' | 'click' | 'saving'>('form')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [inWindow, setInWindow] = useState('')
  const [category, setCategory] = useState<ClickBenchBenchmark['category']>('labeled-native')
  const [notes, setNotes] = useState('')
  const [shot, setShot] = useState<CaptureScreenshot | null>(null)
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null)
  const [bbox, setBbox] = useState<CaptureBbox | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)

  const takeScreenshot = async (): Promise<void> => {
    if (!id.trim() || !label.trim() || !prompt.trim()) {
      pushToast('error', 'id, label and prompt are all required.')
      return
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      pushToast('error', 'id must be kebab-case (a-z, 0-9, hyphen).')
      return
    }
    setStep('shooting')
    try {
      const captured = await vs.clickBench.captureScreenshot()
      setShot(captured)
      setStep('click')
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
      setStep('form')
    }
  }

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (!shot) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioX = shot.width / rect.width
    const ratioY = shot.height / rect.height
    const px = Math.round((e.clientX - rect.left) * ratioX)
    const py = Math.round((e.clientY - rect.top) * ratioY)
    setCenter({ x: px, y: py })
    // Default bbox: 60×60 around the click. User can drag-to-refine
    // via the mouse-down handler below.
    setBbox({ x: px - 30, y: py - 30, w: 60, h: 60 })
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (!shot) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioX = shot.width / rect.width
    const ratioY = shot.height / rect.height
    const px = Math.round((e.clientX - rect.left) * ratioX)
    const py = Math.round((e.clientY - rect.top) * ratioY)
    setDragStart({ x: px, y: py })
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (!shot || !dragStart) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioX = shot.width / rect.width
    const ratioY = shot.height / rect.height
    const px = Math.round((e.clientX - rect.left) * ratioX)
    const py = Math.round((e.clientY - rect.top) * ratioY)
    // Lower drag threshold so a 5×5 icon-button bbox actually registers
    // (the previous >4px-each gate dropped most micro-bboxes silently),
    // and clamp into screenshot bounds so a drag past the edge can't
    // produce a negative origin that confuses scoring later.
    const rawX = Math.min(dragStart.x, px)
    const rawY = Math.min(dragStart.y, py)
    const rawW = Math.abs(px - dragStart.x)
    const rawH = Math.abs(py - dragStart.y)
    if (rawW < 2 || rawH < 2) return
    const x = Math.max(0, Math.min(rawX, shot.width - 1))
    const y = Math.max(0, Math.min(rawY, shot.height - 1))
    const w = Math.min(rawW, shot.width - x)
    const h = Math.min(rawH, shot.height - y)
    setBbox({ x, y, w, h })
    setCenter({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) })
  }

  const handleMouseUp = (): void => setDragStart(null)

  const save = async (): Promise<void> => {
    if (!shot || !center || !bbox) {
      pushToast('error', 'Click on the target before saving.')
      return
    }
    setStep('saving')
    const ratio = shot.displayWidth / shot.width
    const benchmark: ClickBenchBenchmark = {
      id: id.trim(),
      label: label.trim(),
      prompt: prompt.trim(),
      category,
      inWindow: inWindow.trim() || null,
      referenceScreenshotPath: null,
      groundTruth: {
        // Project screenshot pixels → logical display pixels.
        centerX: Math.round(center.x * ratio),
        centerY: Math.round(center.y * ratio),
        bbox: {
          x: Math.round(bbox.x * ratio),
          y: Math.round(bbox.y * ratio),
          w: Math.round(bbox.w * ratio),
          h: Math.round(bbox.h * ratio)
        },
        displayWidth: shot.displayWidth,
        displayHeight: shot.displayHeight
      },
      notes: notes.trim() || null,
      capturedAt: new Date().toISOString()
    }
    try {
      await vs.clickBench.saveBenchmark(benchmark)
      pushToast('success', `Saved benchmark "${benchmark.label}".`)
      onSaved()
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
      setStep('click')
    }
  }

  if (step === 'form') {
    return (
      <div className="space-y-2">
        <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
          Set up the target app first (open the right window, navigate to the page, make sure the
          target button is visible). Then fill these in and click "Take screenshot" — VoidSoul hides
          briefly while the screen is captured.
        </p>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="id (kebab-case, e.g. slack-send)"
          className={cn(FIELD, 'w-full font-mono')}
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Slack — Send message)"
          className={cn(FIELD, 'w-full')}
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Click prompt (the exact string passed to click_on_screen, e.g. 'Send button in Slack compose')"
          rows={2}
          className={cn(FIELD, 'w-full resize-none')}
        />
        <input
          type="text"
          value={inWindow}
          onChange={(e) => setInWindow(e.target.value)}
          placeholder="in_window (optional, e.g. Slack)"
          className={cn(FIELD, 'w-full')}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ClickBenchBenchmark['category'])}
          className={FIELD}
        >
          <option value="labeled-native" className="bg-void-700">
            labeled-native (UIA-friendly button)
          </option>
          <option value="icon-only-native" className="bg-void-700">
            icon-only-native (no label)
          </option>
          <option value="browser-web" className="bg-void-700">
            browser-web (chat / web app)
          </option>
          <option value="menu-item" className="bg-void-700">
            menu-item (popup, right-click)
          </option>
          <option value="panel-selector" className="bg-void-700">
            panel-selector (sidebar / nav)
          </option>
        </select>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes — setup instructions for future runs"
          rows={2}
          className={cn(FIELD, 'w-full resize-none')}
        />
        <div className="flex justify-end gap-1.5 pt-1">
          <button type="button" onClick={onCancel} className={BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void takeScreenshot()}
            className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            <Camera size={11} />
            Take screenshot
          </button>
        </div>
      </div>
    )
  }

  if (step === 'shooting') {
    return (
      <div className="flex items-center gap-2 rounded-md bg-[var(--accent)]/10 p-3 text-[11px] text-[var(--accent)]">
        <Loader2 size={12} className="animate-spin" />
        Hiding VoidSoul and capturing the screen…
      </div>
    )
  }

  // step === 'click' or 'saving'
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-400">
        Click the target's centre. Drag to refine the bounding box. The save button activates once
        you've clicked.
      </p>
      {shot && shot.displayCount > 1 && (
        <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          ⚠ {shot.displayCount} monitors detected. Capture and run-time use the PRIMARY display only
          — make sure your target app is on it before saving this benchmark, otherwise the saved
          coordinates won't match what the runner sees.
        </p>
      )}
      <div className="relative overflow-hidden rounded-lg border border-white/10">
        {shot && (
          <>
            <img
              src={shot.dataUrl}
              alt="screen"
              onClick={handleImageClick}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className="block w-full cursor-crosshair select-none"
              draggable={false}
            />
            {center && shot && bbox && (
              <div
                className="pointer-events-none absolute border-2 border-[var(--accent)]"
                style={{
                  left: `${(bbox.x / shot.width) * 100}%`,
                  top: `${(bbox.y / shot.height) * 100}%`,
                  width: `${(bbox.w / shot.width) * 100}%`,
                  height: `${(bbox.h / shot.height) * 100}%`,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)'
                }}
              />
            )}
            {center && shot && (
              <div
                className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] ring-2 ring-white"
                style={{
                  left: `${(center.x / shot.width) * 100}%`,
                  top: `${(center.y / shot.height) * 100}%`
                }}
              />
            )}
          </>
        )}
      </div>
      {center && (
        <p className="font-mono text-[10px] text-slate-400">
          centre ({center.x}, {center.y}) · bbox {bbox?.w}×{bbox?.h}
        </p>
      )}
      <div className="flex justify-end gap-1.5 pt-1">
        <button type="button" onClick={onCancel} className={BTN}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!center || step === 'saving'}
          className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          {step === 'saving' ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          Save benchmark
        </button>
      </div>
    </div>
  )
}
