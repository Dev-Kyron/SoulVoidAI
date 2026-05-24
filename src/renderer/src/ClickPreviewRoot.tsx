/**
 * v1.8.0 — click-preview HUD root.
 * v1.8.1 — restyled to match the VoidSoul orb / panel aesthetic (dark
 *          translucent glass, cyan accent, the same rounded-soft radii
 *          the rest of the app uses). Esc handling moved to main-side
 *          globalShortcut since the window now shows inactive (no
 *          keyboard focus available).
 *
 * Renders inside a small transparent overlay BrowserWindow positioned by
 * main (`clickPreview.ts`) so the pulsing target ring sits on top of the
 * pixel Soul is about to click. The user gets a 3-second countdown to
 * cancel via Esc (global shortcut) or the Cancel button before the click
 * fires.
 *
 * Query-string contract (set by clickPreview.ts):
 *   token       — opaque id main uses to settle the awaiting Promise
 *   description — what Soul thinks she's clicking
 *   confidence  — 0-1 model self-rated confidence (shown as a chip)
 *   seconds     — countdown duration
 *   ringX/ringY — local-window coords where the click target lands
 *
 * Why no app shell / providers: this window has no chat store, no config,
 * no theme provider. It loads cold, reads its config from the URL, and
 * exits. Keeps the bundle path short and the window paint instant.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { vs } from './lib/bridge'

/** Canonical VoidSoul cyan — matches the orb's wake-listening glow and
 *  the spirit avatar halo so the HUD reads as "VoidSoul is doing this".
 *  Hard-coded (not via CSS var) because this window doesn't run the
 *  accent-theme hook from App.tsx. */
const ACCENT = '#7dd3fc'
const ACCENT_DEEP = '#0891b2'
const GLASS_BG = 'rgba(15, 15, 24, 0.88)'
const GLASS_BORDER = 'rgba(125, 211, 252, 0.32)'

export function ClickPreviewRoot(): JSX.Element {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const token = params.get('token') ?? ''
  const description = params.get('description') ?? 'something on screen'
  const confidenceNum = Number(params.get('confidence') ?? '0.5')
  const confidence = Number.isFinite(confidenceNum)
    ? Math.max(0, Math.min(1, confidenceNum))
    : 0.5
  const totalSecondsRaw = Number(params.get('seconds') ?? '3')
  const totalSeconds = Number.isFinite(totalSecondsRaw) && totalSecondsRaw > 0
    ? Math.min(10, totalSecondsRaw)
    : 3
  const ringX = Number(params.get('ringX') ?? '150')
  const ringY = Number(params.get('ringY') ?? '50')

  const [remaining, setRemaining] = useState(totalSeconds)
  // Ref guards against the user mashing Cancel twice or the countdown
  // racing a manual cancel — only one resolve fires per HUD instance.
  const settledRef = useRef(false)

  const resolve = (decision: 'go' | 'cancel'): void => {
    if (settledRef.current) return
    settledRef.current = true
    void vs.clickPreview.resolve(token, decision)
  }

  // Countdown tick — 100ms interval gives a smooth progress arc without
  // wasting CPU. We compute remaining time from a stable startedAt so any
  // setInterval drift doesn't accumulate visible jitter.
  useEffect(() => {
    if (!token) return
    const startedAt = performance.now()
    const id = window.setInterval(() => {
      if (settledRef.current) return
      const elapsedSec = (performance.now() - startedAt) / 1000
      const next = Math.max(0, totalSeconds - elapsedSec)
      setRemaining(next)
      if (next <= 0) {
        window.clearInterval(id)
        resolve('go')
      }
    }, 100)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, totalSeconds])

  // v1.8.1 — Esc handled by globalShortcut in clickPreview.ts (main).
  // This window is now showInactive() so it never has keyboard focus —
  // a local keydown listener would silently never fire.

  if (!token) {
    // Defensive — should never happen since main always supplies a token,
    // but a missing token would leave the HUD orphaned forever otherwise.
    return <div />
  }

  // Progress arc: circumference of a circle of radius 34 ≈ 213.
  // strokeDashoffset = circumference × (1 - remaining/total) sweeps from
  // 0 (full ring) to circumference (empty ring) as the countdown elapses.
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const progress = remaining / totalSeconds
  const dashOffset = circumference * (1 - progress)
  const confidencePct = Math.round(confidence * 100)

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        // Disable native text selection — this HUD should feel like a
        // visual overlay, not a webpage. Also kills the default I-beam
        // cursor inside the otherwise-empty area.
        userSelect: 'none',
        cursor: 'default',
        position: 'relative',
        overflow: 'hidden',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
      }}
    >
      {/* Target ring SVG. Positioned absolutely so its centre lands on
        * (ringX, ringY) regardless of caption layout below. Two
        * concentric rings + a countdown arc + centre dot give a clear
        * "I am about to click HERE" signal at a glance. */}
      <svg
        width={radius * 2 + 22}
        height={radius * 2 + 22}
        style={{
          position: 'absolute',
          left: ringX - (radius + 11),
          top: ringY - (radius + 11),
          overflow: 'visible',
          pointerEvents: 'none',
          // Soft shadow so the ring reads against any wallpaper.
          filter: `drop-shadow(0 0 8px ${ACCENT_DEEP})`
        }}
      >
        {/* Outer halo — pulses to draw the eye. */}
        <circle
          cx={radius + 11}
          cy={radius + 11}
          r={radius + 8}
          fill={`${ACCENT}1A`}
          stroke={`${ACCENT}99`}
          strokeWidth={1.5}
        >
          <animate
            attributeName="r"
            values={`${radius + 8};${radius + 13};${radius + 8}`}
            dur="1.6s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.85;0.4;0.85"
            dur="1.6s"
            repeatCount="indefinite"
          />
        </circle>
        {/* Inner target ring — fixed marker so the eye can lock on. */}
        <circle
          cx={radius + 11}
          cy={radius + 11}
          r={radius}
          fill="rgba(8, 12, 20, 0.42)"
          stroke={ACCENT}
          strokeWidth={2.5}
          strokeOpacity={0.9}
        />
        {/* Countdown sweep arc — rotates the dashed stroke to indicate
          * how much time is left. Starts at 12 o'clock (-90° rotation)
          * and shrinks counter-clockwise as remaining time decreases. */}
        <circle
          cx={radius + 11}
          cy={radius + 11}
          r={radius}
          fill="none"
          stroke="#bae6fd"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${radius + 11} ${radius + 11})`}
        />
        {/* Centre dot — the actual click pixel. */}
        <circle
          cx={radius + 11}
          cy={radius + 11}
          r={3.5}
          fill={ACCENT}
        />
        {/* Crosshair ticks at 4 compass points — extra precision cue
          * so the user can verify the centre dot lines up with what they
          * expected to be clicked. */}
        {[0, 1, 2, 3].map((i) => {
          const angle = (i * Math.PI) / 2
          const cx = radius + 11
          const cy = radius + 11
          const x1 = cx + Math.cos(angle) * (radius + 2)
          const y1 = cy + Math.sin(angle) * (radius + 2)
          const x2 = cx + Math.cos(angle) * (radius + 7)
          const y2 = cy + Math.sin(angle) * (radius + 7)
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={ACCENT}
              strokeWidth={1.5}
              strokeOpacity={0.6}
            />
          )
        })}
      </svg>

      {/* Caption + cancel button — VoidSoul glass-panel aesthetic. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          // Caption sits below the ring with enough breathing room for the
          // expanded ring + halo. RING_OFFSET_Y in main is 50, radius is
          // 34, halo extends ~13 more — so 100 puts the caption clear of
          // the ring at all animation phases.
          top: ringY + radius + 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          padding: '0 12px'
        }}
      >
        <div
          style={{
            background: GLASS_BG,
            border: `1px solid ${GLASS_BORDER}`,
            borderRadius: 12,
            padding: '8px 12px 9px',
            color: '#e2e8f0',
            fontSize: 11,
            lineHeight: 1.4,
            maxWidth: 268,
            textAlign: 'center',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            boxShadow: `0 8px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px ${ACCENT}1A inset`
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: ACCENT,
              letterSpacing: '0.01em'
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: ACCENT,
                boxShadow: `0 0 8px ${ACCENT}`,
                animation: 'voidsoul-pulse 1.6s ease-in-out infinite'
              }}
            />
            Clicking in {remaining.toFixed(1)}s
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: '#cbd5e1',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontStyle: 'italic'
            }}
            title={description}
          >
            "{description}"
          </div>
          <div
            style={{
              marginTop: 5,
              fontSize: 9,
              color: '#64748b',
              fontFamily:
                'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }}
          >
            {confidencePct}% confidence · Esc to cancel
          </div>
        </div>
        <button
          type="button"
          onClick={() => resolve('cancel')}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(244, 63, 94, 0.28)'
            e.currentTarget.style.borderColor = 'rgba(244, 63, 94, 0.75)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(244, 63, 94, 0.15)'
            e.currentTarget.style.borderColor = 'rgba(244, 63, 94, 0.5)'
          }}
          style={{
            background: 'rgba(244, 63, 94, 0.15)',
            border: '1px solid rgba(244, 63, 94, 0.5)',
            color: '#fecaca',
            borderRadius: 8,
            padding: '4px 16px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            pointerEvents: 'auto',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            transition: 'background 0.15s, border-color 0.15s'
          }}
        >
          Cancel
        </button>
      </div>
      {/* Local keyframe for the pulse dot — scoped to this window so it
        * doesn't depend on the main app's CSS. */}
      <style>{`
        @keyframes voidsoul-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}
