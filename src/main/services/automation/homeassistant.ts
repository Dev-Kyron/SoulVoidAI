/**
 * Home Assistant REST client.
 *
 * Thin wrapper over HA's `/api/*` REST surface
 * (https://developers.home-assistant.io/docs/api/rest/). No external MCP
 * server to install — VoidSoul talks straight to the user's HA instance
 * over HTTP(S), authenticated by a long-lived access token the user
 * generates from their HA Profile → "Long-lived access tokens" section.
 *
 * Why native (not an external MCP server):
 *   - HA's REST API is small and stable; a 200-line client is enough
 *     for full coverage.
 *   - Eliminates the dep on Node/Python/Docker the user would need to
 *     run a community HA MCP server.
 *   - Lets the setup flow validate live (call /api/config during the
 *     wizard) — community servers fail silently for hours before the
 *     user notices.
 *
 * Token storage: the long-lived token lives in the OS keychain under
 * the secret id `home-assistant`. Never embedded in config and never
 * crosses the sync vault.
 *
 * Network safety: we DO NOT route HA requests through the agent's
 * normal SSRF guard (`checkUrlSafe`) because HA addresses are almost
 * always private/loopback/link-local by design — `homeassistant.local`
 * or `192.168.x.y:8123`. Instead we restrict the URL syntactically
 * (http/https only, no auth-in-URL, no fragments) and trust that the
 * user typed a real HA address. Public addresses (Nabu Casa) work too
 * because the syntax check doesn't care about resolution.
 */
import { getConfig } from '../storage/config'
import { getSecret, setSecret } from '../storage/keys'
import { log } from '../logger'

const HA_SECRET_ID = 'home-assistant'

/** Per-request timeout. HA's slowest endpoints (history queries) can
 *  approach a few seconds; 15s is generous for our calls (config /
 *  states / single service invocation). */
const REQUEST_TIMEOUT_MS = 15_000

/* ----------------------------- types ------------------------------ */

export interface HomeAssistantState {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed?: string
  last_updated?: string
}

export interface HomeAssistantConfigInfo {
  location_name: string
  version: string
  components?: string[]
  // HA's /api/config returns lots more (latitude, time zone, etc) but
  // we only surface what the wizard / status panel need.
}

/** Live status used by the renderer's Settings panel + tool gating. */
export interface HomeAssistantStatus {
  configured: boolean
  enabled: boolean
  connected: boolean
  url: string | null
  instanceName: string | null
  version: string | null
  entityCount: number | null
  /** Set when the most recent test/call returned non-2xx or threw — the
   *  Settings panel renders this in a red ribbon so the user can fix it. */
  error: string | null
}

/* ----------------------- url / token helpers ---------------------- */

/** Trim trailing slashes and validate the URL is a plain http(s) base
 *  suitable for joining `/api/...` onto. Throws on anything weird so
 *  the wizard's "Test" button surfaces the error message verbatim. */
export function normaliseHomeAssistantUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('URL is empty.')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain a username or password.')
  }
  if (parsed.hash) {
    throw new Error('URL must not contain a fragment.')
  }
  return trimmed
}

/** Returns the active long-lived token, or null when none stored. */
export function getHomeAssistantToken(): string | null {
  return getSecret(HA_SECRET_ID)
}

export function setHomeAssistantToken(token: string): void {
  setSecret(HA_SECRET_ID, token)
}

export function clearHomeAssistantToken(): void {
  setSecret(HA_SECRET_ID, '')
  // v2.0 polish — reset the cached probe metadata so a future status
  // read doesn't surface stale instanceName / version / entityCount /
  // "connected: true" from the previously-paired HA instance.
  cachedStatus = {
    configured: false,
    enabled: false,
    connected: false,
    url: null,
    instanceName: null,
    version: null,
    entityCount: null,
    error: null
  }
}

/** v2.0 polish — wipe the live-probe cache. Called from the IPC layer
 *  on `configure` (URL changed → old probe metadata is wrong) and on
 *  `disable` (toggled off → "connected: true" is misleading). */
export function resetHomeAssistantStatusCache(): void {
  cachedStatus = {
    configured: cachedStatus.configured,
    enabled: false,
    connected: false,
    url: cachedStatus.url,
    instanceName: null,
    version: null,
    entityCount: null,
    error: null
  }
}

/* ----------------------- request plumbing ------------------------- */

/** Shared fetch wrapper. Adds the Authorization header, sets a default
 *  timeout, and converts non-2xx into an Error so callers always see
 *  failures the same way. */
async function haFetch(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<Response> {
  const cfg = getConfig().homeAssistant
  if (!cfg?.url) throw new Error('Home Assistant URL is not configured.')
  const token = getHomeAssistantToken()
  if (!token) throw new Error('Home Assistant token is not configured.')
  const url = `${cfg.url}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  // Chain the caller's abort so a stop button kills HA fetches too.
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HA HTTP ${response.status}: ${body.slice(0, 200) || response.statusText}`)
    }
    return response
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

/* ----------------------- public client ---------------------------- */

/**
 * GET /api/config — used by the setup wizard's Test button + the
 * Settings panel's status badge. Returns instance metadata (name +
 * version) so the user can confirm they typed the right URL.
 */
export async function getHomeAssistantConfigInfo(
  signal?: AbortSignal
): Promise<HomeAssistantConfigInfo> {
  const response = await haFetch('/api/config', { method: 'GET' }, signal)
  const json = (await response.json()) as Record<string, unknown>
  return {
    location_name: String(json.location_name ?? ''),
    version: String(json.version ?? ''),
    components: Array.isArray(json.components) ? (json.components as string[]) : undefined
  }
}

/**
 * GET /api/states — returns every entity's current state. The agent's
 * `ha_list_entities` tool wraps this with an optional domain filter.
 * Domains are the prefix of the entity_id (`light`, `lock`, `climate`,
 * `switch`, `scene`, `script`, `automation`, `sensor`, etc).
 */
export async function listHomeAssistantStates(
  opts: { domain?: string } = {},
  signal?: AbortSignal
): Promise<HomeAssistantState[]> {
  const response = await haFetch('/api/states', { method: 'GET' }, signal)
  const json = (await response.json()) as HomeAssistantState[]
  if (!Array.isArray(json)) return []
  if (!opts.domain) return json
  const prefix = `${opts.domain}.`
  return json.filter((s) => typeof s.entity_id === 'string' && s.entity_id.startsWith(prefix))
}

/**
 * GET /api/states/<entity_id> — used by `ha_get_state` for a single
 * entity. Faster than fetching everything when the agent already has
 * the id (typical follow-up after `ha_list_entities`).
 */
export async function getHomeAssistantState(
  entityId: string,
  signal?: AbortSignal
): Promise<HomeAssistantState> {
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(entityId)) {
    throw new Error(`Invalid entity_id: ${entityId}`)
  }
  const response = await haFetch(
    `/api/states/${encodeURIComponent(entityId)}`,
    { method: 'GET' },
    signal
  )
  return (await response.json()) as HomeAssistantState
}

/**
 * POST /api/services/<domain>/<service> — the universal write op.
 *
 * Examples:
 *   { domain: 'light', service: 'turn_on', target: { entity_id: 'light.kitchen' } }
 *   { domain: 'lock', service: 'unlock', target: { entity_id: 'lock.front_door' } }
 *   { domain: 'climate', service: 'set_temperature', target: { entity_id: 'climate.living_room' }, data: { temperature: 21 } }
 *   { domain: 'scene', service: 'turn_on', target: { entity_id: 'scene.evening' } }
 *   { domain: 'script', service: 'turn_on', target: { entity_id: 'script.morning_routine' } }
 *
 * Returns the array of changed states HA reports back so the agent
 * can confirm what flipped (e.g. light went from `off` → `on`).
 */
export async function callHomeAssistantService(
  args: {
    domain: string
    service: string
    target?: {
      entity_id?: string | string[]
      device_id?: string | string[]
      area_id?: string | string[]
    }
    data?: Record<string, unknown>
  },
  signal?: AbortSignal
): Promise<HomeAssistantState[]> {
  if (!/^[a-z0-9_]+$/i.test(args.domain)) {
    throw new Error(`Invalid service domain: ${args.domain}`)
  }
  if (!/^[a-z0-9_]+$/i.test(args.service)) {
    throw new Error(`Invalid service name: ${args.service}`)
  }
  const body: Record<string, unknown> = { ...(args.data ?? {}) }
  if (args.target) {
    // HA accepts `target` as a separate object OR flattened — the flat
    // form is the broadly-supported one across HA versions, so we
    // merge it into the body.
    if (args.target.entity_id) body.entity_id = args.target.entity_id
    if (args.target.device_id) body.device_id = args.target.device_id
    if (args.target.area_id) body.area_id = args.target.area_id
  }
  const response = await haFetch(
    `/api/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    signal
  )
  const json = (await response.json()) as HomeAssistantState[]
  return Array.isArray(json) ? json : []
}

/* ----------------------- live status ------------------------------ */

/**
 * Snapshot the renderer's Settings panel + the agent's tool gating
 * both consume. Connection is verified lazily (only when explicitly
 * asked via `refreshHomeAssistantStatus`), since hitting /api/config
 * on every status poll would generate noise in HA's logs.
 */
let cachedStatus: HomeAssistantStatus = {
  configured: false,
  enabled: false,
  connected: false,
  url: null,
  instanceName: null,
  version: null,
  entityCount: null,
  error: null
}

export function getHomeAssistantStatus(): HomeAssistantStatus {
  const cfg = getConfig().homeAssistant
  const tokenPresent = !!getHomeAssistantToken()
  return {
    ...cachedStatus,
    configured: !!cfg?.url && tokenPresent,
    enabled: !!cfg?.enabled,
    url: cfg?.url ?? null
  }
}

/**
 * Force a live probe — used by:
 *   - the setup wizard's "Test connection" button
 *   - the Settings panel's "Refresh" button
 *   - the boot-time warm-up (best-effort, swallows failure so a slow
 *     HA can't delay app start)
 */
export async function refreshHomeAssistantStatus(
  signal?: AbortSignal
): Promise<HomeAssistantStatus> {
  const cfg = getConfig().homeAssistant
  if (!cfg?.url) {
    cachedStatus = { ...cachedStatus, configured: false, connected: false, error: null }
    return getHomeAssistantStatus()
  }
  try {
    const [info, states] = await Promise.all([
      getHomeAssistantConfigInfo(signal),
      listHomeAssistantStates({}, signal)
    ])
    cachedStatus = {
      configured: true,
      enabled: !!cfg.enabled,
      connected: true,
      url: cfg.url,
      instanceName: info.location_name || null,
      version: info.version || null,
      entityCount: states.length,
      error: null
    }
    log(
      'info',
      'system',
      `home_assistant: connected to "${info.location_name || cfg.url}" (HA ${info.version}, ${states.length} entities).`
    )
  } catch (err) {
    cachedStatus = {
      ...cachedStatus,
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  return getHomeAssistantStatus()
}
