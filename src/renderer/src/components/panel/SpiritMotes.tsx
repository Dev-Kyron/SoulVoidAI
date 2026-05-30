/**
 * Ambient "spirit forest" layer — soft jade aurora blooms and slowly drifting
 * motes of light, echoing VoidSoul's branding. Rendered behind the panel
 * content, non-interactive, and stilled when animations are disabled.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { useConfigStore } from '../../store/useConfigStore'

const MOTE_COLORS = ['#86efac', '#a7f3d0', '#a5f3fc', '#fde68a']

interface Mote {
  id: number
  left: number
  size: number
  duration: number
  delay: number
  drift: number
  color: string
}

interface Bloom {
  id: number
  size: number
  x: string
  y: string
  color: string
  duration: number
}

const BLOOMS: Bloom[] = [
  { id: 0, size: 300, x: '-22%', y: '-18%', color: 'rgba(16,185,129,0.20)', duration: 26 },
  { id: 1, size: 260, x: '68%', y: '70%', color: 'rgba(34,211,238,0.14)', duration: 32 },
  { id: 2, size: 220, x: '34%', y: '40%', color: 'rgba(52,211,153,0.12)', duration: 30 }
]

export function SpiritMotes(): JSX.Element {
  const animated = useConfigStore((s) => s.config?.appearance.animations ?? true)

  const motes = useMemo<Mote[]>(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        size: 2.5 + Math.random() * 5,
        duration: 16 + Math.random() * 18,
        delay: -Math.random() * 32,
        drift: (Math.random() - 0.5) * 52,
        color: MOTE_COLORS[i % MOTE_COLORS.length]
      })),
    []
  )

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Soft jade aurora blooms. */}
      {BLOOMS.map((bloom) => (
        <motion.div
          key={`bloom-${bloom.id}`}
          className="absolute rounded-full"
          style={{
            width: bloom.size,
            height: bloom.size,
            left: bloom.x,
            top: bloom.y,
            background: `radial-gradient(circle, ${bloom.color} 0%, transparent 70%)`,
            filter: 'blur(34px)'
          }}
          animate={
            animated
              ? { scale: [1, 1.16, 1], x: [0, 18, 0], y: [0, -14, 0], opacity: [0.55, 0.85, 0.55] }
              : undefined
          }
          transition={{ duration: bloom.duration, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}

      {/* Drifting spirit motes. */}
      {animated &&
        motes.map((mote) => (
          <motion.span
            key={`mote-${mote.id}`}
            className="absolute rounded-full"
            style={{
              left: `${mote.left}%`,
              bottom: -12,
              width: mote.size,
              height: mote.size,
              background: `radial-gradient(circle, ${mote.color} 0%, transparent 70%)`
            }}
            animate={{
              y: [0, -740],
              x: [0, mote.drift, -mote.drift, 0],
              opacity: [0, 0.6, 0.6, 0]
            }}
            transition={{
              duration: mote.duration,
              delay: mote.delay,
              repeat: Infinity,
              ease: 'linear'
            }}
          />
        ))}
    </div>
  )
}
