/**
 * A compact telemetry chip — a tiny radial dial with the value at its centre,
 * paired with a label and optional sub-line. Designed to sit alongside other
 * chips as ambient information, never as the main focus of the HUD.
 */
interface GaugeProps {
  value: number
  label: string
  sub?: string
  unit?: string
  color?: string
}

export function Gauge({
  value,
  label,
  sub,
  unit = '%',
  color = 'var(--accent)'
}: GaugeProps): JSX.Element {
  const size = 36
  const stroke = 3
  const radius = (size - stroke) / 2 - 1
  const center = size / 2
  const circumference = 2 * Math.PI * radius
  const sweep = 0.72 // 270° of the full circle
  const track = circumference * sweep
  const clamped = Math.min(100, Math.max(0, value))

  return (
    <div className="glass-soft flex items-center gap-2 rounded-lg px-2 py-1.5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(135deg)' }}>
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
            strokeDasharray={`${track} ${circumference}`}
            strokeLinecap="round"
          />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={`${track * (clamped / 100)} ${circumference}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-semibold text-white tabular-nums">
            {Math.round(clamped)}
            <span className="text-[7px] text-slate-400">{unit}</span>
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {label}
        </p>
        {sub && <p className="truncate text-[8px] text-slate-500">{sub}</p>}
      </div>
    </div>
  )
}
