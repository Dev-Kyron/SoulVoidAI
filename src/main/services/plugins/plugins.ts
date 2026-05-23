/**
 * Plugin system. A plugin is a declarative JSON "workflow pack" dropped into
 * the plugins directory. It contributes permission-gated quick actions built
 * from the existing built-in action types — it cannot execute arbitrary code,
 * so installing one carries no more risk than the actions it bundles.
 *
 * Plugins are validated on load; invalid manifests are surfaced (not silently
 * dropped) so authors can fix them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { dataPath, JsonStore } from '../storage/store'
import { log } from '../logger'
import { ACTION_DESCRIPTORS } from '../automation/actions'
import { PERMISSION_IDS } from '@shared/permissions'
import type { PluginInfo, PluginManifest, QuickAction } from '@shared/types'

const VALID_ACTIONS = new Set(ACTION_DESCRIPTORS.map((d) => d.type))
const VALID_PERMISSIONS = new Set<string>(PERMISSION_IDS)

const EXAMPLE_PLUGIN: PluginManifest = {
  id: 'voidsoul-example',
  name: 'Example Pack',
  version: '1.0.0',
  author: 'VoidSoul',
  description: 'A sample plugin. Copy this file and edit it to build your own workflow pack.',
  quickActions: [
    {
      id: 'mdn',
      label: 'Open MDN',
      icon: 'Globe',
      description: 'Open the MDN web docs.',
      requires: 'browser',
      action: { type: 'open-url', params: { url: 'https://developer.mozilla.org' } }
    },
    {
      id: 'downloads',
      label: 'Open Downloads',
      icon: 'Folder',
      description: 'Open the Downloads folder.',
      requires: 'filesystem',
      action: { type: 'open-folder', params: { dir: '~downloads' } }
    }
  ]
}

interface LoadedPlugin {
  info: PluginInfo
  actions: QuickAction[]
}

let registry: LoadedPlugin[] = []
let stateStore: JsonStore<{ disabled: string[] }> | null = null

function state(): JsonStore<{ disabled: string[] }> {
  if (!stateStore) stateStore = new JsonStore('plugins', { disabled: [] })
  return stateStore
}

function pluginsDir(): string {
  const dir = dataPath('plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validates a raw manifest, returning a clean manifest or an error string. */
function validate(raw: unknown): { manifest?: PluginManifest; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Manifest is not a JSON object.' }
  const m = raw as Record<string, unknown>
  if (!isString(m.id)) return { error: 'Manifest is missing a string "id".' }
  if (!isString(m.name)) return { error: 'Manifest is missing a string "name".' }

  const rawActions = Array.isArray(m.quickActions) ? m.quickActions : []
  const quickActions: QuickAction[] = []
  for (const entry of rawActions) {
    if (!entry || typeof entry !== 'object') continue
    const a = entry as Record<string, unknown>
    const action = a.action as Record<string, unknown> | undefined
    if (!isString(a.id) || !isString(a.label)) continue
    if (!action || !isString(action.type) || !VALID_ACTIONS.has(action.type as never)) continue
    const requires =
      a.requires === null || a.requires === undefined
        ? null
        : VALID_PERMISSIONS.has(a.requires as string)
          ? (a.requires as QuickAction['requires'])
          : null
    quickActions.push({
      id: a.id,
      label: a.label,
      icon: isString(a.icon) ? a.icon : 'Sparkles',
      description: isString(a.description) ? a.description : '',
      requires,
      action: {
        type: action.type as QuickAction['action']['type'],
        params: (action.params as Record<string, unknown>) ?? {}
      }
    })
  }

  return {
    manifest: {
      id: m.id,
      name: m.name,
      version: isString(m.version) ? m.version : '1.0.0',
      description: isString(m.description) ? m.description : '',
      author: isString(m.author) ? m.author : undefined,
      quickActions
    }
  }
}

function errorEntry(file: string, error: string): LoadedPlugin {
  return {
    info: {
      id: file,
      name: file,
      version: '',
      description: '',
      author: 'Unknown',
      enabled: false,
      actionCount: 0,
      file,
      error
    },
    actions: []
  }
}

/** Scans the plugins directory and rebuilds the registry. */
export function loadPlugins(): void {
  const dir = pluginsDir()
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))

  // Seed an example plugin the first time the directory is empty.
  if (files.length === 0) {
    writeFileSync(
      join(dir, 'example-pack.json'),
      JSON.stringify(EXAMPLE_PLUGIN, null, 2),
      'utf-8'
    )
    files.push('example-pack.json')
  }

  const disabled = new Set(state().get().disabled)
  registry = []

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
      const { manifest, error } = validate(raw)
      if (error || !manifest) {
        registry.push(errorEntry(file, error ?? 'Invalid manifest.'))
        continue
      }
      registry.push({
        info: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author ?? 'Unknown',
          enabled: !disabled.has(manifest.id),
          actionCount: manifest.quickActions.length,
          file
        },
        actions: manifest.quickActions
      })
    } catch {
      registry.push(errorEntry(file, 'Could not parse JSON.'))
    }
  }

  const ok = registry.filter((p) => !p.info.error).length
  log('info', 'system', `Loaded ${ok} plugin(s) from ${files.length} file(s).`)
}

export function getPlugins(): PluginInfo[] {
  return registry.map((p) => p.info)
}

/** Quick actions contributed by all enabled, valid plugins. */
export function getPluginActions(): QuickAction[] {
  return registry
    .filter((p) => p.info.enabled && !p.info.error)
    .flatMap((p) => p.actions.map((a) => ({ ...a, id: `${p.info.id}:${a.id}` })))
}

export function setPluginEnabled(id: string, enabled: boolean): PluginInfo[] {
  const disabled = new Set(state().get().disabled)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  state().set({ disabled: [...disabled] })
  registry = registry.map((p) =>
    p.info.id === id ? { ...p, info: { ...p.info, enabled } } : p
  )
  return getPlugins()
}

export function reloadPlugins(): PluginInfo[] {
  loadPlugins()
  return getPlugins()
}

export function pluginsDirectory(): string {
  return pluginsDir()
}

/* --------------------- marketplace + install ---------------------------- */

/**
 * Public registry of community plugins. A JSON file in the main project
 * repo so updates flow through normal git pushes — no separate registry
 * repo to maintain. The shape: `{ "plugins": PluginManifest[] }`, with
 * optional non-manifest metadata (`tags`, `category`) that the marketplace
 * UI uses for filtering but the validator ignores.
 *
 * Pointing at `main` rather than a release tag means new entries appear in
 * the marketplace immediately — useful for a beta. Swap to a tagged path
 * (e.g. `/releases/registry-v1.json`) once the format is frozen.
 */
const REGISTRY_URL =
  'https://raw.githubusercontent.com/Dev-Kyron/SoulVoidAI/main/plugins-registry/registry.json'

/** Hard cap on how big the registry response can be — prevents a runaway
 * download from a compromised raw.githubusercontent host. 200 KB is enough
 * for hundreds of plugin entries. */
const MAX_REGISTRY_BYTES = 200_000

export interface RegistryEntry extends PluginManifest {
  /** Optional tags for marketplace filtering. Not part of the manifest. */
  tags?: string[]
}

interface RegistryFile {
  version?: number
  plugins?: RegistryEntry[]
}

/**
 * Path to the registry copy bundled into the app's asar at build time —
 * the same JSON we commit to the repo, served as an offline fallback for
 * the marketplace when the GitHub raw CDN is unreachable (404 before
 * v1.2.0 is published, or any network issue in the field).
 *
 * `app.getAppPath()` resolves to the project root in dev and to
 * `<install>/resources/app.asar/` in production. Electron's fs shim reads
 * inside asar archives transparently, so `readFileSync` works either way.
 */
function bundledRegistryPath(): string {
  return join(app.getAppPath(), 'plugins-registry', 'registry.json')
}

/**
 * Parse a registry JSON blob into validated entries. Pure — used by both
 * the remote fetch and the bundled-fallback paths so they share the same
 * validation + log line.
 */
function parseRegistryText(text: string, source: 'remote' | 'bundled'): RegistryEntry[] {
  if (text.length > MAX_REGISTRY_BYTES) {
    throw new Error('Registry response is unexpectedly large; refusing to parse.')
  }
  let parsed: RegistryFile
  try {
    parsed = JSON.parse(text) as RegistryFile
  } catch {
    throw new Error('Registry is not valid JSON.')
  }
  const entries: RegistryEntry[] = []
  for (const raw of parsed.plugins ?? []) {
    const { manifest } = validate(raw)
    if (manifest) {
      entries.push({
        ...manifest,
        tags: Array.isArray((raw as RegistryEntry).tags)
          ? (raw as RegistryEntry).tags
          : undefined
      })
    }
  }
  log(
    'info',
    'system',
    `Plugin registry (${source}): ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'}.`
  )
  return entries
}

/**
 * Fetch the public plugin registry. Tries the live GitHub raw URL first;
 * on any failure (404 before the file's been pushed, network blip, etc.)
 * falls back to the bundled copy committed to the repo so the browse view
 * always shows something. Throws only if BOTH paths fail.
 *
 * Validation runs in `parseRegistryText` so malformed entries are dropped
 * silently in either path — one bad commit can't crash the browse view.
 */
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  // --- Attempt 1: live registry on GitHub --------------------------------
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json' }
    })
    if (response.ok) {
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength && contentLength > MAX_REGISTRY_BYTES) {
        throw new Error('Registry response is unexpectedly large; refusing to download.')
      }
      return parseRegistryText(await response.text(), 'remote')
    }
    // Specifically distinguish 404 — the file doesn't exist server-side —
    // from generic network issues. The 404 path is the common case before
    // a release ships the new registry; saying "check your internet" then
    // is misleading.
    log(
      'warn',
      'system',
      `Plugin registry remote returned ${response.status}; falling back to bundled copy.`
    )
  } catch (err) {
    log(
      'warn',
      'system',
      `Plugin registry remote unreachable; falling back to bundled copy.`,
      err instanceof Error ? err.message : String(err)
    )
  }

  // --- Attempt 2: bundled copy from the asar -----------------------------
  try {
    return parseRegistryText(readFileSync(bundledRegistryPath(), 'utf-8'), 'bundled')
  } catch (err) {
    throw new Error(
      'Plugin marketplace is offline and no bundled fallback is available. ' +
        (err instanceof Error ? err.message : String(err))
    )
  }
}

/**
 * Validate + write a plugin manifest to disk, then reload the registry so
 * the installed plugin's actions become live without an app restart.
 * Returns the refreshed full plugin list.
 *
 * Sanitises the filename — the manifest's `id` is the on-disk filename, so
 * we strip any path separator or dot-prefix that could escape the plugins
 * directory. An attacker-controlled `id: "../../etc/passwd"` shouldn't
 * land outside `pluginsDir`.
 */
export function installPlugin(raw: unknown): PluginInfo[] {
  const { manifest, error } = validate(raw)
  if (!manifest) throw new Error(error ?? 'Plugin manifest is invalid.')

  // Defence-in-depth: id is user-supplied (from a public registry), so
  // never let it traverse outside the plugins dir. Strip slashes, leading
  // dots, and any character outside the safe filename set.
  const safeId = manifest.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '')
  if (!safeId) throw new Error('Plugin id resolves to an empty filename.')

  const file = join(pluginsDir(), `${safeId}.json`)
  writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf-8')
  loadPlugins()
  log('info', 'system', `Installed plugin "${manifest.id}" as ${safeId}.json.`)
  return getPlugins()
}
