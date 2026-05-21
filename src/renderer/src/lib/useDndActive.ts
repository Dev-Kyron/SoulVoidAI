/**
 * React hook that returns whether DND/quiet mode is currently active. Recomputes
 * once a minute so the orb dims automatically when a scheduled quiet window
 * begins or ends without needing to refresh anything.
 */
import { useEffect, useState } from 'react'
import { isQuietNow, type DndConfig } from '@shared/types'
import { useConfigStore } from '../store/useConfigStore'

const TICK_MS = 60_000

export function useDndActive(): boolean {
  const dnd = useConfigStore((s) => s.config?.appearance.dnd) as DndConfig | undefined
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  if (!dnd) return false
  return isQuietNow(dnd, new Date(now))
}
