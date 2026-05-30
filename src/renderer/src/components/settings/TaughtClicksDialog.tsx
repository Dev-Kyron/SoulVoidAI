/**
 * v2.0 Phase 4 — Hover-to-teach dialog.
 *
 * Three modes:
 *   list     — view + delete previously-taught clicks
 *   arming   — capture is armed, waiting for the user to press F8
 *              in whichever app they want to teach
 *   captured — UIA returned an element under the cursor; user assigns
 *              a description + saves
 *
 * Why F8 + a dialog rather than an in-app crosshair: the user needs to
 * point at a target in ANOTHER app, so the capture has to be initiated
 * remotely. F8 is rare-enough not to collide with target apps.
 */
import { useEffect, useRef, useState } from 'react'
import { Beaker, CheckCircle2, Plus, Trash2, X } from 'lucide-react'
import { vs } from '../../lib/bridge'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/utils'
import { BTN, FIELD } from './styles'

interface Props {
  onClose: () => void
}

interface TaughtRow {
  id: string
  description: string
  rawDescription: string
  name: string
  automationId: string
  controlType: string
  inWindow: string | null
  capturedAt: string
  hitCount: number
  lastUsedAt: string | null
}

interface CapturedElement {
  name: string
  automationId: string
  controlType: string
  x: number
  y: number
  w: number
  h: number
}

type Mode = 'list' | 'arming' | 'captured'

export function TaughtClicksDialog({ onClose }: Props): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast)
  const [mode, setMode] = useState<Mode>('list')
  const [rows, setRows] = useState<TaughtRow[]>([])
  const [hotkey, setHotkey] = useState('F8')
  const [captured, setCaptured] = useState<{
    element: CapturedElement | null
    cursorX: number
    cursorY: number
  } | null>(null)
  const [rawDescription, setRawDescription] = useState('')
  const [inWindow, setInWindow] = useState('')

  const refresh = async (): Promise<void> => {
    const list = await vs.taughtClicks.list()
    setRows(list)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await vs.taughtClicks.list()
      if (!cancelled) setRows(list)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Subscribe to capture events from main. v2.0 polish — uses a
  // modeRef so the 'cancelled' branch reads the LIVE mode, not the
  // value captured at mount. Without the ref, the empty deps array
  // (intentional — we don't want re-subscribing every render) would
  // freeze `mode === 'arming'` as 'list' forever, and a server-side
  // cancellation would leave the dialog stuck.
  const modeRef = useRef<Mode>(mode)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  useEffect(() => {
    return vs.events.onTaughtClicksEvent((info) => {
      if (info.kind === 'captured') {
        setCaptured({ element: info.element, cursorX: info.cursorX, cursorY: info.cursorY })
        setMode('captured')
        // Pre-fill the description with the UIA name when we have one
        // — saves the user retyping the most common case.
        if (info.element?.name) setRawDescription(info.element.name)
      } else if (info.kind === 'cancelled') {
        if (modeRef.current === 'arming') {
          setMode('list')
          pushToast('info', 'Teach capture cancelled.')
        }
      }
    })
  }, [pushToast])

  // Make sure we don't leave a stuck hotkey when the dialog closes
  // mid-arming. Settings windows can be dismissed unexpectedly.
  useEffect(() => {
    return () => {
      if (mode === 'arming') void vs.taughtClicks.cancelCapture()
    }
  }, [mode])

  const armCapture = async (): Promise<void> => {
    const result = await vs.taughtClicks.startCapture()
    setHotkey(result.hotkey)
    if (!result.ok) {
      pushToast(
        'error',
        `Couldn't register ${result.hotkey} — another app may own it. Try closing the app that uses it, or wait a moment and try again.`
      )
      return
    }
    setMode('arming')
  }

  const cancelArming = async (): Promise<void> => {
    await vs.taughtClicks.cancelCapture()
    setMode('list')
  }

  const saveCaptured = async (): Promise<void> => {
    if (!captured?.element) {
      pushToast('error', 'No element captured — re-arm and try again.')
      return
    }
    if (!rawDescription.trim()) {
      pushToast('error', 'Add a description so Soul knows what to call this click.')
      return
    }
    try {
      await vs.taughtClicks.save({
        rawDescription: rawDescription.trim(),
        name: captured.element.name,
        automationId: captured.element.automationId,
        controlType: captured.element.controlType,
        inWindow: inWindow.trim() || null
      })
      pushToast('success', `Taught Soul to click "${rawDescription.trim()}".`)
      setCaptured(null)
      setRawDescription('')
      setInWindow('')
      setMode('list')
      await refresh()
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err))
    }
  }

  const removeOne = async (id: string): Promise<void> => {
    await vs.taughtClicks.remove(id)
    await refresh()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass w-full max-w-xl rounded-xl p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-100">
            <Beaker size={13} className="text-[var(--accent)]" />
            Taught clicks (hover-to-teach)
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
          >
            <X size={14} />
          </button>
        </div>

        {mode === 'arming' && (
          <div className="space-y-2">
            <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-3 py-3 text-[11px] text-[var(--accent)]">
              <p className="font-semibold">Capture armed — switch to the target app.</p>
              <p className="mt-1 text-[10px] text-[var(--accent)]/80">
                Move your cursor to the element you want to teach, then press{' '}
                <span className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[var(--accent)]">
                  {hotkey}
                </span>
                . VoidSoul stays out of the way until you press the key.
              </p>
              <p className="mt-1 text-[10px] text-[var(--accent)]/60">
                Tip: works best on accessibility-friendly elements (real buttons, menu items).
                Custom canvases may return no UIA data — re-teach a different element if so.
              </p>
            </div>
            <div className="flex justify-end gap-1.5 pt-1">
              <button type="button" onClick={() => void cancelArming()} className={BTN}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === 'captured' && captured && (
          <div className="space-y-2">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-[11px]">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Captured</p>
              {captured.element ? (
                <div className="space-y-0.5 font-mono text-[10px] text-slate-300">
                  <p>
                    name:{' '}
                    <span className="text-slate-100">"{captured.element.name || '(empty)'}"</span>
                  </p>
                  <p>
                    controlType:{' '}
                    <span className="text-slate-100">
                      {captured.element.controlType.replace('ControlType.', '')}
                    </span>
                  </p>
                  {captured.element.automationId && (
                    <p>
                      automationId:{' '}
                      <span className="text-slate-100">{captured.element.automationId}</span>
                    </p>
                  )}
                  <p className="text-slate-500">
                    at ({captured.element.x}, {captured.element.y}) {captured.element.w}×
                    {captured.element.h}
                  </p>
                </div>
              ) : (
                <p className="text-rose-300">
                  No UIA element under the cursor at ({captured.cursorX}, {captured.cursorY}). Try a
                  different spot — custom-rendered canvases (games, drawing apps) don't surface to
                  UIA.
                </p>
              )}
            </div>
            <input
              type="text"
              value={rawDescription}
              onChange={(e) => setRawDescription(e.target.value)}
              placeholder="What should Soul call this click? (e.g. 'send in slack')"
              className={cn(FIELD, 'w-full')}
              autoFocus
            />
            <input
              type="text"
              value={inWindow}
              onChange={(e) => setInWindow(e.target.value)}
              placeholder="in_window (optional, e.g. Slack)"
              className={cn(FIELD, 'w-full')}
            />
            <div className="flex justify-end gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setCaptured(null)
                  setRawDescription('')
                  setInWindow('')
                  setMode('list')
                }}
                className={BTN}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void saveCaptured()}
                disabled={!captured.element || !rawDescription.trim()}
                className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                <CheckCircle2 size={11} />
                Save
              </button>
            </div>
          </div>
        )}

        {mode === 'list' && (
          <>
            <div className="mb-3 text-[10px] leading-relaxed text-slate-400">
              Teach Soul a click once — point at a target in any app, press {hotkey}, give it a
              description. Future identical descriptions skip ALL model calls and click directly via
              UIA. Zero latency, zero cost.
            </div>
            <div className="mb-3">
              <button
                type="button"
                onClick={() => void armCapture()}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-[11px] font-semibold text-white transition hover:brightness-110"
              >
                <Plus size={11} />
                Teach a new click
              </button>
            </div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
              Taught ({rows.length})
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-1.5">
              {rows.length === 0 && (
                <p className="p-2 text-[10px] text-slate-500">
                  Nothing taught yet. Click "Teach a new click" to start.
                </p>
              )}
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start gap-2 rounded-md bg-black/10 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-slate-100">{r.rawDescription}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
                      <span className="rounded bg-white/5 px-1 py-px font-mono">
                        {r.controlType.replace('ControlType.', '')}
                      </span>
                      {r.name && (
                        <span className="truncate font-mono">"{r.name.slice(0, 32)}"</span>
                      )}
                      {r.inWindow && <span>in_window={r.inWindow}</span>}
                      <span className="text-emerald-400">
                        {r.hitCount} hit{r.hitCount === 1 ? '' : 's'}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeOne(r.id)}
                    className="rounded p-1 text-slate-500 transition hover:bg-white/5 hover:text-rose-300"
                    title="Forget this taught click"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-1.5 pt-3">
              <button type="button" onClick={onClose} className={BTN}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
