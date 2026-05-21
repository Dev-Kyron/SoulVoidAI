/**
 * Minimal in-house i18n. Reasons we don't pull in `react-i18next` /
 * `formatjs` etc.:
 *
 *  - The library footprints (200 KB+) would be larger than the strings we
 *    have to localise across the app.
 *  - We don't need pluralisation rules, ICU MessageFormat, or AST parsing.
 *  - The component tree is small enough that re-rendering the whole app
 *    when the locale flips is cheap.
 *
 * Strings live in a flat namespaced map per language (`en`, `es`, `de`,
 * `ja`). `t(key, params?)` returns the active-locale string, falling back
 * to English when a key is missing in the active locale. Simple `{name}`
 * substitution is supported for dynamic values.
 *
 * The active locale is read from `appearance.locale` in the config store
 * (set in AppearanceSettings). `'system'` resolves via `navigator.language`.
 */
import { useSyncExternalStore } from 'react'
import { useConfigStore } from '../store/useConfigStore'
import type { LocaleCode } from '@shared/types'

import en from '../locales/en'
import es from '../locales/es'
import de from '../locales/de'
import ja from '../locales/ja'

type Catalog = Record<string, string>

const CATALOGS: Record<Exclude<LocaleCode, 'system'>, Catalog> = { en, es, de, ja }

/**
 * Maps the OS / browser `navigator.language` (e.g. `"es-ES"`, `"en-US"`)
 * down to one of our supported short codes. Unknown locales fall back to
 * English so we never render a raw key.
 */
function resolveLocale(locale: LocaleCode): Exclude<LocaleCode, 'system'> {
  if (locale !== 'system') return locale
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase()
  if (sys === 'es' || sys === 'de' || sys === 'ja') return sys
  return 'en'
}

let activeLocale: Exclude<LocaleCode, 'system'> = 'en'
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const l of listeners) l()
}

/**
 * Watches the config store for `appearance.locale` changes and re-publishes
 * the resolved locale to subscribers. The handle is kept so HMR can drop
 * the subscriber on hot reload — without this, every save would stack
 * another dangling subscription against a fresh store on the next reload.
 */
const unsubscribeConfig = useConfigStore.subscribe((state, prev) => {
  if (state.config?.appearance.locale === prev.config?.appearance.locale) return
  const next = resolveLocale(state.config?.appearance.locale ?? 'system')
  if (next === activeLocale) return
  activeLocale = next
  notifyListeners()
})

// Vite HMR — drop the subscriber when the module is replaced so it doesn't
// pile up across edits. Guarded so production builds (no `import.meta.hot`)
// stay clean of the dev-only call. Cast inline so we don't have to drag
// `vite/client` types into the renderer's tsconfig.
const hot = (import.meta as ImportMeta & {
  hot?: { dispose: (cb: () => void) => void }
}).hot
if (hot) {
  hot.dispose(() => {
    unsubscribeConfig()
    listeners.clear()
  })
}

// Seed from the first config load. If the store hasn't loaded yet, this stays
// at 'en' — the broadcast above will fire as soon as load() resolves.
const initial = useConfigStore.getState().config?.appearance.locale ?? 'system'
activeLocale = resolveLocale(initial)

/**
 * Look up a translation key in the active locale. Falls back to English
 * when missing, then to the key itself so a typo surfaces immediately
 * instead of rendering empty UI.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = CATALOGS[activeLocale]?.[key] ?? CATALOGS.en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

/**
 * Hook variant — re-renders the calling component when the locale flips.
 * Use this inside components that need to react to a live locale switch
 * without remounting. (Most code can use the bare `t()` since switching
 * locales typically remounts the tree via config-broadcast anyway.)
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => activeLocale,
    () => activeLocale
  )
  return t
}

/** The resolved short locale code (`'en' | 'es' | 'de' | 'ja'`). */
export function currentLocale(): Exclude<LocaleCode, 'system'> {
  return activeLocale
}
