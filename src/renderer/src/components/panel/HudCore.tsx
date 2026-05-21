/**
 * The animated centrepiece of the Nexus HUD: counter-rotating energy rings
 * with the orb at the core, encircled by the active mode's quick actions as
 * orbiting nodes. Clicking the core opens the conversation.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Plus, X } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useWidgetStore, useVisibleOrbState } from '../../store/useWidgetStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useUiStore } from '../../store/useUiStore'
import { getMode } from '@shared/modes'
import { resolveIcon } from '../../lib/icons'
import { runAction } from '../../lib/actions'
import { Orb } from '../widget/Orb'
import { useDndActive } from '../../lib/useDndActive'

const SIZE = 248

const PARTICLE_COLORS = ['var(--accent)', '#a5f3fc', '#a7f3d0', '#ffffff']

/** Energy motes rising from the core orb — the HUD's centrepiece. */
function OrbParticles({ animated }: { animated: boolean }): JSX.Element | null {
  const particles = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        id: i,
        originX: (Math.random() - 0.5) * 36,
        sway: (Math.random() - 0.5) * 42,
        rise: 80 + Math.random() * 100,
        size: 2 + Math.random() * 4,
        duration: 3 + Math.random() * 3,
        delay: Math.random() * 5,
        color: PARTICLE_COLORS[i % PARTICLE_COLORS.length]
      })),
    []
  )

  if (!animated) return null

  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            marginLeft: -p.size / 2,
            marginTop: -p.size / 2,
            background: `radial-gradient(circle, ${p.color} 0%, transparent 70%)`
          }}
          animate={{
            x: [p.originX, p.originX + p.sway, p.originX - p.sway * 0.4],
            y: [0, -p.rise],
            opacity: [0, 0.85, 0],
            scale: [0.3, 1, 0.4]
          }}
          transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}
    </div>
  )
}

interface RingProps {
  inset: number
  band: [number, number]
  pattern: string
  duration: number
  reverse?: boolean
  animated: boolean
}

function Ring({ inset, band, pattern, duration, reverse, animated }: RingProps): JSX.Element {
  const mask = `radial-gradient(circle, transparent ${band[0]}%, #000 ${band[0]}%, #000 ${band[1]}%, transparent ${band[1]}%)`
  return (
    <motion.div
      className="absolute rounded-full"
      style={{ inset, background: pattern, mask, WebkitMask: mask }}
      animate={animated ? { rotate: reverse ? -360 : 360 } : undefined}
      transition={{ duration, repeat: Infinity, ease: 'linear' }}
    />
  )
}

export function HudCore(): JSX.Element | null {
  const config = useConfigStore((s) => s.config)
  const orbState = useVisibleOrbState()
  const setTab = useWidgetStore((s) => s.setTab)
  const customActions = useMemoryStore((s) => s.data?.customActions ?? [])
  const dnd = useDndActive()
  if (!config) return null

  const animated = config.appearance.animations
  // Mode actions plus the user's own — the Nexus circle holds at most 8.
  const actions = [...getMode(config.activeMode).quickActions, ...customActions].slice(0, 8)
  // Only the user's own actions can be removed; mode actions are fixed.
  const customIds = new Set(customActions.map((a) => a.id))
  const radius = SIZE / 2 - 30
  // The "+" node takes its own slot on the orbit until the circle is full.
  const showAdd = actions.length < 8
  const slots = actions.length + (showAdd ? 1 : 0)
  const angleFor = (index: number): number => -90 + index * (360 / slots)
  const addIndex = actions.length

  return (
    <div className="relative mx-auto shrink-0" style={{ width: SIZE, height: SIZE }}>
      <Ring
        inset={0}
        band={[92, 100]}
        pattern="repeating-conic-gradient(from 0deg, var(--accent) 0deg 0.7deg, transparent 0.7deg 7deg)"
        duration={38}
        animated={animated}
      />
      <Ring
        inset={13}
        band={[78, 100]}
        pattern="conic-gradient(from 0deg, transparent 0deg 18deg, var(--accent) 18deg 64deg, transparent 64deg 188deg, var(--accent) 188deg 230deg, transparent 230deg 360deg)"
        duration={22}
        reverse
        animated={animated}
      />
      <Ring
        inset={25}
        band={[86, 100]}
        pattern="repeating-conic-gradient(from 0deg, rgba(255,255,255,0.45) 0deg 0.5deg, transparent 0.5deg 15deg)"
        duration={52}
        animated={animated}
      />

      {/* Energy particles radiating from the core orb. */}
      <OrbParticles animated={animated} />

      {/* Track the action nodes sit on. */}
      <div className="absolute rounded-full border border-white/10" style={{ inset: 30 }} />

      {/* Connector spokes (behind the nodes). */}
      {Array.from({ length: slots }, (_, index) => (
        <div
          key={`spoke-${index}`}
          className="absolute left-1/2 top-1/2 h-px origin-left"
          style={{
            width: radius,
            transform: `rotate(${angleFor(index)}deg)`,
            background: 'linear-gradient(90deg, transparent, var(--accent-ring))'
          }}
        />
      ))}

      {/* Orbiting quick-action nodes. */}
      {actions.map((quickAction, index) => {
        const angle = angleFor(index)
        const radians = (angle * Math.PI) / 180
        const x = SIZE / 2 + radius * Math.cos(radians)
        const y = SIZE / 2 + radius * Math.sin(radians)
        const Icon = resolveIcon(quickAction.icon)
        const granted = quickAction.requires
          ? (config.permissions[quickAction.requires]?.granted ?? false)
          : true
        const custom = customIds.has(quickAction.id)

        return (
          <div
            key={quickAction.id}
            className="group absolute"
            style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
          >
            <motion.button
              type="button"
              onClick={() => void runAction(quickAction.action, quickAction.label)}
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.94 }}
              className="flex w-[62px] flex-col items-center"
              title={quickAction.description}
            >
              <span className="relative flex h-10 w-10 items-center justify-center rounded-full border border-[var(--accent-ring)] bg-void-700/90 text-[var(--accent)] shadow-glow transition group-hover:bg-[var(--accent)] group-hover:text-white">
                <Icon size={16} />
                {!granted && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-void-800" />
                )}
              </span>
              <span className="mt-1 max-w-[60px] truncate text-[8px] font-medium uppercase tracking-wide text-slate-400 transition group-hover:text-white">
                {quickAction.label}
              </span>
            </motion.button>
            {custom && (
              <button
                type="button"
                onClick={() =>
                  useUiStore
                    .getState()
                    .setActionToDelete({ id: quickAction.id, label: quickAction.label })
                }
                title="Remove from Nexus"
                className="absolute z-10 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white opacity-0 ring-2 ring-void-800 transition hover:bg-rose-400 group-hover:opacity-100"
                style={{ left: 2, top: -6 }}
              >
                <X size={9} />
              </button>
            )}
          </div>
        )
      })}

      {/* "+" node — opens the dialog to add a custom quick action. */}
      {showAdd &&
        (() => {
          const radians = (angleFor(addIndex) * Math.PI) / 180
          const x = SIZE / 2 + radius * Math.cos(radians)
          const y = SIZE / 2 + radius * Math.sin(radians)
          return (
            <div
              className="absolute"
              style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
            >
              <motion.button
                type="button"
                onClick={() => useUiStore.getState().setAddActionOpen(true)}
                whileHover={{ scale: 1.12 }}
                whileTap={{ scale: 0.94 }}
                className="group flex w-[62px] flex-col items-center"
                title="Add a quick action"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-white/25 bg-void-700/70 text-slate-400 transition group-hover:border-[var(--accent)] group-hover:text-[var(--accent)]">
                  <Plus size={16} />
                </span>
                <span className="mt-1 max-w-[60px] truncate text-[8px] font-medium uppercase tracking-wide text-slate-500 transition group-hover:text-[var(--accent)]">
                  Add
                </span>
              </motion.button>
            </div>
          )
        })()}

      {/* Core orb — opens the conversation. */}
      <button
        type="button"
        onClick={() => setTab('chat')}
        title="Open conversation"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none transition-transform hover:scale-105 active:scale-95"
      >
        <Orb size={66} state={orbState} animated={animated} dnd={dnd} />
      </button>
    </div>
  )
}
