/**
 * Backup & sync. Bundles configuration, memory and plugins into one portable
 * JSON document. There is no VoidSoul cloud — instead the bundle can be
 * exported to a file, or written to a "sync folder". Point that folder at a
 * Dropbox / OneDrive / Drive directory and it becomes de-facto cloud sync,
 * using the user's own cloud.
 *
 * API keys are never included — they are encrypted to the local OS keychain
 * and cannot be meaningfully moved between machines; the user re-enters them.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, updateConfig, type AppConfigFile } from './config'
import { getMemory, replaceMemory } from './memory'
import { getHistory, replaceHistory } from './history'
import { reloadPlugins, pluginsDirectory } from '../plugins/plugins'
import { getEntries as getUsageEntries, getBudget as getUsageBudget, replaceUsage } from '../usage/store'
import { listFolders as listIndexedFolders, restoreFolders } from '../files-rag/manager'
import { listTasks as listScheduledTasks, replaceTasks as replaceScheduledTasks } from '../scheduler'
import { getServers as getMcpServers, setServers as setMcpServers } from '../mcp/store'
import { log } from '../logger'
import type {
  ChatMessage,
  ChatThread,
  HistorySummary,
  McpServerConfig,
  MemoryState,
  PluginManifest,
  ScheduledTask,
  SyncResult,
  UsageBudget,
  UsageEntry
} from '@shared/types'

const SYNC_FILE = 'voidsoul-sync.json'

interface SyncBundle {
  app: 'voidsoul'
  version: number
  exportedAt: string
  config: AppConfigFile
  memory: MemoryState
  plugins: PluginManifest[]
  /**
   * v4+: full threaded chat history.
   * v2/v3 legacy fallback: a flat message log + optional summary, migrated to
   * a single thread on import.
   */
  history?: ChatThread[] | ChatMessage[]
  activeThreadId?: string | null
  historySummary?: HistorySummary | null
  /** v5+: cost tracking — entries + monthly budget state. */
  usage?: { entries: UsageEntry[]; budget: UsageBudget | null }
  /**
   * v5+: indexed-folder paths for file RAG. Embeddings themselves aren't
   * bundled (they'd balloon the JSON); the user rescans after import.
   */
  filesRagFolders?: string[]
  /**
   * v6+: scheduled prompts. `next_run` is recomputed on import so a stale
   * "should fire 3 hours ago" timestamp from the source machine doesn't
   * stampede.
   */
  scheduledTasks?: ScheduledTask[]
  /**
   * v6+: MCP server connection configs. Restored verbatim — the user still
   * needs the command (e.g. `npx`-able package) installed on the target
   * machine for the connection to come up.
   */
  mcpServers?: McpServerConfig[]
}

function buildBundle(): SyncBundle {
  const plugins: PluginManifest[] = []
  try {
    const dir = pluginsDirectory()
    for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))) {
      try {
        plugins.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')))
      } catch {
        // Skip unreadable plugin files.
      }
    }
  } catch (err) {
    log(
      'warn',
      'system',
      'Plugins directory unreadable during export',
      err instanceof Error ? err.message : String(err)
    )
  }
  const history = getHistory()
  return {
    app: 'voidsoul',
    version: 6,
    exportedAt: new Date().toISOString(),
    config: getConfig(),
    memory: getMemory(),
    plugins,
    history: history.threads,
    activeThreadId: history.activeThreadId,
    usage: {
      entries: getUsageEntries(),
      budget: getUsageBudget()
    },
    filesRagFolders: listIndexedFolders().map((f) => f.path),
    scheduledTasks: listScheduledTasks(),
    mcpServers: getMcpServers()
  }
}

function applyBundle(raw: unknown): SyncResult {
  if (!raw || typeof raw !== 'object' || (raw as SyncBundle).app !== 'voidsoul') {
    return { ok: false, message: 'This is not a VoidSoul backup file.' }
  }
  const bundle = raw as SyncBundle

  // Apply config, but keep this machine's own sync folder.
  if (bundle.config) {
    updateConfig({ ...bundle.config, syncFolder: getConfig().syncFolder })
  }
  if (bundle.memory) replaceMemory(bundle.memory)
  if (Array.isArray(bundle.history)) {
    const first = bundle.history[0]
    if (first && typeof first === 'object' && 'messages' in first) {
      // v4+ threaded bundle.
      replaceHistory({
        threads: bundle.history as ChatThread[],
        activeThreadId: bundle.activeThreadId ?? null
      })
    } else {
      // Legacy v2/v3 flat message log — migrate into a single thread.
      replaceHistory({
        messages: bundle.history as ChatMessage[],
        summary: bundle.historySummary ?? null
      })
    }
  }

  if (Array.isArray(bundle.plugins)) {
    for (const manifest of bundle.plugins) {
      if (manifest && typeof manifest.id === 'string') {
        try {
          writeFileSync(
            join(pluginsDirectory(), `${manifest.id}.json`),
            JSON.stringify(manifest, null, 2),
            'utf-8'
          )
        } catch {
          // Skip plugins that fail to write.
        }
      }
    }
    reloadPlugins()
  }

  // v5+: cost tracking. Older bundles silently skip this branch.
  if (bundle.usage && Array.isArray(bundle.usage.entries)) {
    replaceUsage(bundle.usage.entries, bundle.usage.budget ?? null)
  }

  // v5+: file-RAG folder list. Embeddings rebuild on next scan — the import
  // returns folders as "never scanned" so the user knows to rescan.
  if (Array.isArray(bundle.filesRagFolders)) {
    const paths = bundle.filesRagFolders.filter((p): p is string => typeof p === 'string')
    if (paths.length > 0) restoreFolders(paths)
  }

  // v6+: scheduled prompts.
  if (Array.isArray(bundle.scheduledTasks)) {
    replaceScheduledTasks(bundle.scheduledTasks)
  }

  // v6+: MCP servers. Restored as-is; user may need to install the
  // referenced command on this machine for connections to actually come up.
  if (Array.isArray(bundle.mcpServers)) {
    setMcpServers(bundle.mcpServers)
  }

  log('success', 'system', 'Imported a VoidSoul backup.')
  const filesRagNote =
    bundle.filesRagFolders && bundle.filesRagFolders.length > 0
      ? ' Re-scan indexed folders to rebuild file embeddings.'
      : ''
  return {
    ok: true,
    message:
      'Backup imported — config, memory, plugins, chat history, usage, folders, scheduled tasks and MCP servers restored.' +
      filesRagNote
  }
}

export function exportToFile(path: string): SyncResult {
  try {
    writeFileSync(path, JSON.stringify(buildBundle(), null, 2), 'utf-8')
    log('success', 'system', `Exported backup to ${path}.`)
    return { ok: true, message: 'Backup exported.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Export failed.' }
  }
}

export function importFromFile(path: string): SyncResult {
  try {
    return applyBundle(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not read the file.' }
  }
}

export function syncPush(): SyncResult {
  const folder = getConfig().syncFolder.trim()
  if (!folder) return { ok: false, message: 'No sync folder is set.' }
  if (!existsSync(folder)) return { ok: false, message: 'The sync folder no longer exists.' }
  return exportToFile(join(folder, SYNC_FILE))
}

export function syncPull(): SyncResult {
  const folder = getConfig().syncFolder.trim()
  if (!folder) return { ok: false, message: 'No sync folder is set.' }
  const file = join(folder, SYNC_FILE)
  if (!existsSync(file)) return { ok: false, message: 'No sync file found in that folder yet.' }
  return importFromFile(file)
}
