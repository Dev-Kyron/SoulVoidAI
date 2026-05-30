import clsx, { type ClassValue } from 'clsx'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { AccentColor, WidgetState } from '@shared/types'

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

export function uid(): string {
  return crypto.randomUUID()
}

/**
 * Single-occupant lock for module-level concurrency guards (e.g. "only one
 * extraction in flight"). `tryAcquire` returns false when busy; pair every
 * `tryAcquire(true)` with a `release` in a `finally`.
 */
export interface SingleLock {
  tryAcquire(): boolean
  release(): void
  readonly isLocked: boolean
}

export function createLock(): SingleLock {
  let locked = false
  return {
    tryAcquire(): boolean {
      if (locked) return false
      locked = true
      return true
    },
    release(): void {
      locked = false
    },
    get isLocked(): boolean {
      return locked
    }
  }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Strips the directory portion of a path, accepting either Windows or POSIX
 * separators. Renderer-safe replacement for Node's `path.basename`.
 */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

/**
 * Defence-in-depth URL protocol guard for any external link rendered from
 * community-submitted registry data (plugin or MCP). The PR validators
 * enforce http(s) at submission time, but a stale bundled fallback or a
 * CDN cache could surface an older entry — belt-and-braces is cheap and
 * blocks `javascript:` / `data:` / `file:` / `vbscript:` URLs that
 * would otherwise execute attacker-controlled code in the renderer if
 * `window.open` raced ahead of `setWindowOpenHandler` (Electron does
 * intercept those, but we don't want to depend on the host's
 * interception for safety).
 *
 * Centralised here so a future protocol-allowlist tweak (e.g. add
 * `mailto:`) lands in one place. Returns false on parse failure so a
 * malformed URL silently disappears from the UI rather than rendering
 * a tempting button that does nothing.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * `React.lazy` adapter for modules that export a named component instead of
 * a default — saves the `.then(m => ({ default: m.X }))` ceremony at every
 * lazy boundary.
 */
export function lazyNamed<P>(
  loader: () => Promise<Record<string, ComponentType<P>>>,
  name: string
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => loader().then((module) => ({ default: module[name] })))
}

/** Compact relative-time label — "today", "5d ago", "3w ago", "Jan 14". */
export function relativeTime(iso: string): string {
  const date = new Date(iso)
  const ms = Date.now() - date.getTime()
  const day = 24 * 60 * 60 * 1000
  if (ms < day) return 'today'
  const days = Math.floor(ms / day)
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export interface AccentTheme {
  hex: string
  glow: string
  soft: string
  ring: string
}

export const ACCENTS: Record<AccentColor, AccentTheme> = {
  violet: {
    hex: '#7c3aed',
    glow: 'rgba(124, 58, 237, 0.55)',
    soft: 'rgba(124, 58, 237, 0.16)',
    ring: 'rgba(124, 58, 237, 0.45)'
  },
  cyan: {
    hex: '#22d3ee',
    glow: 'rgba(34, 211, 238, 0.55)',
    soft: 'rgba(34, 211, 238, 0.16)',
    ring: 'rgba(34, 211, 238, 0.45)'
  },
  magenta: {
    hex: '#d946ef',
    glow: 'rgba(217, 70, 239, 0.55)',
    soft: 'rgba(217, 70, 239, 0.16)',
    ring: 'rgba(217, 70, 239, 0.45)'
  },
  green: {
    hex: '#34d399',
    glow: 'rgba(52, 211, 153, 0.55)',
    soft: 'rgba(52, 211, 153, 0.16)',
    ring: 'rgba(52, 211, 153, 0.45)'
  },
  amber: {
    hex: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.55)',
    soft: 'rgba(245, 158, 11, 0.16)',
    ring: 'rgba(245, 158, 11, 0.45)'
  },
  rose: {
    hex: '#fb7185',
    glow: 'rgba(251, 113, 133, 0.55)',
    soft: 'rgba(251, 113, 133, 0.16)',
    ring: 'rgba(251, 113, 133, 0.45)'
  },
  blue: {
    hex: '#3b82f6',
    glow: 'rgba(59, 130, 246, 0.55)',
    soft: 'rgba(59, 130, 246, 0.16)',
    ring: 'rgba(59, 130, 246, 0.45)'
  },
  teal: {
    hex: '#14b8a6',
    glow: 'rgba(20, 184, 166, 0.55)',
    soft: 'rgba(20, 184, 166, 0.16)',
    ring: 'rgba(20, 184, 166, 0.45)'
  }
}

/** Colour an orb / status indicator should use for a given widget state. */
export const STATE_COLOR: Record<WidgetState, string> = {
  idle: '#7c3aed',
  // Softer cyan than active listening — same hue family, lower saturation —
  // so the user instantly reads "ready and waiting" not "I'm capturing now".
  'wake-listening': '#67e8f9',
  listening: '#22d3ee',
  processing: '#a855f7',
  success: '#34d399',
  error: '#fb7185'
}

export const STATE_LABEL: Record<WidgetState, string> = {
  idle: 'Ready',
  'wake-listening': 'Listening for wake word',
  listening: 'Listening',
  processing: 'Thinking',
  success: 'Done',
  error: 'Error'
}
