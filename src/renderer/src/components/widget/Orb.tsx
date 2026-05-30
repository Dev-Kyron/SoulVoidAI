/**
 * The holographic VoidSoul orb. A layered set of motion elements — outer glow,
 * rotating energy ring, core sphere and specular highlight — whose colour and
 * tempo reflect the current widget state.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { STATE_COLOR } from '../../lib/utils'
import type { WidgetState } from '@shared/types'

interface OrbProps {
  size: number
  state: WidgetState
  animated?: boolean
  /** When true, the orb renders dimmed (DND / quiet mode). */
  dnd?: boolean
}

export function Orb({ size, state, animated = true, dnd = false }: OrbProps): JSX.Element {
  const color = dnd
    ? 'rgba(120,120,140,0.55)'
    : state === 'idle'
      ? 'var(--accent)'
      : STATE_COLOR[state]
  // In DND the orb still gently animates so the user knows it's alive — just
  // muted. Processing/listening still pulse normally because those represent
  // explicit user-initiated activity.
  const processing = state === 'processing'
  // `wakeListening` is the baseline "engine armed" pulse — slower & gentler
  // than `processing` (which means a model call is in flight) so the user can
  // tell at a glance whether the orb is just waiting or actually working.
  const wakeListening = state === 'wake-listening'
  // The mask only needs an opaque colour beyond 60% — what colour doesn't
  // matter since the mask is applied to a separate motion.div, not the
  // bubble underneath. Black is fine in both themes.
  const ringMask = 'radial-gradient(transparent 56%, #000 60%)'

  // Per-state tempo. processing = urgent (~1s), wake-listening = patient (~3.2s),
  // everything else = the existing idle breathing (~6-7s). Memoised so framer-
  // motion doesn't see a new transition reference on every parent re-render
  // and restart the animation; we only want a restart when state actually flips.
  const tempo = useMemo(
    () => ({
      glowDuration: processing ? 1.1 : wakeListening ? 3.2 : 6,
      ringDuration: processing ? 2.6 : wakeListening ? 10 : 20,
      coreDuration: processing ? 0.95 : wakeListening ? 3.0 : 7,
      glowScale: processing ? [1, 1.2, 1] : wakeListening ? [1, 1.12, 1] : [1, 1.07, 1],
      coreScale: processing ? [1, 0.9, 1] : wakeListening ? [1, 1.05, 1] : [1, 1.03, 1]
    }),
    [processing, wakeListening]
  )

  return (
    <div
      className="relative"
      style={{ width: size, height: size, opacity: dnd ? 0.45 : 1 }}
      aria-hidden
    >
      {/* Outer glow */}
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle, ${color} 0%, transparent 68%)`,
          filter: 'blur(10px)',
          opacity: 0.65
        }}
        animate={animated ? { scale: tempo.glowScale, opacity: [0.5, 0.82, 0.5] } : undefined}
        transition={{ duration: tempo.glowDuration, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Rotating energy ring */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: size * 0.05,
          background: `conic-gradient(from 0deg, transparent 0%, ${color} 35%, var(--orb-sheen) 50%, ${color} 65%, transparent 100%)`,
          opacity: 0.6,
          mask: ringMask,
          WebkitMask: ringMask
        }}
        animate={animated ? { rotate: 360 } : undefined}
        transition={{ duration: tempo.ringDuration, repeat: Infinity, ease: 'linear' }}
      />

      {/* Core sphere */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: size * 0.16,
          background: `radial-gradient(circle at 34% 30%, rgba(255,255,255,0.95) 0%, ${color} 40%, var(--orb-core) 100%)`,
          boxShadow: `0 0 ${size * 0.32}px ${color}, inset 0 0 ${size * 0.22}px rgba(255,255,255,0.35)`
        }}
        animate={animated ? { scale: tempo.coreScale } : undefined}
        transition={{ duration: tempo.coreDuration, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Specular highlight */}
      <div
        className="absolute rounded-full"
        style={{
          width: size * 0.2,
          height: size * 0.2,
          left: size * 0.31,
          top: size * 0.26,
          background: 'radial-gradient(circle, rgba(255,255,255,0.9) 0%, transparent 70%)'
        }}
      />
    </div>
  )
}
