/**
 * Top-level widget shell: swaps between the collapsed orb and the expanded
 * command panel. The collapsed orb is draggable — hold left-click and move to
 * reposition the window; a click without movement opens the panel.
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Orb } from './Orb'
import { CommandPanel } from '../panel/CommandPanel'
import { useWidgetStore, useVisibleOrbState } from '../../store/useWidgetStore'
import { useConfigStore } from '../../store/useConfigStore'
import { vs } from '../../lib/bridge'
import { useDndActive } from '../../lib/useDndActive'

const DRAG_THRESHOLD = 4

function OrbButton(): JSX.Element {
  const expand = useWidgetStore((s) => s.expand)
  const orbState = useVisibleOrbState()
  const animated = useConfigStore((s) => s.config?.appearance.animations ?? true)
  const dnd = useDndActive()
  // Hold an AbortController per drag so an unmount mid-drag (e.g. the
  // panel expand fires from a hotkey while the user still has the orb
  // mouse-pressed) cleans up the window-level mousemove/mouseup listeners.
  // Without this they'd leak and call vs.window.moveBy on every subsequent
  // mouse move anywhere on screen.
  const dragAbortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      dragAbortRef.current?.abort()
    },
    []
  )

  // Hold-and-move drags the window; a clean click (no movement) expands.
  const onMouseDown = (event: ReactMouseEvent): void => {
    if (event.button !== 0) return
    dragAbortRef.current?.abort()
    const ctrl = new AbortController()
    dragAbortRef.current = ctrl
    const startX = event.screenX
    const startY = event.screenY
    let lastX = startX
    let lastY = startY
    let moved = false

    const onMove = (e: globalThis.MouseEvent): void => {
      const dx = e.screenX - lastX
      const dy = e.screenY - lastY
      lastX = e.screenX
      lastY = e.screenY
      if (Math.hypot(e.screenX - startX, e.screenY - startY) > DRAG_THRESHOLD) moved = true
      if (dx !== 0 || dy !== 0) void vs.window.moveBy(dx, dy)
    }
    const onUp = (): void => {
      ctrl.abort()
      if (!moved) void expand()
    }
    window.addEventListener('mousemove', onMove, { signal: ctrl.signal })
    window.addEventListener('mouseup', onUp, { signal: ctrl.signal })
  }

  return (
    <motion.div
      className="flex h-screen w-screen items-center justify-center"
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.5, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 22 }}
    >
      <button
        type="button"
        onMouseDown={onMouseDown}
        className="rounded-full outline-none transition-transform hover:scale-[1.06] active:scale-95"
        title="Click to open · hold and drag to move"
        aria-label="Open VoidSoul"
      >
        <Orb size={54} state={orbState} animated={animated} dnd={dnd} />
      </button>
    </motion.div>
  )
}

export function FloatingWidget(): JSX.Element {
  const expanded = useWidgetStore((s) => s.expanded)
  const finishCollapse = useWidgetStore((s) => s.finishCollapse)

  return (
    <AnimatePresence mode="wait" onExitComplete={finishCollapse}>
      {expanded ? <CommandPanel key="panel" /> : <OrbButton key="orb" />}
    </AnimatePresence>
  )
}
