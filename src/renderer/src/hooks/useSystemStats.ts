/**
 * Polls main-process system telemetry (CPU / RAM / uptime) on an interval.
 */
import { useEffect, useState } from 'react'
import { vs } from '../lib/bridge'
import type { SystemStats } from '@shared/types'

export function useSystemStats(intervalMs = 2500): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void vs.system.stats().then((value) => {
        if (alive) setStats(value)
      })
    }
    tick()
    const id = window.setInterval(tick, intervalMs)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [intervalMs])

  return stats
}
