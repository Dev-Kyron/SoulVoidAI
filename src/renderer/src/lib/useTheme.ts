/**
 * Applies the active theme (dark / light / system) to `<html>` via a
 * `data-theme` attribute that the CSS variables in `index.css` key off.
 *
 * `system` resolves through `prefers-color-scheme` so the app follows the OS.
 * The media-query listener stays subscribed only while `system` is active so
 * a user who picked an explicit theme never gets re-painted by an OS flip.
 */
import { useEffect } from 'react'
import { useConfigStore } from '../store/useConfigStore'
import type { ThemeMode } from '@shared/types'

function resolveSystemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(theme: ThemeMode): void {
  const resolved = theme === 'system' ? resolveSystemTheme() : theme
  document.documentElement.dataset.theme = resolved
}

export function useTheme(): void {
  const theme = useConfigStore((s) => s.config?.appearance.theme ?? 'dark')

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    // Follow OS flips only while the user has picked "system".
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}
