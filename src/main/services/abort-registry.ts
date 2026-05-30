/**
 * Per-request abort registry. One requestId can have multiple in-flight
 * abortables — the LLM call AND every tool call (web_fetch, run_python,
 * generate_image, etc.) the agent loop spawned during that request. When
 * the user clicks Stop, every controller registered against that request
 * gets aborted in one call.
 *
 * Without this, `vs.ai.abort(requestId)` only stopped the LLM stream. The
 * Python subprocess kept running, the web_fetch kept downloading, the
 * Pollinations image-gen kept hitting the network. Bad UX — Stop didn't
 * mean stop.
 *
 * Registry is keyed by requestId. Each entry is a Set so controllers can
 * register/unregister independently as tool calls start and finish.
 */
const registry = new Map<string, Set<AbortController>>()

/**
 * Registers an abort controller against a request. Multiple controllers
 * per request are supported (LLM + N tool calls running in parallel or
 * sequentially). The caller MUST pair this with `unregisterAbortable` in a
 * `finally` block so completed work doesn't leak entries forever.
 */
export function registerAbortable(requestId: string, controller: AbortController): void {
  let set = registry.get(requestId)
  if (!set) {
    set = new Set()
    registry.set(requestId, set)
  }
  set.add(controller)
}

/**
 * Removes a controller from the request's group. Called on completion —
 * success OR failure — so the registry doesn't accumulate dead entries.
 * Last-removal cleans up the parent Map entry.
 */
export function unregisterAbortable(requestId: string, controller: AbortController): void {
  const set = registry.get(requestId)
  if (!set) return
  set.delete(controller)
  if (set.size === 0) registry.delete(requestId)
}

/**
 * Aborts every controller registered against the request and clears the
 * group. Safe to call when nothing is registered (no-op).
 */
export function abortRequest(requestId: string): void {
  const set = registry.get(requestId)
  if (!set) return
  for (const ctrl of set) {
    try {
      ctrl.abort()
    } catch {
      // Already aborted or controller in a weird state — ignore, the
      // important thing is the abort attempt was made.
    }
  }
  registry.delete(requestId)
}

/**
 * Aborts every controller across every request. Used by `disposeIpc` on
 * app quit to make sure no in-flight network call outlives shutdown.
 */
export function abortAll(): void {
  for (const set of registry.values()) {
    for (const ctrl of set) {
      try {
        ctrl.abort()
      } catch {
        /* see abortRequest */
      }
    }
  }
  registry.clear()
}

/** Test-only: snapshot the current registry size, for sanity checks. */
export function __registrySize(): number {
  let total = 0
  for (const set of registry.values()) total += set.size
  return total
}

/**
 * v2.0 — public sibling of `__registrySize()` for production callers
 * that need to know "is anything actively running?" (e.g. the idle
 * VACUUM scheduler). True when at least one AbortController is
 * registered against any request id. False = no in-flight LLM call,
 * tool run, or agent step at this moment.
 */
export function hasInFlightWork(): boolean {
  for (const set of registry.values()) {
    if (set.size > 0) return true
  }
  return false
}
