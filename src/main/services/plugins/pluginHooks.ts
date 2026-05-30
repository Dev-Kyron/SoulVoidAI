/**
 * v2.0 — plugin JS hook runtime.
 *
 * Pre-2.0 plugins were declarative JSON workflow packs: they could only
 * bundle existing built-in action types and contributed zero new
 * behaviour to the runtime. The audit complaint was real — the plugin
 * ecosystem had no extensibility wedge for anything ambitious.
 *
 * This module adds the smallest meaningful extension: plugins can
 * subscribe to lifecycle hooks (see PluginHookName in shared/types) by
 * declaring a JS function body in their manifest. We compile each body
 * via `new Function('payload', 'context', body)` at plugin load time
 * and dispatch it on the matching event.
 *
 * Trust model — INTENTIONALLY simple and explicit:
 *   - Master toggle: `config.chat.pluginHooks` (off by default).
 *   - Per-plugin: existing `enabled` flag still gates execution.
 *   - Install dialog: shows the hook count + a "this plugin runs
 *     JavaScript" warning, so installation is informed.
 *   - No sandbox: hooks run in the main process with full Node access.
 *     Same trust level as an npm package the user installs by hand.
 *
 * Sandboxing (Web Worker or vm.Script isolation) is on the v2.1
 * roadmap; getting the surface usable first lets us learn what
 * plugins actually want before adding isolation overhead.
 */
import { log } from '../logger'
import { getConfig } from '../storage/config'
import type { PluginHookName } from '@shared/types'

/**
 * The compiled handler shape. Returned from `compileHookBody`. We
 * always wrap user code in a try/catch at dispatch so a thrown error
 * inside a handler logs once and the rest of the chain still runs.
 */
type HookHandler = (payload: unknown, context: HookContext) => unknown

/**
 * Context object exposed to every hook handler. Deliberately tiny —
 * `log` for the Logs tab, `notify` for renderer toasts. Future
 * additions live here. Adding APIs is cheap; removing them later
 * breaks plugins, so keep this minimal.
 */
export interface HookContext {
  /** Write a row to the structured log store (visible in Logs tab). */
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  // notify: deferred to v2.1 — would require a renderer broadcast channel
  // dedicated to plugins. Keep the API surface tight for now.
}

interface RegisteredHandler {
  pluginId: string
  pluginName: string
  hook: PluginHookName
  handler: HookHandler
}

/**
 * In-memory registry of compiled hook handlers. Rebuilt on every
 * plugin reload — no incremental updates because reloads are infrequent
 * (manual user action via Settings → Plugins → Reload) and the rebuild
 * is cheap.
 */
let registry: RegisteredHandler[] = []

/**
 * Compiles a single hook body string into a callable handler. Returns
 * null on compile failure — the validator surfaces that as a plugin
 * load error so the user can see WHICH hook on WHICH plugin failed.
 *
 * We use `new Function(...)` rather than `eval(...)` because Function
 * constructs in the GLOBAL scope (no closure over our private state)
 * and the call signature is explicit (`payload`, `context`).
 */
export function compileHookBody(body: string): HookHandler | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function('payload', 'context', body) as HookHandler
  } catch {
    return null
  }
}

/**
 * Registers the full set of handlers for the current plugin registry.
 * Plugin loader calls this after every `loadPlugins()`. Replaces the
 * previous registry atomically — no half-loaded state visible to a
 * concurrent dispatch.
 */
export function registerPluginHooks(
  plugins: Array<{
    id: string
    name: string
    enabled: boolean
    hooks: Partial<Record<PluginHookName, HookHandler>>
  }>
): void {
  const next: RegisteredHandler[] = []
  for (const p of plugins) {
    if (!p.enabled) continue
    for (const [hook, handler] of Object.entries(p.hooks)) {
      if (!handler) continue
      next.push({
        pluginId: p.id,
        pluginName: p.name,
        hook: hook as PluginHookName,
        handler
      })
    }
  }
  // Skip the log line when the handler count hasn't changed — every
  // setPluginEnabled toggle calls this, and flipping the same plugin
  // off/on used to spam the Logs tab with identical "N handlers
  // registered" rows. Initial load (registry empty → some count) still
  // fires the line so users see the boot-time tally.
  const changed = next.length !== registry.length
  registry = next
  if (changed) {
    const pluginIds = new Set(next.map((h) => h.pluginId))
    log(
      'info',
      'system',
      `Plugin hooks: ${next.length} handler${next.length === 1 ? '' : 's'} registered across ${pluginIds.size} plugin${pluginIds.size === 1 ? '' : 's'}.`
    )
  }
}

/**
 * Dispatches a hook event to every registered handler for that hook,
 * in registration order. Each handler may mutate the payload OR return
 * an object that gets merged into it (so handlers can be functional
 * without forcing mutation as the only style).
 *
 * Returns the (possibly transformed) payload so the caller can pass it
 * on to downstream logic (e.g. the chat model sees the post-hook
 * message content).
 *
 * Master switch + handler errors are both handled here:
 *   - `config.chat.pluginHooks` off → no-op, returns payload as-is.
 *   - A handler throws → log + skip, continue with next handler.
 */
export function dispatchHook<T extends object>(hook: PluginHookName, payload: T): T {
  if (!getConfig().chat.pluginHooks) return payload
  let current = payload
  for (const entry of registry) {
    if (entry.hook !== hook) continue
    const context: HookContext = {
      log: (level, message) => log(level, 'system', `[plugin:${entry.pluginId}] ${message}`)
    }
    try {
      const result = entry.handler(current, context)
      // Promise return: dispatch is SYNC by contract, but `new Function()`
      // will compile an `async (payload) => {...}` body just fine. A
      // returned Promise has no own-enumerable string keys, so the
      // spread below would silently no-op AND a later rejection would
      // surface as `unhandledRejection` on the main process. Catch
      // both: attach a logging .catch so the rejection lands in the
      // Logs tab instead of crashing the process, then skip the merge
      // (we can't await sync). Document the SYNC contract in HookContext.
      if (result instanceof Promise) {
        result.catch((err) => {
          log(
            'warn',
            'system',
            `[plugin:${entry.pluginId}] async hook "${hook}" rejected — hook contract is SYNC, return values from async bodies are dropped`,
            err instanceof Error ? err.message : String(err)
          )
        })
        continue
      }
      // Only merge plain objects. `typeof null === 'object'` is short-
      // circuited by the truthy check; arrays would otherwise pass the
      // typeof test and corrupt the payload with numeric keys + `length`
      // when a plugin author does `return Object.keys(payload)` or
      // similar by accident. Class instances pass too but only their
      // own-enumerable string keys would copy, which is mostly harmless.
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        // Shallow-merge handler-returned fields onto the current payload.
        // Handlers don't have to mutate — returning a partial object is
        // ergonomically nicer and avoids the "did this fire?" guessing
        // game when a mutation silently no-ops.
        current = { ...current, ...(result as Partial<T>) }
      }
    } catch (err) {
      log(
        'warn',
        'system',
        `[plugin:${entry.pluginId}] hook "${hook}" threw — skipping handler`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return current
}

/** Test / diagnostic helper — clears the registry without unloading
 *  plugins. Used by the disposeIpc cleanup on quit so nothing dangles. */
export function clearPluginHooks(): void {
  registry = []
}
