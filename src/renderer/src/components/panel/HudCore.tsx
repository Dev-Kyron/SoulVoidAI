/**
 * The animated centrepiece of the Nexus HUD: counter-rotating energy rings
 * with the orb at the core, encircled by the active mode's quick actions as
 * orbiting nodes. Clicking the core opens the conversation.
 */
import { useMemo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Plus, X } from 'lucide-react'
import { useConfigStore } from '../../store/useConfigStore'
import { useVisibleOrbState } from '../../store/useWidgetStore'
import { useMemoryStore } from '../../store/useMemoryStore'
import { useUiStore } from '../../store/useUiStore'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { useChatStore } from '../../store/useChatStore'
import { getMode } from '@shared/modes'
import { resolveIcon } from '../../lib/icons'
import { runAction } from '../../lib/actions'
import { SpiritAvatar } from '../widget/SpiritAvatar'
import { useDndActive } from '../../lib/useDndActive'

// v1.6.4 — HUD container compressed to fit comfortably inside the
// advanced-mode panel's minHeight (800) without ever clipping. Math:
//   panel minHeight 800 - (header 70 + tabs 40 + cards 75
//     + bottom region 295) = 320 column available
//   inner stack needed = OrbIdentity 50 + HUD_H 240 + padding 24 = 314
//   → 6px breathing room
// Below these numbers the avatar's lower body or the side chips start
// to overlap the gauges.
const HUD_W = 280
const HUD_H = 240
const AVATAR_SIZE = 180
// Avatar's vertical centre inside the container. We anchor the avatar's
// bottom to the container's bottom (with a small breathing-room margin),
// so its centre sits this far down from the container top. Chip orbit
// math uses THIS Y (not HUD_H/2) so chips fan around the figure's
// actual position, not the empty space above it.
const AVATAR_BOTTOM_MARGIN = 4
const AVATAR_CENTER_Y = HUD_H - AVATAR_SIZE / 2 - AVATAR_BOTTOM_MARGIN

// Chip orbit — upper hemisphere only as of v1.6.2 (was 270° including
// the bottom wedge). User feedback: no chips between 135°-225° in
// top=0° convention (= the bottom half in screen coords). Restricting
// to the upper 180° keeps every chip strictly on or above the
// avatar's horizontal axis, so nothing crashes through the torso.
const ARC_START_DEG = -180 // left side, on horizontal
const ARC_SPAN_DEG = 180 // sweep clockwise to right side, via top
const BASE_RADIUS = 100

// Each quick-action chip orbits at its own distance from the avatar
// (not all on one circle). Multipliers cycle per slot index — same
// actions always land at the same distances (no random reshuffle on
// re-render). Tightened spread (was 0.85-1.18) so even the
// outermost chip doesn't leave the container at this arc geometry.
const RADIUS_MULTIPLIERS = [1.0, 0.88, 1.13, 0.94, 1.08, 0.91, 1.05, 0.97, 0.85]

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
  const customActions = useMemoryStore((s) => s.data?.customActions ?? [])
  const dnd = useDndActive()
  if (!config) return null

  const animated = config.appearance.animations
  // Mode actions plus the user's own — the Nexus circle holds at most 8.
  const actions = [...getMode(config.activeMode).quickActions, ...customActions].slice(0, 8)
  // Only the user's own actions can be removed; mode actions are fixed.
  const customIds = new Set(customActions.map((a) => a.id))
  // The "+" node takes its own slot on the arc until the circle is full.
  const showAdd = actions.length < 8
  const slots = actions.length + (showAdd ? 1 : 0)
  // Distribute slots evenly across the upper 180° arc. `slots - 1` in the
  // denominator so endpoints anchor at both ends (left edge / right edge
  // on the horizontal axis), not leaving an unused tail. Single-slot
  // edge case: pin to the top.
  const angleFor = (index: number): number =>
    slots <= 1 ? -90 : ARC_START_DEG + index * (ARC_SPAN_DEG / (slots - 1))
  const radiusFor = (index: number): number =>
    BASE_RADIUS * RADIUS_MULTIPLIERS[index % RADIUS_MULTIPLIERS.length]
  const addIndex = actions.length

  return (
    <div className="relative mx-auto shrink-0" style={{ width: HUD_W, height: HUD_H }}>
      {/* Decorative rings — kept as background atmospherics, but now
       *  positioned around the avatar (lower-centre) instead of the
       *  container centre. Inset becomes "from the figure's bounds"
       *  rather than "from the container", so the rings still ring the
       *  spirit and not empty space. */}
      <div
        className="absolute"
        style={{
          left: HUD_W / 2 - AVATAR_SIZE / 2,
          top: AVATAR_CENTER_Y - AVATAR_SIZE / 2,
          width: AVATAR_SIZE,
          height: AVATAR_SIZE
        }}
      >
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
        {/* Particles radiate from the avatar centre. */}
        <OrbParticles animated={animated} />
      </div>

      {/* v1.6.2 — each chip is tethered to the avatar via its own spoke,
       *  never to the other chips. The shared ring track is gone; each
       *  spoke ends exactly at its own chip's distance from the avatar
       *  centre. */}
      {Array.from({ length: slots }, (_, index) => (
        <div
          key={`spoke-${index}`}
          className="absolute h-px origin-left"
          style={{
            left: HUD_W / 2,
            top: AVATAR_CENTER_Y,
            width: radiusFor(index),
            transform: `rotate(${angleFor(index)}deg)`,
            background: 'linear-gradient(90deg, transparent, var(--accent-ring))'
          }}
        />
      ))}

      {/* Orbiting quick-action nodes — anchored on the avatar, each
       *  bobbing on its own staggered cycle. */}
      {actions.map((quickAction, index) => {
        const angle = angleFor(index)
        const radians = (angle * Math.PI) / 180
        const r = radiusFor(index)
        const x = HUD_W / 2 + r * Math.cos(radians)
        const y = AVATAR_CENTER_Y + r * Math.sin(radians)
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
            <ChipBob index={index} animated={animated}>
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
            </ChipBob>
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
          const r = radiusFor(addIndex)
          const x = HUD_W / 2 + r * Math.cos(radians)
          const y = AVATAR_CENTER_Y + r * Math.sin(radians)
          return (
            <div
              className="absolute"
              style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
            >
              <ChipBob index={addIndex} animated={animated}>
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
              </ChipBob>
            </div>
          )
        })()}

      {/* Spirit Avatar — anchored to the BOTTOM of the HUD container so it
          sits directly above the gauges in the parent NexusView. The
          chips arc above and around it. Tap-to-talk wiring lives on the
          button wrapper. Persona switches the silhouette (Void broader,
          Soul softer) so swapping personas feels like swapping
          companions, not toggling a colour. */}
      <SpiritVoiceButton
        orbState={orbState}
        persona={config.voice.persona}
        animated={animated}
        dnd={dnd}
      />
    </div>
  )
}

/**
 * The spirit avatar wrapped as a voice-toggle button. Calls into the same
 * `useVoiceInputStore.toggle` action the MicButton uses, so wake word,
 * mic icon, and avatar-tap all converge on a single voice pipeline.
 *
 * `speaking` is derived from `useChatStore.streaming` — the model is
 * actively producing tokens that will be spoken. This is an approximation
 * (we don't have per-frame TTS amplitude piped into a store yet), but
 * it's the right signal for the avatar's "I'm talking" body language.
 */
function SpiritVoiceButton({
  orbState,
  persona,
  animated,
  dnd
}: {
  orbState: ReturnType<typeof useVisibleOrbState>
  persona: 'void' | 'soul'
  animated: boolean
  dnd: boolean
}): JSX.Element {
  const status = useVoiceInputStore((s) => s.status)
  const toggle = useVoiceInputStore((s) => s.toggle)
  const streaming = useChatStore((s) => s.streaming)
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const title = transcribing
    ? 'Transcribing…'
    : recording
      ? 'Stop and transcribe'
      : 'Tap to talk'

  // v1.6.2 — anchored to the BOTTOM of the HUD container (not centred)
  // so the avatar sits directly above the gauges in the parent panel.
  // The `bottom: AVATAR_BOTTOM_MARGIN` matches the same constant that
  // determines AVATAR_CENTER_Y, so the chip arc orbits the avatar's
  // actual position rather than empty space above it.
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={transcribing}
      title={title}
      aria-label={title}
      aria-pressed={recording}
      className="absolute left-1/2 -translate-x-1/2 outline-none transition-transform hover:scale-[1.03] active:scale-[0.97] disabled:cursor-wait"
      style={{ bottom: AVATAR_BOTTOM_MARGIN }}
    >
      <SpiritAvatar
        size={AVATAR_SIZE}
        persona={persona}
        state={orbState}
        speaking={streaming}
        animated={animated}
        dnd={dnd}
      />
    </button>
  )
}

/**
 * Wraps a quick-action chip in a subtle vertical bob — the chips drift
 * up and down on their own schedule (staggered phase + slightly varied
 * period per slot) so the cluster feels alive rather than rigid.
 *
 * Amplitude is small on purpose (±3px). Big bobs at the chip level
 * compete visually with the avatar's own breath + halo pulse and start
 * to feel busy. The hover/tap framer-motion props on the inner button
 * stack cleanly on top of this transform — the chip can scale on hover
 * while still bobbing.
 */
function ChipBob({
  index,
  animated,
  children
}: {
  index: number
  animated: boolean
  children: ReactNode
}): JSX.Element {
  // Per-slot duration variation prevents synchronised "wave" patterns.
  // Cycling 3 distinct periods (~2.8 / 3.2 / 3.6s) means even chips at
  // adjacent slots drift out of phase quickly.
  const duration = 2.8 + (index % 3) * 0.4
  const delay = (index * 0.27) % 2
  return (
    <motion.div
      animate={animated ? { y: [0, -3, 0] } : undefined}
      transition={{ duration, repeat: Infinity, delay, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  )
}
