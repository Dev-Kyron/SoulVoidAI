/**
 * Bridge hooks shared by the panel and Settings windows. Two responsibilities:
 *   1. Subscribe to the cross-window `config:updated` broadcast so any edit
 *      from the other window lands here without a round-trip.
 *   2. Mirror the active accent into CSS custom properties.
 *
 * Both windows used to inline these effects; centralising them prevents
 * drift (and means a new top-level shell — e.g. a future "compose" window —
 * inherits both behaviours by calling one hook).
 */
import { useEffect } from 'react'
import { vs } from './bridge'
import { useConfigStore } from '../store/useConfigStore'
import { ACCENTS } from './utils'
import type { AccentColor } from '@shared/types'

/** Pushes the active accent into the `--accent*` CSS custom properties. */
export function useAccentTheme(accent: AccentColor | undefined): void {
  useEffect(() => {
    if (!accent) return
    const theme = ACCENTS[accent]
    const root = document.documentElement
    root.style.setProperty('--accent', theme.hex)
    root.style.setProperty('--accent-glow', theme.glow)
    root.style.setProperty('--accent-soft', theme.soft)
    root.style.setProperty('--accent-ring', theme.ring)
  }, [accent])
}

/**
 * Subscribes to `config:updated` broadcasts and applies them to the config
 * store. The main-process `emitConfig()` already skips the originating
 * window, so this only fires for genuine cross-window edits.
 */
export function useConfigBroadcastSync(): void {
  useEffect(
    () => vs.events.onConfigUpdated((next) => useConfigStore.getState().applyExternal(next)),
    []
  )
}
