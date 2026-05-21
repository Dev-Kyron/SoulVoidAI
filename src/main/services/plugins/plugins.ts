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
