/**
 * Spirit Avatar — the dotted-hologram humanoid that replaces the static orb
 * on the Nexus panel in v1.6.0. Two persona silhouettes (Void = broader,
 * Soul = softer) made of ~100 procedurally-placed dots, each with a slow
 * individual opacity shimmer. The whole figure reacts to four states:
 *
 *   idle          — slow breath + gentle dot shimmer
 *   listening     — slight inward contraction (the figure "leans in")
 *   thinking      — subtle sway around the head (the figure ponders)
 *   speaking      — overall pulse at ~3Hz + brighter halo
 *
 * Implementation notes:
 *   · Dots are rendered as SVG `<circle>` elements inside a viewBox-100
 *     coordinate system. Positions are deterministic per persona (seeded
 *     PRNG) so the figure looks the same across renders.
 *   · Per-dot shimmer uses a single CSS `@keyframes` (defined in
 *     index.css) with `animation-delay` driving each dot's phase — cheap,
 *     GPU-accelerated. Framer-motion is reserved for the state-driven
 *     outer-group transforms.
 *   · The component is `aria-hidden` and wraps inside a button at the
 *     call site; tap-to-talk semantics live there, not here.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { WidgetState, VoicePersona } from '@shared/types'

interface SpiritAvatarProps {
  /** Height in pixels — width derives at a 0.6 aspect ratio. */
  size: number
  persona: VoicePersona
  state: WidgetState
  /** True while Soul is actively producing speech audio (TTS playing).
   *  Distinct from `state` because TTS playback and chat-stream "processing"
   *  can overlap (we kept talking after the model finished generating). */
  speaking?: boolean
  animated?: boolean
  /** Dim + desaturate (Do Not Disturb mode). */
  dnd?: boolean
}

/** Mulberry32 — tiny deterministic PRNG. Two known seeds give two stable
 *  dot layouts that don't reshuffle on every render. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return function (): number {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A silhouette is the union of ellipses. A point is inside the figure if
 *  it lies inside any of them. Coordinates are in viewBox units (0–100). */
interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

interface Silhouette {
  parts: Ellipse[]
}

/**
 * Persona silhouettes. Both fit inside a 100x100 viewBox biased upward —
 * head sits near y=17, body extends to y=98. v1.6.5 refinement:
 *
 *   · Soul = hourglass (narrow shoulders, narrow waist, wider hips)
 *   · Void = V-shape (broad shoulders, thick arms, narrow hips)
 *
 * The torso ellipse on both is RAISED (cy lower) and TALLER (ry larger)
 * vs the v1.6.2 cut — this fills the gap that used to appear between
 * the descending shoulder line and the descending arm (the "armpit
 * dead zone" beta users flagged). Arms are now full-length, reaching
 * roughly wrist height instead of stopping at the upper hip.
 */
const SILHOUETTES: Record<VoicePersona, Silhouette> = {
  soul: {
    parts: [
      // v1.6.8 — hair is no longer rendered as dot-sampled ellipses;
      // it's drawn as flowing bezier-curve strands by `HAIR_STRANDS`
      // below. The body silhouette only covers the actual figure.
      { cx: 50, cy: 17, rx: 13, ry: 15 }, // head — rounder
      // v1.6.7 — neck enlarged (was rx=4 ry=4) to bridge the head→
      // shoulder gap. Coverage-aware sampling was thinning the tiny
      // original neck to near-empty, which read as a dark band across
      // the chin/collarbone area. rx=6 ry=5 gives enough single-
      // coverage area for the neck to actually render as silhouette.
      { cx: 50, cy: 32, rx: 6, ry: 5 },
      { cx: 50, cy: 47, rx: 24, ry: 12 }, // shoulders — narrowed (was rx=27)
      // Arms — full length (ry 24, was 17), thin (rx 4.2 was 5).
      // Hanging from inside the narrowed shoulder line so the figure
      // reads feminine — slender limbs, not bulky.
      { cx: 22, cy: 70, rx: 4.2, ry: 24 }, // left arm
      { cx: 78, cy: 70, rx: 4.2, ry: 24 }, // right arm
      // Torso raised + taller (was cy=72 ry=17) to fill the armpit gap.
      { cx: 50, cy: 65, rx: 21, ry: 18 }, // torso
      // Hourglass: narrow waist between torso and hips.
      { cx: 50, cy: 82, rx: 15, ry: 6 }, // waist
      // Hips wider than waist — feminine silhouette.
      { cx: 50, cy: 91, rx: 19, ry: 9 } // hips
    ]
  },
  void: {
    parts: [
      // v1.6.8 — hair handled by HAIR_STRANDS bezier renderer (see
      // below). The body silhouette only includes anatomy.
      // Head — narrower (rx 14→13) and TALLER (ry 14→16). Was a perfect
      // circle which read as cartoonish; the elongated ratio reads as
      // a more masculine, jaw-defined shape.
      { cx: 50, cy: 16, rx: 13, ry: 16 },
      // v1.6.7 — neck enlarged for the same reason as Soul: tiny
      // single-ellipse neck got eaten by coverage-weighted sampling.
      { cx: 50, cy: 33, rx: 7, ry: 5 },
      { cx: 50, cy: 47, rx: 36, ry: 14 }, // shoulders — broader (was rx=34)
      // Arms — full length, thick. Hanging just inside the broad
      // shoulder line so they read as "hangs from the shoulder"
      // rather than "stuck to the torso".
      { cx: 14, cy: 70, rx: 6, ry: 26 }, // left arm
      { cx: 86, cy: 70, rx: 6, ry: 26 }, // right arm
      // Torso raised + taller to fill the armpit gap and read as
      // broad-chested.
      { cx: 50, cy: 67, rx: 28, ry: 22 },
      // No waist narrowing — masculine V-shape goes straight to hips.
      // Hips narrower than the torso reinforces the V-line.
      { cx: 50, cy: 91, rx: 22, ry: 9 }
    ]
  }
}

/**
 * How many silhouette ellipses contain (x, y). Used by `generateDots`
 * to thin dots in multi-coverage zones — the shoulder/torso/arm
 * intersection (the "armpit" area) was previously accumulating 3× the
 * density of single-coverage regions, which read visually as a blob.
 * Returning a count lets the sampler accept overlap-zone candidates
 * proportionally less often. A zero result also means "outside the
 * silhouette" so callers don't need a separate inside check.
 */
function coverageAt(x: number, y: number, shape: Silhouette): number {
  let count = 0
  for (const p of shape.parts) {
    const dx = (x - p.cx) / p.rx
    const dy = (y - p.cy) / p.ry
    if (dx * dx + dy * dy <= 1) count++
  }
  return count
}

interface Dot {
  x: number
  y: number
  r: number
  /** 0–1 — per-dot baseline opacity. Mixed with state multipliers at render. */
  baseOpacity: number
  /** Shimmer animation delay in seconds. */
  delay: number
  /** Shimmer animation duration in seconds. Slight per-dot variation
   *  prevents synchronised "wave" patterns that look mechanical. */
  duration: number
  /** True if the dot sits in the upper third of the figure (head/face). The
   *  `listening` state biases head dots up in opacity (the figure perks). */
  isHead: boolean
}

/** Sample N dots inside the silhouette using rejection sampling. Stops
 *  early if the silhouette is too sparse to fit N. v1.6.3: coverage-
 *  weighted rejection — points in zones covered by multiple ellipses
 *  (the shoulder/torso/arm intersection) accept proportionally less
 *  often, so the figure has a uniform density instead of a dense blob
 *  at every join. */
function generateDots(persona: VoicePersona, count: number, seed: number): Dot[] {
  const rng = mulberry32(seed)
  const shape = SILHOUETTES[persona]
  const dots: Dot[] = []
  const maxAttempts = count * 120
  let attempts = 0
  while (dots.length < count && attempts < maxAttempts) {
    attempts++
    const x = rng() * 100
    const y = rng() * 100
    const cov = coverageAt(x, y, shape)
    if (cov === 0) continue
    // Accept with probability 1/coverage so triple-coverage areas
    // only land ~33% of the dots they would at single coverage. Net
    // effect: density across the figure stays even, no armpit blob.
    if (rng() > 1 / cov) continue
    dots.push({
      x,
      y,
      r: 0.45 + rng() * 1.15,
      // v1.6.2: bumped baseline range (was 0.22-0.60) — body is now
      // near-black instead of white, so the dots need to be more opaque
      // to read as a coherent silhouette against the bright halo
      // behind them. Anything below ~0.5 disappears into the halo glow.
      baseOpacity: 0.55 + rng() * 0.35,
      delay: rng() * 5,
      duration: 3.5 + rng() * 2.5,
      isHead: y < 33
    })
  }
  return dots
}

// Dot layouts computed once at module scope — deterministic per
// persona/seed, no regen on mount. v1.6.2: density doubled to 6× the
// v1.6.0 first cut (660 / 780 dots) — the figure now reads as a real
// dense silhouette rather than scattered particles. Still cheap: each
// dot is a single SVG circle with a GPU-accelerated CSS opacity loop.
const DOTS: Record<VoicePersona, Dot[]> = {
  soul: generateDots('soul', 660, 0x501),
  void: generateDots('void', 780, 0x40d)
}

/**
 * Hand-placed eye landmarks. These sit on top of the dot field — they're
 * what carries the avatar's personality, so they're not procedurally
 * sampled; they're authored. Coordinates in viewBox-100 space, biased to
 * the lower half of the head silhouette where eyes naturally sit.
 */
const EYES: Record<VoicePersona, { x: number; y: number }[]> = {
  soul: [
    { x: 45, y: 18 }, // left eye — slightly narrower spacing for softer face
    { x: 55, y: 18 } // right eye
  ],
  void: [
    // Void's head got narrower (14→13) and taller (14→16). Eyes pull
    // in to 45/55 to keep proportional spacing, and drop 1 unit to
    // sit on the new head's vertical midline.
    { x: 45, y: 16 },
    { x: 55, y: 16 }
  ]
}

/**
 * Persona palette — split into body/eye/halo so each layer can be tuned
 * independently. v1.6.2 refinement: bodies are now near-black (deep
 * violet undertone, almost shadow) — the figure reads as a silhouette
 * against the bright accent halo behind it, matching the anime
 * spirit-character aesthetic the user referenced. Eyes are softer than
 * v1.6.1 ("less staring-into-you") so the gaze feels watchful, not
 * confrontational.
 */
interface Palette {
  body: string
  eyeOuter: string // soft purple glow ring
  eyeMid: string // brighter middle ring
  eyeCore: string // tiny near-white centre
  halo: string
}

const PALETTES: Record<VoicePersona, Palette> = {
  soul: {
    body: 'rgba(18, 10, 32, 0.88)', // deep violet-black silhouette
    // v1.6.7 — eye opacities pulled down further (outer 0.32→0.22, mid
    // 0.7→0.55, core 0.85→0.75) so the bright eyes don't punch a
    // visible "gap" through the surrounding face dots. Subtler glow,
    // less contrast, face reads continuous.
    eyeOuter: 'rgba(168, 85, 247, 0.22)',
    eyeMid: 'rgba(192, 132, 252, 0.55)',
    eyeCore: 'rgba(232, 220, 255, 0.75)',
    halo: 'var(--accent)'
  },
  void: {
    body: 'rgba(14, 10, 28, 0.85)', // even darker for Void — cooler shadow
    eyeOuter: 'rgba(124, 92, 255, 0.3)',
    eyeMid: 'rgba(167, 139, 250, 0.7)',
    eyeCore: 'rgba(225, 225, 250, 0.82)',
    // v1.6.6 — was #a5b4fc (indigo-300), which on the dark panel
    // background washed out to near-white. #a855f7 (purple-500) is a
    // vivid purple that's clearly distinguishable from Soul's deeper
    // violet (var(--accent) = #7c3aed) — Void reads as a brighter,
    // more electric purple aura, Soul as a deeper brand violet.
    halo: '#a855f7'
  }
}

const DND_PALETTE: Palette = {
  body: 'rgba(40, 38, 55, 0.7)', // muted dark, still readable as silhouette
  eyeOuter: 'rgba(140, 145, 165, 0.25)',
  eyeMid: 'rgba(160, 165, 185, 0.5)',
  eyeCore: 'rgba(200, 205, 220, 0.65)',
  halo: 'rgba(140, 145, 165, 0.7)'
}

function paletteFor(persona: VoicePersona, dnd: boolean): Palette {
  return dnd ? DND_PALETTE : PALETTES[persona]
}

export function SpiritAvatar({
  size,
  persona,
  state,
  speaking = false,
  animated = true,
  dnd = false
}: SpiritAvatarProps): JSX.Element {
  const dots = DOTS[persona]
  const eyes = EYES[persona]
  const palette = paletteFor(persona, dnd)

  const listening = state === 'listening'
  const processing = state === 'processing'
  const error = state === 'error'

  // Per-state outer-group transform. Reset to base on idle so the figure
  // doesn't carry over a half-finished sway when state flips back.
  // Memoised so framer-motion doesn't see a new transition reference on
  // every render and restart the animation mid-cycle.
  const groupAnimate = useMemo(() => {
    if (!animated) return undefined
    if (speaking) return { scale: [1, 1.035, 1], y: [0, -0.6, 0] }
    if (listening) return { scale: [1, 0.985, 1] }
    if (processing) return { rotate: [0, 1.6, -1.6, 0] }
    if (error) return { x: [0, -1.2, 1.2, 0] }
    return { scale: [1, 1.012, 1] } // gentle idle breath
  }, [animated, speaking, listening, processing, error])

  const groupDuration = speaking ? 0.85 : processing ? 2.4 : listening ? 2.6 : 5.2

  // Halo intensity tracks state — louder when speaking, dim under DND.
  // v1.6.2: bumped across the board (was idle 0.4 / speaking 0.7) — the
  // body is now a dark silhouette so the halo IS the brand colour visible
  // on the panel. Below ~0.55 idle the figure reads as a black blob
  // without enough backlit-aura energy.
  const haloOpacity = dnd ? 0.2 : speaking ? 0.88 : listening ? 0.72 : processing ? 0.66 : 0.55

  // Eye intensity tracks state — eyes brighten when the avatar is paying
  // attention (listening, processing) or actively speaking. The pulse
  // animation runs through CSS on the middle ring (see spirit-eye-pulse
  // in index.css) so it's independent of the group transform.
  const eyeAlive = animated && (speaking || listening || processing)

  // Width biased narrower than tall — torso silhouettes are vertical.
  // v1.6.2: bumped 0.62 → 0.78 so the new hanging arms (which extend
  // to viewBox x≈11/89 for Void) aren't clipped at the container edge.
  const width = Math.round(size * 0.78)

  return (
    <div className="relative" style={{ width, height: size, opacity: dnd ? 0.55 : 1 }} aria-hidden>
      {/* Soft accent halo behind the figure — sits behind the dots and
       *  brightens with state. The ellipse is biased toward the head so
       *  the glow feels like aura rather than a flat backdrop. */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 60% 70% at 50% 30%, ${palette.halo}, transparent 70%)`,
          filter: 'blur(18px)',
          opacity: haloOpacity
        }}
        animate={
          animated
            ? {
                opacity: [haloOpacity * 0.78, haloOpacity, haloOpacity * 0.78]
              }
            : undefined
        }
        transition={{ duration: speaking ? 1.1 : 4.2, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* The dotted silhouette + eyes. preserveAspectRatio keeps the figure
       *  proportional to the surrounding HUD container. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
      >
        <motion.g
          animate={groupAnimate}
          transition={{ duration: groupDuration, repeat: Infinity, ease: 'easeInOut' }}
          style={{ transformOrigin: '50px 50px' }}
        >
          {/* Body dots — pale "made of starlight" particles. */}
          {dots.map((dot, i) => {
            // Head dots brighten under listening + processing — the figure
            // perks up its attention.
            const headBoost = dot.isHead && (listening || processing) ? 0.18 : 0
            const stateOpacity = Math.min(1, dot.baseOpacity + headBoost)
            return (
              <circle
                key={i}
                cx={dot.x}
                cy={dot.y}
                r={dot.r}
                fill={palette.body}
                opacity={stateOpacity}
                style={
                  animated
                    ? {
                        animation: `spirit-shimmer ${dot.duration}s ease-in-out ${dot.delay}s infinite`
                      }
                    : undefined
                }
              />
            )
          })}

          {/* Eyes — the avatar's personality. Three stacked circles per eye
           *  build the glow without an SVG filter (filters are GPU-cheap
           *  but heavier than overlapping shapes, and we want this to
           *  scream even on weaker integrated GPUs). Order: outer haze →
           *  mid ring → tiny bright core. v1.6.6: sizes pulled in
           *  per-persona — Soul's daintier proportions need smaller eyes
           *  so the haze doesn't blanket her whole face. */}
          {eyes.map((eye, i) => (
            <g key={`eye-${i}`}>
              <circle
                cx={eye.x}
                cy={eye.y}
                r={persona === 'soul' ? 2.6 : 3.6}
                fill={palette.eyeOuter}
                style={
                  eyeAlive
                    ? {
                        animation: `spirit-eye-pulse ${speaking ? 0.9 : 2.4}s ease-in-out infinite`
                      }
                    : undefined
                }
              />
              <circle
                cx={eye.x}
                cy={eye.y}
                r={persona === 'soul' ? 1.5 : 1.9}
                fill={palette.eyeMid}
              />
              <circle
                cx={eye.x}
                cy={eye.y}
                r={persona === 'soul' ? 0.7 : 0.85}
                fill={palette.eyeCore}
              />
            </g>
          ))}
        </motion.g>
      </svg>
    </div>
  )
}
