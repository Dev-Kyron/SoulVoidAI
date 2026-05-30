/**
 * IPC surface. Every privileged capability the renderer can reach is
 * registered here as a single, typed `ipcMain.handle` channel. The renderer
 * never touches Node, the filesystem or the network directly — it goes
 * through these handlers, which enforce permissions and write the audit log.
 */
import { ipcMain, dialog, app, shell, clipboard, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  CODE_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  PLAIN_TEXT_EXTENSIONS
} from '../services/files-rag/extensions'
import { extractPdfTextSafe, extractDocxText } from '../services/parsers'
import {
  getClientConfig,
  getConfig,
  updateConfig,
  setProvider,
  setAppearance,
  setVoice,
  upsertCustomPersona,
  removeCustomPersona
} from '../services/storage/config'
import { isPersonaBundle } from '@shared/personas'
import type { PersonaBundle, PersonaTemplate } from '@shared/personas'
import { getSystemStats } from '../services/system/stats'
import { setApiKey, setSecret, hasSecret, getSecret } from '../services/storage/keys'
import { saveToFile, uploadGist } from '../services/share'
import {
  clearUsage,
  getBudgetState,
  getProviderPerformance,
  getSummary as getUsageSummary,
  updateBudget
} from '../services/usage'
import { runCompletion, invokeCompletion, listModels } from '../services/ai'
import {
  startExtensionBridge,
  stopExtensionBridge,
  extensionBridgeStatus
} from '../services/extension-bridge/server'
import { transcribeAudio } from '../services/ai/transcribe'
import { exportToFile, importFromFile, syncPush, syncPull } from '../services/storage/sync'
import * as syncEngine from '../services/sync/engine'
import {
  abortBench as clickBenchAbort,
  captureScreenshot as clickBenchCaptureScreenshot,
  listBenchmarks as clickBenchList,
  runBench as clickBenchRun,
  saveBenchmark as clickBenchSave
} from '../services/automation/clickBench'
import type { Benchmark as ClickBenchmark } from '../services/automation/clickBench/types'
import {
  listTaughtClicks as taughtClicksList,
  removeTaughtClick as taughtClicksRemove,
  saveTaughtClick as taughtClicksSave
} from '../services/automation/taughtClicks'
import {
  cancelCapture as taughtClicksCancel,
  captureHotkey as taughtClicksHotkey,
  startCapture as taughtClicksStartCapture
} from '../services/automation/taughtClicksCapture'
import {
  clearHomeAssistantToken as haClearToken,
  getHomeAssistantStatus as haGetStatus,
  normaliseHomeAssistantUrl as haNormaliseUrl,
  refreshHomeAssistantStatus as haRefreshStatus,
  resetHomeAssistantStatusCache as haResetStatusCache,
  setHomeAssistantToken as haSetToken
} from '../services/automation/homeassistant'
import {
  exportThread,
  promptSaveAndWrite,
  type ThreadExportFormat
} from '../services/export/thread'
import {
  createCheckpoint as createAgentCheckpoint,
  updateCheckpoint as updateAgentCheckpoint,
  finalizeCheckpoint as finalizeAgentCheckpoint,
  listStaleRunning as listStaleAgentCheckpoints,
  getCheckpoint as getAgentCheckpoint,
  deleteCheckpoint as deleteAgentCheckpoint
} from '../services/storage/agent-checkpoints'
import { getPermissions, revokeAll, setPermission } from '../services/permissions/permissions'
import { executeAction, undoAction, ACTION_DESCRIPTORS } from '../services/automation/actions'
import {
  abortAll,
  abortRequest,
  registerAbortable,
  unregisterAbortable
} from '../services/abort-registry'
import {
  getPlugins,
  setPluginEnabled,
  reloadPlugins,
  getPluginActions,
  pluginsDirectory,
  installPlugin,
  fetchRegistry
} from '../services/plugins/plugins'
import { clearPluginHooks, dispatchHook } from '../services/plugins/pluginHooks'
import { stopVacuumSchedule } from '../services/storage/vacuum'
import {
  disposeAll as disposePythonAll,
  disposeForThread as disposePythonForThread,
  listActiveKernels as listPythonKernels,
  restartForThread as restartPythonForThread
} from '../services/python-sandbox/manager'
// v2.0 round-5 cleanup — captureScreen / extractText / getActiveWindow IPC
// handlers were dead-code-deleted; the imports went with them. Internal
// callers (semanticAwareness, visualClick, etc.) import these helpers
// directly from their source modules.
import { setScreenAwareness, setSemanticScreenAwareness } from '../services/screen/awareness'
import {
  getMemory,
  rememberProject,
  forgetProject,
  addFavoriteApp,
  removeFavoriteApp,
  importFavoriteApps,
  addCustomPrompt,
  removeCustomPrompt,
  addCustomAction,
  removeCustomAction,
  addFact,
  updateFact,
  removeFact,
  clearFacts,
  setFactModes,
  mergeBiographical,
  removeBiographical,
  clearBiographical
} from '../services/storage/memory'
import {
  onUserMessage as sentimentOnUserMessage,
  getEmotionalContext,
  buildSentimentPromptBlock
  // v2.0 round-5 — getRecentSentimentHistory no longer imported; the
  // dead `memory:recent-sentiments` handler was its only call site.
} from '../services/memory/sentimentScheduler'
import { forgetRecentSentiment } from '../services/memory/sentimentStore'
import { resetSentimentCache } from '../services/memory/sentiment'
import {
  getHistory,
  getHistorySummaries,
  getThreadMessages,
  searchMessages,
  saveThread,
  createThread,
  renameThread,
  deleteThread,
  setActiveThread,
  setThreadPinned,
  setThreadMode,
  setThreadSystemPrompt,
  summaryFor,
  clearThread,
  clearAllThreads
} from '../services/storage/history'
import {
  createProject,
  deleteProject,
  listProjects,
  setThreadProject,
  updateProject
} from '../services/storage/projects'
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  renameNotebook,
  saveNotebook
} from '../services/notebook/store'
import {
  runAll as runAllNotebookCells,
  runCell as runNotebookCell
} from '../services/notebook/runner'
import {
  backfillFromThreads,
  clearEmbeddings as clearRagIndex,
  clearQueryTrace,
  explainQuery as ragExplainQuery,
  getQueryTrace,
  getStatus as getRagStatus,
  listVectorStoreChunks,
  listVectorStoreFiles,
  preferredModel as currentEmbeddingModel,
  removeByIds as ragRemoveByIds,
  removeNonCurrentModel,
  searchSimilar as searchRag,
  vectorStoreStats
} from '../services/embeddings'
import {
  addFolder as filesRagAddFolder,
  // v2.0 round-5 — getActiveScan removed (dead `files-rag:scan-status`
  // polling handler was its only call site; renderer now subscribes to
  // the push-based `files-rag:progress` event).
  listFiles as filesRagListFiles,
  listFolders as filesRagListFolders,
  removeFolder as filesRagRemoveFolder,
  rescanAll as rescanAllFolders,
  scanFolder,
  stopScan as filesRagStopScan
} from '../services/files-rag/manager'
import { broadcast, resolvePendingFlush } from '../events'
import {
  addServer as mcpAddServer,
  callTool as mcpCallTool,
  getServerConfig as mcpGetServerConfig,
  listServers as mcpListServers,
  reconnectServer as mcpReconnectServer,
  removeServer as mcpRemoveServer,
  setServerEnabled as mcpSetServerEnabled,
  updateServer as mcpUpdateServer
} from '../services/mcp/manager'
import { runSetupDetection } from '../services/setup/detect'
import {
  importClaudeDesktopServers,
  importCursorServers,
  importEnvKey
} from '../services/setup/import'
import { fetchMcpRegistry, installRegistryServer } from '../services/setup/mcp-marketplace'
import type { McpInstallValues, McpRegistryEntry } from '@shared/types'
import {
  getVoiceSetupStatus,
  migrateLegacyVoices,
  synthesise as piperSynthesise,
  voicesDirectoryPath,
  type VoicePersona
} from '../services/voice/piper'
import {
  addTask as schedAddTask,
  listTasks as schedListTasks,
  removeTask as schedRemoveTask,
  runNow as schedRunNow,
  setEnabled as schedSetEnabled,
  type ScheduledTaskInput
} from '../services/scheduler'
import { importTaskbarApps } from '../services/system/taskbar'
import { runSmokeTest } from '../services/system/smokeTest'
import { getLogs, clearLogs, log } from '../services/logger'
import { dataPath, ensureDataPath } from '../services/storage/store'
import {
  getWindow,
  setExpanded,
  setAlwaysOnTop,
  hideWindow,
  showWindow,
  moveBy,
  applyPanelStyle,
  openSettingsWindow,
  closeSettingsWindow
} from '../window'
import { bumpAgentProgressPolling, refreshTray } from '../tray'
import { checkForUpdates, getUpdaterStatus, quitAndInstall } from '../services/updater'
import type {
  ActionRequest,
  AgentCheckpointCreate,
  AgentCheckpointStatus,
  AgentCheckpointUpdate,
  AgentRequest,
  AgentResult,
  AppearanceConfig,
  BiographicalCategory,
  ChatMessage,
  ChatRequest,
  ChatTurn,
  HistorySummary,
  McpServerInput,
  ChatStreamChunk,
  ChatStreamDone,
  CustomActionKind,
  ModeId,
  ProviderId,
  VoiceConfig
} from '@shared/types'
import type { PermissionId } from '@shared/permissions'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

/**
 * Picker filter shape — built once at module load so each pick-file call
 * doesn't repeat the same five `.map((e) => e.slice(1))` passes. Stripping
 * the leading dot is what `dialog.showOpenDialog` expects.
 */
const PICKER_DOC_EXTS = [...PLAIN_TEXT_EXTENSIONS, ...CODE_EXTENSIONS, ...DOCUMENT_EXTENSIONS].map(
  (e) => e.slice(1)
)
const PICKER_IMAGE_EXTS = IMAGE_EXTENSIONS.map((e) => e.slice(1))
const PICKER_FILTERS_ALL = [
  { name: 'All supported', extensions: [...PICKER_DOC_EXTS, ...PICKER_IMAGE_EXTS] },
  {
    name: 'Documents',
    extensions: [...DOCUMENT_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS].map((e) => e.slice(1))
  },
  { name: 'Code', extensions: [...CODE_EXTENSIONS].map((e) => e.slice(1)) },
  { name: 'Images', extensions: PICKER_IMAGE_EXTS },
  { name: 'All files', extensions: ['*'] }
]
const PICKER_FILTERS_IMAGES_ONLY = [{ name: 'Images', extensions: PICKER_IMAGE_EXTS }]

/**
 * PDFs above this raw byte size skip the inline-preview dataUrl — beyond this
 * point the base64 payload (~33% bigger than the source) starts noticeably
 * inflating the SQLite history file and slowing thread switches. Text still
 * extracts so the model side keeps working; only the preview is dropped.
 */
const PDF_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

// In-flight controllers now live in `services/abort-registry.ts` — keyed
// by requestId, with multiple controllers per request so the agent's LLM
// call and its in-flight tool calls all stop together when the user hits Stop.

/** Applies appearance settings that have main-process side effects. */
export function applyAppearance(appearance: AppearanceConfig): void {
  setAlwaysOnTop(appearance.alwaysOnTop)
  app.setLoginItemSettings({ openAtLogin: appearance.launchOnStartup })
  setScreenAwareness(appearance.screenAwareness)
  // v2.0 — semantic awareness rides on top of the coarse loop. Call
  // AFTER setScreenAwareness so the dependency is satisfied (semantic
  // refuses to enable when coarse is off).
  setSemanticScreenAwareness(appearance.semanticScreenAwareness ?? false)
  refreshTray()
}

/**
 * Helper: return the freshly-built ClientConfig AND broadcast it to every
 * OTHER open renderer so the other window (settings ↔ panel) stays in
 * lockstep. The originating sender is skipped because it'll apply the
 * returned value directly — broadcasting back would double-render every
 * config subscriber in that window. Also refreshes the tray, since the menu
 * displays mode + DND + always-on-top state.
 */
function emitConfig(originatingSenderId?: number): ReturnType<typeof getClientConfig> {
  const cfg = getClientConfig()
  broadcast('config:updated', cfg, originatingSenderId)
  refreshTray()
  return cfg
}

export function registerIpc(): void {
  /* --------------------------- configuration --------------------------- */

  ipcMain.handle('config:get', () => getClientConfig())

  ipcMain.handle('config:set-active-provider', (e, provider: ProviderId) => {
    updateConfig({ activeProvider: provider })
    return emitConfig(e.sender.id)
  })

  ipcMain.handle(
    'config:set-provider',
    (e, provider: ProviderId, patch: { model?: string; baseUrl?: string }) => {
      setProvider(provider, patch)
      return emitConfig(e.sender.id)
    }
  )

  ipcMain.handle('config:set-active-mode', (e, mode: ModeId) => {
    updateConfig({ activeMode: mode })
    return emitConfig(e.sender.id)
  })

  /* --------------------- persona templates (v2.0) -------------------- */
  // Add/replace by id (upsert). Used by the import flow + (future) the
  // in-app "Save As Persona" path.
  ipcMain.handle('personas:upsert', (e, persona: PersonaTemplate) => {
    upsertCustomPersona(persona)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('personas:remove', (e, id: string) => {
    removeCustomPersona(id)
    return emitConfig(e.sender.id)
  })
  // Native save dialog for export. The renderer hands us a bundle + a
  // default filename; we show the OS dialog so the user picks where to
  // drop the .voidsoul-persona.json. Returns the saved path or null on
  // cancel.
  ipcMain.handle(
    'personas:export-to-file',
    async (e, bundle: PersonaBundle, defaultFilename: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
        title: 'Export persona',
        defaultPath: defaultFilename,
        // Electron's filter spec wants bare extensions (no leading dot,
        // no compound segments). The `.voidsoul-persona.json` suffix
        // lives in the default filename above; the filter just narrows
        // to *.json files in the picker.
        filters: [{ name: 'VoidSoul persona (.json)', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false as const }
      await writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
      return { ok: true as const, path: result.filePath }
    }
  )
  // Native open dialog for import. Returns the parsed bundle (validated
  // by `isPersonaBundle`); the renderer decides whether to upsert or
  // bail (e.g. a duplicate-name prompt).
  ipcMain.handle('personas:import-from-file', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Import persona',
      properties: ['openFile'],
      // Bare 'json' filter — matches `.voidsoul-persona.json` files
      // (Electron treats compound `.voidsoul-persona.json` as a
      // single non-standard extension and the filter silently no-ops).
      filters: [{ name: 'VoidSoul persona (.json)', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, reason: 'cancelled' as const }
    }
    const path = result.filePaths[0]
    try {
      const text = await readFile(path, 'utf-8')
      const parsed = JSON.parse(text) as unknown
      if (!isPersonaBundle(parsed)) {
        return {
          ok: false as const,
          reason: 'invalid' as const,
          message: 'File is not a valid VoidSoul persona bundle.'
        }
      }
      return { ok: true as const, bundle: parsed, sourcePath: path }
    } catch (err) {
      return {
        ok: false as const,
        reason: 'invalid' as const,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('config:set-system-prompt', (e, prompt: string) => {
    updateConfig({ systemPrompt: prompt })
    return emitConfig(e.sender.id)
  })

  ipcMain.handle('config:set-appearance', (e, patch: Partial<AppearanceConfig>) => {
    const styleBefore = getConfig().appearance.nexusStyle
    setAppearance(patch)
    applyAppearance(getConfig().appearance)
    // Switching the Nexus layout re-fits the panel to that style's size.
    if (patch.nexusStyle !== undefined && patch.nexusStyle !== styleBefore) {
      applyPanelStyle()
    }
    return emitConfig(e.sender.id)
  })

  ipcMain.handle('config:set-voice', (e, patch: Partial<VoiceConfig>) => {
    setVoice(patch)
    return emitConfig(e.sender.id)
  })

  // The four chat-behaviour toggles all share one shape — one handler keyed
  // by the flag name beats four near-duplicate handlers.
  type ChatFlag = keyof import('@shared/types').ChatBehaviourConfig
  const setChatFlag = (key: ChatFlag, enabled: boolean): void => {
    updateConfig({ chat: { ...getConfig().chat, [key]: enabled } })
  }
  ipcMain.handle('config:set-agent-mode', (e, enabled: boolean) => {
    setChatFlag('agent', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-auto-memory', (e, enabled: boolean) => {
    setChatFlag('autoMemory', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-private-chat', (e, enabled: boolean) => {
    setChatFlag('private', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-rag-enabled', (e, enabled: boolean) => {
    setChatFlag('rag', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-auto-route', (e, enabled: boolean) => {
    setChatFlag('autoRoute', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-plugin-hooks', (e, enabled: boolean) => {
    setChatFlag('pluginHooks', enabled)
    return emitConfig(e.sender.id)
  })
  ipcMain.handle('config:set-memory', (e, patch: Partial<import('@shared/types').MemoryConfig>) => {
    updateConfig({ memory: { ...getConfig().memory, ...patch } })
    return emitConfig(e.sender.id)
  })
  ipcMain.handle(
    'config:set-proactive-voice',
    (e, patch: Partial<import('@shared/types').ProactiveVoiceConfig>) => {
      updateConfig({
        proactiveVoice: { ...getConfig().proactiveVoice, ...patch }
      })
      return emitConfig(e.sender.id)
    }
  )
  ipcMain.handle(
    'config:set-screen-watch',
    async (e, patch: Partial<import('@shared/types').ScreenWatchConfig>) => {
      updateConfig({
        screenWatch: { ...getConfig().screenWatch, ...patch }
      })
      // Re-arm the loop so changes to enabled / intervalMinutes apply
      // immediately (otherwise the old timer keeps running on the old
      // cadence until app restart).
      const { startScreenWatch } = await import('../services/proactive/screenWatch')
      startScreenWatch()
      return emitConfig(e.sender.id)
    }
  )

  // v1.10.1 — experimental feature gates (visualClick etc). Off by
  // default; user opts in from Settings → Experimental.
  ipcMain.handle(
    'config:set-experimental-features',
    (e, patch: Partial<import('@shared/types').ExperimentalFeaturesConfig>) => {
      updateConfig({
        experimentalFeatures: {
          ...getConfig().experimentalFeatures,
          ...patch
        }
      })
      return emitConfig(e.sender.id)
    }
  )

  ipcMain.handle(
    'config:set-embedding-provider',
    (e, provider: import('@shared/types').EmbeddingProvider) => {
      const previousModel = currentEmbeddingModel()
      updateConfig({ chat: { ...getConfig().chat, embeddingProvider: provider } })
      const newModel = currentEmbeddingModel()
      // If the active embedding model actually changed (provider 'auto' may
      // resolve to the same model when keys haven't moved), drop every row
      // tagged with a different model. cosine-search already ignores them —
      // they were unreachable RAG context AND occupying the per-source cap.
      // Re-indexing rebuilds them under the new model.
      if (previousModel !== newModel) {
        const purged = removeNonCurrentModel(newModel)
        if (purged > 0) {
          log(
            'info',
            'system',
            `Embedding provider changed to ${provider} → ${newModel}. Purged ${purged} row(s) tagged with stale models. Re-index your folders to rebuild RAG.`
          )
        }
      }
      return emitConfig(e.sender.id)
    }
  )

  ipcMain.handle('config:set-onboarded', (e, value: boolean) => {
    updateConfig({ onboarded: value })
    return emitConfig(e.sender.id)
  })

  ipcMain.handle('config:set-api-key', (e, provider: ProviderId, key: string) => {
    setApiKey(provider, key)
    log(
      key.trim() ? 'success' : 'info',
      'system',
      `API key ${key.trim() ? 'saved' : 'cleared'} for ${provider}.`
    )
    return emitConfig(e.sender.id)
  })

  ipcMain.handle('secrets:set', (_e, id: string, value: string) => {
    setSecret(id, value)
    log(
      value.trim() ? 'success' : 'info',
      'system',
      `Integration secret ${value.trim() ? 'saved' : 'cleared'} for ${id}.`
    )
    return hasSecret(id)
  })
  ipcMain.handle('secrets:has', (_e, id: string) => hasSecret(id))
  // Allowlisted secrets the renderer is permitted to read directly. Today this
  // is just the Picovoice access key, which the wake-word engine in the
  // renderer needs at construction time — keeping it in the keychain still
  // gives us encrypted-at-rest, and the renderer is part of our own app.
  //
  // Additionally scoped to the main panel window — the Settings window has
  // no business reading raw secrets (it only ever calls `has`/`set`), and
  // narrowing the surface here means a future XSS-style regression in the
  // Settings view can't trivially exfiltrate the key.
  const RENDERER_READABLE_SECRETS = new Set(['picovoice'])
  ipcMain.handle('secrets:get', (e, id: string) => {
    if (!RENDERER_READABLE_SECRETS.has(id)) return null
    const panelId = getWindow()?.webContents.id
    if (panelId === undefined || e.sender.id !== panelId) {
      log('warn', 'system', `Refused secrets:get(${id}) from non-panel renderer`)
      return null
    }
    return getSecret(id)
  })

  /* ------------------------------- share ------------------------------- */
  // v2.0 round-4 security polish — `share:gist` uses the user's stored GitHub
  // PAT to publish content. A compromised renderer could otherwise publish
  // arbitrary text — silently, no UI confirm, no rate limit — to the user's
  // public gists. We require an explicit `dialog.showMessageBox` confirm
  // immediately before the upload, validate inputs, and cap the body.
  // `share:save-file` already prompts the user via the native save dialog,
  // so it's user-confirmed by construction; we only add size + type checks.

  const MAX_SHARE_BYTES = 5 * 1024 * 1024 // 5 MB — generous for code/markdown

  ipcMain.handle('share:save-file', (_e, title: string, content: string, extension?: string) => {
    if (typeof title !== 'string' || typeof content !== 'string') {
      throw new Error('share:save-file expects string title + content')
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_SHARE_BYTES) {
      throw new Error(`share:save-file content exceeds ${MAX_SHARE_BYTES} bytes`)
    }
    if (extension !== undefined && typeof extension !== 'string') {
      throw new Error('share:save-file extension must be a string when provided')
    }
    return saveToFile(title, content, extension)
  })
  ipcMain.handle(
    'share:gist',
    async (_e, title: string, content: string, isPublic: boolean, extension?: string) => {
      if (typeof title !== 'string' || typeof content !== 'string') {
        throw new Error('share:gist expects string title + content')
      }
      if (typeof isPublic !== 'boolean') {
        throw new Error('share:gist expects a boolean isPublic flag')
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_SHARE_BYTES) {
        throw new Error(`share:gist content exceeds ${MAX_SHARE_BYTES} bytes`)
      }
      if (extension !== undefined && typeof extension !== 'string') {
        throw new Error('share:gist extension must be a string when provided')
      }
      // Native confirmation — blocks the renderer until the user clicks
      // Upload / Cancel. The dialog runs in main, so a renderer-controlled
      // dialog message can't impersonate a different action.
      const focused = BrowserWindow.getFocusedWindow() ?? undefined
      const result = await dialog.showMessageBox(focused as BrowserWindow, {
        type: 'question',
        buttons: ['Upload to GitHub', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Confirm gist upload',
        message: `Upload "${title.slice(0, 80)}" as a ${isPublic ? 'PUBLIC' : 'secret'} gist to your GitHub account?`,
        detail: `Size: ${Buffer.byteLength(content, 'utf-8').toLocaleString()} bytes. This uses your stored GitHub personal access token. ${isPublic ? 'Public gists are indexed by search engines.' : 'Secret gists are still accessible to anyone who has the URL.'}`,
        noLink: true
      })
      if (result.response !== 0) {
        return { cancelled: true }
      }
      return uploadGist(title, content, isPublic, extension)
    }
  )

  /* ------------------------------- usage ------------------------------- */

  ipcMain.handle('usage:summary', () => getUsageSummary())
  // v1.12.0 — provider performance dashboard. Caller passes the window
  // size; we don't fix it so a future "compare 7d vs 30d" toggle costs
  // zero IPC churn.
  ipcMain.handle('usage:provider-performance', (_e, days: number) => getProviderPerformance(days))
  ipcMain.handle('usage:get-budget', () => getBudgetState())
  ipcMain.handle(
    'usage:set-budget',
    (_e, monthlyUsd: number | null, opts?: { currency?: string; usdRate?: number }) =>
      updateBudget(monthlyUsd, opts ?? {})
  )
  ipcMain.handle('usage:clear', () => {
    clearUsage()
  })

  /* -------------------------- Agent checkpoints ------------------------ */

  ipcMain.handle('agent-checkpoint:create', (_e, input: AgentCheckpointCreate) => {
    const out = createAgentCheckpoint(input)
    // v2.0 round-7 — flip the tray poll from idle 30s back to active 4s
    // immediately so the user sees the step counter tick from the first
    // checkpoint, not after up to 30s of stale "idle" state.
    bumpAgentProgressPolling()
    return out
  })
  ipcMain.handle('agent-checkpoint:update', (_e, requestId: string, patch: AgentCheckpointUpdate) =>
    updateAgentCheckpoint(requestId, patch)
  )
  ipcMain.handle(
    'agent-checkpoint:finalize',
    (
      _e,
      requestId: string,
      status: Exclude<AgentCheckpointStatus, 'running'>,
      failure: string | null
    ) => finalizeAgentCheckpoint(requestId, status, failure)
  )
  ipcMain.handle('agent-checkpoint:list-stale', () => listStaleAgentCheckpoints())
  ipcMain.handle('agent-checkpoint:get', (_e, requestId: string) => getAgentCheckpoint(requestId))
  ipcMain.handle('agent-checkpoint:delete', (_e, requestId: string) =>
    deleteAgentCheckpoint(requestId)
  )

  /* ------------------------------- AI ---------------------------------- */

  /**
   * v2.0 — applies the `onUserMessage` plugin hook to the last user
   * message in a chat / agent request. Returns the request with that
   * message's content potentially rewritten. If no user message exists
   * (rare — every send has one) or hooks are disabled, returns the
   * input unchanged.
   *
   * The handler receives the message content + provider + model so a
   * plugin can react to "I'm sending this to gpt-4o-mini" vs "this is
   * going to Claude" if it wants to. Anything else stays out of scope
   * for the foundation; v2.1 broadens the payload.
   */
  function applyUserMessageHook<R extends ChatRequest | AgentRequest>(req: R): R {
    const lastUserIdx = (() => {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        if (req.messages[i].role === 'user') return i
      }
      return -1
    })()
    if (lastUserIdx < 0) return req
    const original = req.messages[lastUserIdx]
    const result = dispatchHook('onUserMessage', {
      content: original.content,
      provider: req.provider,
      model: req.model
    })
    if (result.content === original.content) return req
    const messages = req.messages.slice()
    messages[lastUserIdx] = { ...original, content: result.content }
    return { ...req, messages }
  }

  ipcMain.handle('ai:chat', async (event, rawReq: ChatRequest): Promise<ChatStreamDone> => {
    const req = applyUserMessageHook(rawReq)
    const controller = new AbortController()
    registerAbortable(req.requestId, controller)
    log('info', 'ai', `Completion via ${req.provider} (${req.model}).`)

    try {
      const outcome = await runCompletion(
        req,
        (delta) => {
          const chunk: ChatStreamChunk = { requestId: req.requestId, delta }
          if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', chunk)
        },
        controller.signal
      )
      if (outcome.error && outcome.error !== 'aborted') {
        log('error', 'ai', `Completion failed: ${outcome.error}`)
      }
      // v2.0 — fire onAssistantReply after the model returns. Read-only
      // for now (handlers can't rewrite the reply because we've already
      // streamed it). v2.1 may add a buffered-non-stream variant.
      dispatchHook('onAssistantReply', {
        content: outcome.text,
        model: req.model,
        provider: req.provider,
        error: outcome.error ?? null
      })
      return { requestId: req.requestId, text: outcome.text, error: outcome.error }
    } finally {
      unregisterAbortable(req.requestId, controller)
    }
  })

  // Aborts EVERY controller registered against the request — the LLM call
  // AND any in-flight tool calls (web_fetch, run_python, generate_image,
  // etc.) the agent loop kicked off. Before, only the LLM stopped — tool
  // subprocesses + network calls leaked past Stop.
  ipcMain.handle('ai:abort', (_e, requestId: string) => {
    abortRequest(requestId)
  })

  ipcMain.handle('ai:invoke', async (_e, rawReq: AgentRequest): Promise<AgentResult> => {
    const req = applyUserMessageHook(rawReq)
    const controller = new AbortController()
    registerAbortable(req.requestId, controller)
    log('info', 'ai', `Agent step via ${req.provider} (${req.model}).`)
    try {
      const result = await invokeCompletion(req, controller.signal)
      if (result.error && result.error !== 'aborted') {
        log('error', 'ai', `Agent step failed: ${result.error}`)
      }
      // v2.0 — fire onAssistantReply per agent step (the loop may run
      // many of these per send). Same trade-off as the chat path: the
      // step has already returned, so handlers observe but don't
      // rewrite.
      dispatchHook('onAssistantReply', {
        content: result.text,
        model: req.model,
        provider: req.provider,
        error: result.error ?? null
      })
      return result
    } finally {
      unregisterAbortable(req.requestId, controller)
    }
  })

  ipcMain.handle('ai:list-models', (_e, provider: ProviderId) => listModels(provider))

  ipcMain.handle(
    'ai:transcribe',
    async (
      _e,
      audio: { pcm: Float32Array; sampleRate: number }
    ): Promise<{ text: string; error?: string }> => {
      // v2.0 round-3 security polish — cap pcm length + validate the sample
      // rate. Without these checks a compromised renderer could ship a
      // Float32Array of length 10^9 and OOM the main process inside
      // `pcmFloat32ToWav`'s `Buffer.alloc(44 + pcm.length * 2)`. 16 kHz × 600 s
      // (10 min) = 9.6M samples is comfortably above any realistic single
      // utterance.
      const MAX_PCM_SAMPLES = 9_600_000
      const sr = audio?.sampleRate
      if (!Number.isFinite(sr) || sr < 4000 || sr > 192000) {
        return { text: '', error: 'Invalid sample rate.' }
      }
      const pcm = audio?.pcm
      if (!(pcm instanceof Float32Array)) {
        return { text: '', error: 'PCM data missing or wrong type.' }
      }
      if (pcm.length > MAX_PCM_SAMPLES) {
        return {
          text: '',
          error: `Audio too long (${pcm.length} samples; max ${MAX_PCM_SAMPLES}).`
        }
      }
      try {
        const text = await transcribeAudio(audio)
        log('info', 'ai', `Transcribed ${text.length} character(s) of speech.`)
        return { text }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transcription failed.'
        log('error', 'ai', `Transcription failed: ${message}`)
        return { text: '', error: message }
      }
    }
  )

  /* --------------------------- permissions ----------------------------- */

  ipcMain.handle('permissions:get', () => getPermissions())

  ipcMain.handle('permissions:set', (e, id: PermissionId, granted: boolean) => {
    const permissions = setPermission(id, granted)
    if (id === 'screenCapture' && !granted) setScreenAwareness(false)
    emitConfig(e.sender.id)
    return permissions
  })

  ipcMain.handle('permissions:revoke-all', (e) => {
    setScreenAwareness(false)
    const permissions = revokeAll()
    emitConfig(e.sender.id)
    return permissions
  })

  /* ---------------------------- automation ----------------------------- */

  ipcMain.handle('automation:execute', async (_e, req: ActionRequest) => {
    // Only register against the abort registry when the caller threaded a
    // requestId in — one-off user-triggered actions (tray quick-prompts,
    // Nexus buttons) don't have an agent-loop to correlate with, so they
    // run with no signal (the existing pre-fix behaviour).
    if (!req.requestId) {
      return executeAction(req)
    }
    const controller = new AbortController()
    registerAbortable(req.requestId, controller)
    try {
      return await executeAction(req, controller.signal)
    } finally {
      unregisterAbortable(req.requestId, controller)
    }
  })
  ipcMain.handle('automation:undo', (_e, undoId: string) => undoAction(undoId))
  ipcMain.handle('automation:list', () => ACTION_DESCRIPTORS)

  /* -------------------- python sandbox (v2.0) ----------------------- */
  // Settings panel reads + manual control. Execution itself flows
  // through `automation:execute` with type 'run-python' + threadId set —
  // no dedicated exec channel here.
  ipcMain.handle('python-sandbox:list', () => listPythonKernels())
  ipcMain.handle('python-sandbox:restart', async (_e, threadId: string) => {
    await restartPythonForThread(threadId)
    return { ok: true as const }
  })
  ipcMain.handle('python-sandbox:dispose', async (_e, threadId: string) => {
    await disposePythonForThread(threadId)
    return { ok: true as const }
  })

  /* ------------------------------ plugins ------------------------------ */

  ipcMain.handle('plugins:list', () => getPlugins())
  ipcMain.handle('plugins:set-enabled', (_e, id: string, enabled: boolean) =>
    setPluginEnabled(id, enabled)
  )
  ipcMain.handle('plugins:reload', () => reloadPlugins())
  ipcMain.handle('plugins:actions', () => getPluginActions())
  ipcMain.handle('plugins:open-folder', () => shell.openPath(pluginsDirectory()))
  // Marketplace — fetch the public registry list, install a manifest from
  // the renderer. Network errors bubble up as plain Error messages so the
  // settings UI can render them in a toast.
  ipcMain.handle('plugins:browse', () => fetchRegistry())
  ipcMain.handle('plugins:install', (_e, manifest: unknown) => installPlugin(manifest))

  /* ------------------------------ screen ------------------------------- */
  // v2.0 round-5 cleanup — the request-response `screen:capture`,
  // `screen:ocr`, and `screen:active-window` IPC handlers were
  // removed: nothing in the renderer ever invoked them (grep across
  // src/ for `vs.screen.*` returns zero hits). Round-3 added security
  // gates to plug a theoretical attack surface; round-5 deletes the
  // handlers outright since dead code is the strongest gate.
  //
  // The `screen:active-window` EVENT channel is still live — it's
  // broadcast by awareness.ts on window-change and subscribed via
  // `vs.events.onActiveWindow`. Broadcasts and request handlers are
  // separate IPC paths even though they share a channel name.

  /* ------------------------------ memory ------------------------------- */

  ipcMain.handle('memory:get', () => getMemory())
  ipcMain.handle('memory:remember-project', (_e, path: string) => rememberProject(path))
  ipcMain.handle('memory:forget-project', (_e, path: string) => forgetProject(path))
  ipcMain.handle('memory:add-favorite', (_e, label: string, target: string) =>
    addFavoriteApp(label, target)
  )
  ipcMain.handle('memory:remove-favorite', (_e, id: string) => removeFavoriteApp(id))
  ipcMain.handle('memory:import-taskbar', async () => {
    const apps = await importTaskbarApps()
    const favoriteApps = importFavoriteApps(apps)
    log('info', 'system', `Imported ${apps.length} pinned app(s) from the taskbar.`)
    return favoriteApps
  })
  ipcMain.handle('memory:add-prompt', (_e, label: string, prompt: string) => {
    const result = addCustomPrompt(label, prompt)
    refreshTray()
    return result
  })
  ipcMain.handle('memory:remove-prompt', (_e, id: string) => {
    const result = removeCustomPrompt(id)
    refreshTray()
    return result
  })
  ipcMain.handle('memory:add-action', (_e, label: string, kind: CustomActionKind, target: string) =>
    addCustomAction(label, kind, target)
  )
  ipcMain.handle('memory:remove-action', (_e, id: string) => removeCustomAction(id))
  ipcMain.handle('memory:add-fact', (_e, text: string, modes?: ModeId[]) => addFact(text, modes))
  ipcMain.handle('memory:update-fact', (_e, id: string, text: string) => updateFact(id, text))
  ipcMain.handle('memory:set-fact-modes', (_e, id: string, modes: ModeId[]) =>
    setFactModes(id, modes)
  )
  ipcMain.handle('memory:remove-fact', (_e, id: string) => removeFact(id))
  ipcMain.handle('memory:clear-facts', () => clearFacts())

  // v2.0 — passive biographical profile. `merge` is the extractor's
  // write path (renderer-driven, post-stream); `remove` + `clear` are
  // for the Settings panel's per-entry delete + bulk-clear buttons.
  ipcMain.handle(
    'memory:bio-merge',
    (_e, updates: { category: BiographicalCategory; text: string }[]) => mergeBiographical(updates)
  )
  ipcMain.handle('memory:bio-remove', (_e, id: string) => removeBiographical(id))
  ipcMain.handle('memory:bio-clear', () => clearBiographical())

  // v1.4.0 emotional-context subsystem.
  // - on-user-message: chat-store fires this after each user send so the
  //   scheduler can decide whether to classify the recent window.
  //   Fire-and-forget — the renderer doesn't wait on the model.
  // - emotional-context: snapshot for the system-prompt builder + the
  //   Settings panel.
  // - sentiment-prompt-block: pre-rendered system-prompt fragment so
  //   the renderer doesn't need to re-implement the formatting.
  // - forget-recent-sentiment: privacy escape hatch wired to the
  //   Settings "Forget" button.
  ipcMain.handle('memory:on-user-message', (_e, threadId: string, recentMessages: ChatTurn[]) => {
    // Fire-and-forget; we don't await the classifier here.
    void sentimentOnUserMessage(threadId, recentMessages)
    return { ok: true }
  })
  ipcMain.handle('memory:emotional-context', () => getEmotionalContext())
  ipcMain.handle('memory:sentiment-prompt-block', () => buildSentimentPromptBlock())
  // v2.0 round-5 cleanup — `memory:recent-sentiments` handler removed
  // (zero renderer callers). The recent sentiment history is read
  // server-side in the prompt composer; the renderer never needed it.
  ipcMain.handle('memory:forget-recent-sentiment', (_e, days?: number) => {
    resetSentimentCache()
    return forgetRecentSentiment(days)
  })

  // v1.5.0 — proactive watch tasks. CRUD + interaction bump (chat
  // store calls bump on every user send so idle-duration watches
  // measure from real activity, not from app start).
  ipcMain.handle('proactive:list', async () => {
    const { listWatchTasks } = await import('../services/proactive/watchTasks')
    return listWatchTasks()
  })
  ipcMain.handle('proactive:set-enabled', async (_e, id: string, enabled: boolean) => {
    const { setWatchEnabled } = await import('../services/proactive/watchTasks')
    return setWatchEnabled(id, enabled)
  })
  ipcMain.handle('proactive:remove', async (_e, id: string) => {
    const { removeWatchTask } = await import('../services/proactive/watchTasks')
    removeWatchTask(id)
    return { ok: true }
  })
  ipcMain.handle('proactive:bump-interaction', async () => {
    const { bumpInteraction } = await import('../services/proactive/watchTasks')
    bumpInteraction()
    return { ok: true }
  })

  // v1.7.3 — cross-window wake-word diagnostic relay. The Whisper engine
  // runs in the main panel renderer (it needs the browser audio APIs),
  // but the diagnostic UI lives in the de-docked Settings window. Stores
  // are per-renderer in Electron, so the engine's local store updates
  // are invisible to the Settings window. This handler accepts a state
  // snapshot from any renderer and relays it to the OTHER windows, so
  // the Settings window can mirror what the main panel is recording.
  ipcMain.handle(
    'wake-diagnostic:relay',
    (
      e,
      snapshot: {
        armed: boolean
        listening: boolean
        scans: number
        blockedReason: string | null
        heard: Array<{ at: number; text: string; matched: boolean; error?: string }>
      }
    ) => {
      // exceptSenderId so the source window doesn't echo to itself —
      // it already updated its local store directly before calling this.
      broadcast('wake-diagnostic:update', snapshot, e.sender.id)
      return { ok: true }
    }
  )
  // v1.8.0 — click-preview HUD resolve. The renderer in the preview
  // window calls this with the token it received in its query string
  // and the user's decision (go = countdown elapsed, cancel = Esc or
  // Cancel button). Main settles the awaiting Promise in clickPreview.ts
  // and closes the window. Unknown tokens are silently dropped — they're
  // usually stale resolves from a previously-cancelled preview.
  ipcMain.handle('click-preview:resolve', async (_e, token: string, decision: 'go' | 'cancel') => {
    const { resolvePreview } = await import('../services/automation/clickPreview')
    resolvePreview(token, decision)
    return { ok: true }
  })
  // v1.6.0 — user-created watch tasks. The renderer sends a fully-formed
  // WatchSpec (validated client-side by CustomWatchTaskDialog); main just
  // hands it to the same `addWatchTask` that the boot-time seeder uses.
  ipcMain.handle(
    'proactive:add',
    async (
      _e,
      input: { name: string; spec: import('@shared/types').WatchSpec; enabled?: boolean }
    ) => {
      const { addWatchTask } = await import('../services/proactive/watchTasks')
      return addWatchTask(input)
    }
  )

  // v1.7 — screen-watch loop. Settings UI calls these to drive the
  // periodic vision observer. `observeNow` runs a one-off tick and
  // returns the updated status (handy for a "Test now" button).
  ipcMain.handle('screen-watch:status', async () => {
    const { getScreenWatchStatus } = await import('../services/proactive/screenWatch')
    return getScreenWatchStatus()
  })
  ipcMain.handle('screen-watch:restart', async () => {
    const { startScreenWatch } = await import('../services/proactive/screenWatch')
    startScreenWatch()
    return { ok: true }
  })
  ipcMain.handle('screen-watch:observe-now', async () => {
    const { observeNow } = await import('../services/proactive/screenWatch')
    return observeNow()
  })

  /* ----------------------------- history ------------------------------- */

  ipcMain.handle('history:summaries', () => getHistorySummaries())
  ipcMain.handle('history:get-thread-messages', (_e, id: string) => getThreadMessages(id))
  ipcMain.handle('history:search', (_e, query: string) => searchMessages(query))
  ipcMain.handle(
    'history:save-thread',
    (_e, threadId: string, messages: ChatMessage[], summary?: HistorySummary | null) =>
      saveThread(threadId, messages, summary)
  )
  ipcMain.handle('history:create-thread', (_e, title?: string) => createThread(title))
  ipcMain.handle('history:rename-thread', (_e, id: string, title: string) =>
    renameThread(id, title)
  )
  ipcMain.handle('history:delete-thread', (_e, id: string) => {
    // v2.0 — fire-and-forget cleanup of the thread's Python kernel +
    // workspace dir. The handler returns synchronously with the new
    // summaries so the UI doesn't wait on subprocess teardown; the
    // kernel dispose runs in the background. Safe ordering: even if
    // disposePythonForThread races with a in-flight runCode for the
    // same thread, the runCode rejects with "kernel exited" and the
    // tool surface returns a clean error.
    void disposePythonForThread(id).catch(() => {
      /* logged inside the manager */
    })
    return deleteThread(id)
  })
  ipcMain.handle('history:set-active-thread', (_e, id: string) => {
    setActiveThread(id)
  })
  ipcMain.handle('history:set-pinned', (_e, id: string, pinned: boolean) =>
    setThreadPinned(id, pinned)
  )
  ipcMain.handle('history:set-thread-mode', (_e, id: string, mode: ModeId | null) =>
    setThreadMode(id, mode)
  )
  ipcMain.handle('history:set-thread-system-prompt', (_e, id: string, prompt: string | null) =>
    setThreadSystemPrompt(id, prompt)
  )
  ipcMain.handle('history:clear-thread', (_e, id: string) => clearThread(id))
  ipcMain.handle('history:clear-all', () => {
    // v2.0 — `clear-all` mirrors the per-thread `delete-thread` handler:
    // dispose ALL Python kernels + their workspaces before walking the
    // SQLite rows. The single-thread handler does this for one id; the
    // clear-all variant was missed and orphaned every kernel + workspace
    // dir on disk forever. Fire-and-forget so the UI doesn't wait on
    // subprocess teardown; if a runCode races, it rejects with "kernel
    // exited" and surfaces as a clean tool error.
    void disposePythonAll().catch(() => {
      /* logged inside the manager */
    })
    return clearAllThreads()
  })

  /* ------------------------------ projects ------------------------------ */

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle(
    'projects:create',
    (_e, input: { name: string; description?: string | null; instructions?: string | null }) =>
      createProject(input)
  )
  ipcMain.handle(
    'projects:update',
    (
      _e,
      id: string,
      patch: { name?: string; description?: string | null; instructions?: string | null }
    ) => updateProject(id, patch)
  )
  ipcMain.handle('projects:delete', (_e, id: string) => {
    deleteProject(id)
    return listProjects()
  })
  ipcMain.handle(
    'projects:set-thread-project',
    (_e, threadId: string, projectId: string | null) => {
      setThreadProject(threadId, projectId)
      return summaryFor(threadId)
    }
  )
  // Renderer acks an in-flight flush-pending request (see `requestFlushPending`).
  // The handler resolves the pending promise registered under the token so
  // the quit-budget code stops waiting.
  ipcMain.handle('history:flush-all-ack', (_e, token: string) => {
    resolvePendingFlush(token)
  })

  /* --------------------------------- rag -------------------------------- */

  ipcMain.handle('rag:status', () => getRagStatus())
  ipcMain.handle(
    'rag:search',
    (
      _e,
      query: string,
      options?: { limit?: number; excludeIds?: string[]; source?: 'chat' | 'file' }
    ) => searchRag(query, options ?? {})
  )
  ipcMain.handle('rag:backfill', () => backfillFromThreads(getHistory().threads))
  ipcMain.handle('rag:clear', () => {
    clearRagIndex()
  })

  /* ----------------------- vector-store browser (v2.0) ----------------- */

  ipcMain.handle('vector-store:stats', () => vectorStoreStats())
  ipcMain.handle('vector-store:list-files', (_e, folderPrefix?: string) =>
    listVectorStoreFiles(folderPrefix)
  )
  ipcMain.handle('vector-store:list-chunks', (_e, filePath: string) =>
    listVectorStoreChunks(filePath)
  )
  ipcMain.handle('vector-store:query-trace', () => getQueryTrace())
  ipcMain.handle('vector-store:clear-trace', () => {
    clearQueryTrace()
  })
  ipcMain.handle(
    'vector-store:explain',
    (_e, query: string, options?: { limit?: number; source?: 'chat' | 'file' }) =>
      ragExplainQuery(query, options ?? {})
  )
  // Excluding a chunk = removing its row(s). Re-indexing the source file
  // brings it back, which is the right semantic: "this chunk is noise
  // until the underlying file changes." Returns the count actually
  // removed in case any of the IDs were stale.
  ipcMain.handle('vector-store:exclude', (_e, ids: string[]) => {
    if (!ids || ids.length === 0) return { removed: 0 }
    ragRemoveByIds(ids)
    return { removed: ids.length }
  })

  /* ----------------------------- files RAG ------------------------------ */

  ipcMain.handle('files-rag:list-folders', () => filesRagListFolders())
  ipcMain.handle('files-rag:list-files', (_e, folder: string) => filesRagListFiles(folder))
  ipcMain.handle('files-rag:add-folder', async () => {
    const win = getWindow()
    if (!win) return { ok: false as const, folders: filesRagListFolders() }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Pick a folder to index'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false as const, folders: filesRagListFolders() }
    }
    const folder = result.filePaths[0]
    try {
      await filesRagAddFolder(folder)
    } catch (err) {
      return {
        ok: false as const,
        folders: filesRagListFolders(),
        error: err instanceof Error ? err.message : 'Failed to add folder.'
      }
    }
    // Kick off the scan in the background so the dialog can close immediately;
    // the renderer polls `files-rag:scan-status` for progress.
    void scanFolder(folder, (p) => {
      broadcast('files-rag:progress', p)
    }).then((r) => {
      broadcast('files-rag:done', r)
    })
    return { ok: true as const, folders: filesRagListFolders(), folder }
  })
  ipcMain.handle('files-rag:remove-folder', (_e, folder: string) => filesRagRemoveFolder(folder))
  ipcMain.handle('files-rag:rescan', (_e, folder: string) => {
    void scanFolder(folder, (p) => broadcast('files-rag:progress', p)).then((r) => {
      broadcast('files-rag:done', r)
    })
    return { ok: true as const }
  })
  ipcMain.handle('files-rag:rescan-all', () => {
    void rescanAllFolders((p) => broadcast('files-rag:progress', p)).then(() => {
      broadcast('files-rag:done', null)
    })
    return { ok: true as const }
  })
  // v2.0 round-5 cleanup — `files-rag:scan-status` polling handler
  // removed. Renderer now subscribes to the push-based `files-rag:progress`
  // event instead of polling, so this request handler was dead.
  // v2.0 — pause a running scan. Partial progress stays on disk; the
  // next `files-rag:rescan` resumes via the stat-skip fast path.
  ipcMain.handle('files-rag:stop-scan', (_e, folder: string) => {
    filesRagStopScan(folder)
    return { ok: true as const }
  })

  /* --------------------------------- mcp -------------------------------- */

  ipcMain.handle('mcp:list', () => mcpListServers())
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => mcpAddServer(input))
  ipcMain.handle('mcp:update', (_e, id: string, input: McpServerInput) =>
    mcpUpdateServer(id, input)
  )
  ipcMain.handle('mcp:get-config', (_e, id: string) => mcpGetServerConfig(id))
  ipcMain.handle('mcp:remove', (_e, id: string) => mcpRemoveServer(id))
  ipcMain.handle('mcp:set-enabled', (_e, id: string, enabled: boolean) =>
    mcpSetServerEnabled(id, enabled)
  )
  ipcMain.handle('mcp:reconnect', (_e, id: string) => mcpReconnectServer(id))
  ipcMain.handle('mcp:call-tool', (_e, name: string, args: Record<string, unknown>) =>
    mcpCallTool(name, args)
  )

  /* -------------------------- browser extension ------------------------ */

  // v2.0 — local-only browser-extension bridge. The renderer's Settings
  // panel reads `status` to render the "listening / N clients" chip and
  // calls `set-enabled` when the user toggles the master switch. The
  // server's own lifecycle (start/stop, stale-socket cleanup) lives in
  // `services/extension-bridge/server.ts`; this layer is purely the
  // IPC plumbing + config write-through.
  ipcMain.handle('extension:status', () => extensionBridgeStatus())
  ipcMain.handle('extension:set-enabled', async (_e, enabled: boolean) => {
    updateConfig({ browserExtension: { enabled } })
    if (enabled) {
      await startExtensionBridge()
    } else {
      await stopExtensionBridge()
    }
    return extensionBridgeStatus()
  })

  /* ------------- v2.0 Home Assistant integration ------------- */
  // Lightweight surface — the renderer's setup wizard + Settings panel
  // both consume the same status snapshot, and writes go through a
  // single `configure` IPC so the panel doesn't have to choreograph
  // multiple round trips to set URL + token + enabled in sequence.
  ipcMain.handle('home-assistant:status', () => haGetStatus())
  ipcMain.handle('home-assistant:refresh', () => haRefreshStatus())
  ipcMain.handle('home-assistant:test', async (_e, opts: { url: string; token: string }) => {
    // Provisional credentials — DO NOT persist until the user confirms
    // by clicking "Enable" in the wizard. We hit the live endpoint to
    // verify, then return the connection result + a sample of entities
    // for the wizard preview. The token is held in memory only for
    // the duration of this call.
    // v2.0 polish — shared 15s timeout across both probes so an
    // unreachable HA can't hang the wizard for ~2 minutes on the OS
    // TCP-connect default. Matches haFetch's normal-path timeout.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const url = haNormaliseUrl(opts.url)
      const token = opts.token.trim()
      if (!token) throw new Error('Long-lived access token is required.')
      // Direct fetch — avoid touching the cached client which reads
      // from persisted config. This keeps "test" idempotent against
      // the live config (so the user can test alternate URLs without
      // overwriting their working one).
      const probe = await fetch(`${url}/api/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      })
      if (!probe.ok) {
        throw new Error(
          probe.status === 401
            ? 'Token rejected. Generate a fresh long-lived token from HA Profile.'
            : `HA HTTP ${probe.status}: ${probe.statusText}`
        )
      }
      const info = (await probe.json()) as { location_name?: string; version?: string }
      const statesResponse = await fetch(`${url}/api/states`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      })
      const states = statesResponse.ok ? ((await statesResponse.json()) as unknown[]) : []
      return {
        ok: true,
        url,
        instanceName: info.location_name ?? null,
        version: info.version ?? null,
        entityCount: states.length,
        sample: (
          states.slice(0, 12) as Array<{
            entity_id?: string
            state?: string
            attributes?: { friendly_name?: string }
          }>
        )
          .filter((s) => typeof s.entity_id === 'string')
          .map((s) => ({
            entity_id: s.entity_id as string,
            state: typeof s.state === 'string' ? s.state : '',
            friendly_name: s.attributes?.friendly_name ?? null,
            domain: (s.entity_id as string).split('.', 1)[0]
          }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Translate timeout abort into UX-friendly copy.
      return {
        ok: false,
        error:
          err instanceof Error && err.name === 'AbortError'
            ? `Could not reach ${opts.url.trim() || 'that URL'} within 15s — check the address and that HA is running.`
            : msg
      }
    } finally {
      clearTimeout(timeout)
    }
  })
  ipcMain.handle(
    'home-assistant:configure',
    async (_e, opts: { url: string; token: string; enabled: boolean }) => {
      const url = haNormaliseUrl(opts.url)
      // v2.0 polish — if the URL changed, wipe the cached probe so the
      // status badge doesn't show last-instance's name/version/entity
      // count against the new URL until the user manually refreshes.
      const previousUrl = getConfig().homeAssistant?.url
      if (previousUrl && previousUrl !== url) haResetStatusCache()
      // The Settings panel's re-enable toggle passes the sentinel
      // `__keep__` to say "leave the existing keychain entry alone" —
      // we still want to write URL + enabled but skip the token rewrite
      // (which would wipe it via the empty-string delete path).
      const token = opts.token.trim()
      if (token && token !== '__keep__') {
        haSetToken(token)
      }
      updateConfig({ homeAssistant: { url, enabled: opts.enabled } })
      // Probe immediately so the panel's status badge reflects truth on
      // the next paint instead of waiting for the user to click Refresh.
      return haRefreshStatus()
    }
  )
  ipcMain.handle('home-assistant:disable', () => {
    const current = getConfig().homeAssistant
    updateConfig({ homeAssistant: { url: current?.url ?? '', enabled: false } })
    // Reset the probe cache so the status badge stops claiming "connected"
    // while the toggle says disabled.
    haResetStatusCache()
    return haGetStatus()
  })
  ipcMain.handle('home-assistant:clear', () => {
    haClearToken()
    updateConfig({ homeAssistant: { url: '', enabled: false } })
    return haGetStatus()
  })

  /* --------------------------------- setup ------------------------------ */

  // First-run "we found X on your machine" scan. Pure read — never mutates
  // state or carries raw API-key values across IPC (only previews; see the
  // SetupReport docs in shared/types.ts for the security rationale).
  ipcMain.handle('setup:detect', () => runSetupDetection())

  // Selective imports — caller passes the names from the report it just
  // received. We re-detect inside the import functions so the data can't
  // go stale between the user opening the panel and clicking import.
  ipcMain.handle('setup:import-claude', (_e, names: string[]) => importClaudeDesktopServers(names))
  ipcMain.handle('setup:import-cursor', (_e, names: string[]) => importCursorServers(names))
  // Env-key import reads process.env on this side so the raw key value
  // never has to cross IPC — only the provider id does.
  ipcMain.handle('setup:import-env-key', (_e, providerId: ProviderId) => importEnvKey(providerId))

  // MCP marketplace — fetch the curated registry list and install a
  // selected entry with the user's filled-in args / env.
  ipcMain.handle('mcp:browse-registry', (_e, opts?: { force?: boolean }) =>
    fetchMcpRegistry(opts ?? {})
  )
  ipcMain.handle('mcp:install-registry', (_e, entry: McpRegistryEntry, values: McpInstallValues) =>
    installRegistryServer({ entry, values })
  )

  /* ------------- v2.0 click_on_screen benchmark harness ------------- */
  // Phase 1 of the Tier-S click_on_screen plan — see comment header in
  // src/main/services/automation/clickBench/. Wired to a dialog under
  // Settings → Advanced → Experimental. Off the hot path; only the
  // user explicitly opening the dialog touches this.
  ipcMain.handle('clickbench:list', () => clickBenchList())
  ipcMain.handle(
    'clickbench:run',
    async (
      _e,
      opts: { strategyIds?: string[]; benchmarkIds?: string[]; openReportWhenDone?: boolean }
    ) => {
      const result = await clickBenchRun(opts)
      // Strip the in-memory image references before crossing IPC — the
      // renderer only needs the report paths + counts.
      return {
        htmlPath: result.htmlPath,
        csvPath: result.csvPath,
        summary: result.run.summary,
        totalCells: result.run.results.length
      }
    }
  )
  ipcMain.handle('clickbench:abort', () => clickBenchAbort())
  ipcMain.handle('clickbench:save-benchmark', (_e, benchmark: ClickBenchmark) =>
    clickBenchSave(benchmark)
  )
  ipcMain.handle('clickbench:capture-screenshot', async () => {
    // Captures the primary display so the renderer's capture dialog can
    // overlay the screenshot and let the user click the target. The hide
    // window step gives the user space to set up their target app and
    // ensures the VoidSoul UI isn't sitting on top of the click region.
    const win = getWindow()
    if (win) {
      win.hide()
      await new Promise((r) => setTimeout(r, 1500))
    }
    try {
      return await clickBenchCaptureScreenshot()
    } finally {
      if (win) win.show()
    }
  })

  /* ----------------- v2.0 Phase 4 — hover-to-teach -------------------- */
  // Settings → Experimental → click_on_screen → "Teach a click". User
  // arms a capture, switches to the target app, points cursor + presses
  // F8. Main captures the UIA element under cursor + emits result back
  // to the renderer. Renderer shows the captured element + prompts user
  // for a description, then persists via :save. At click time the
  // production pipeline (visualClick.ts step 0.3) consults this store
  // and short-circuits to a direct UIA click when an entry matches.
  ipcMain.handle('taught-clicks:list', () => taughtClicksList())
  ipcMain.handle('taught-clicks:remove', (_e, id: string) => taughtClicksRemove(id))
  ipcMain.handle(
    'taught-clicks:save',
    (
      _e,
      input: {
        rawDescription: string
        name: string
        automationId: string
        controlType: string
        inWindow: string | null
      }
    ) => taughtClicksSave(input)
  )
  ipcMain.handle('taught-clicks:start-capture', (e) => {
    const senderId = e.sender.id
    const started = taughtClicksStartCapture({
      onCaptured: (result) => {
        // Broadcast to ALL renderers (Settings might be in a separate
        // window) — they filter by `kind: 'captured'`. Cheap fan-out;
        // the payload is tiny.
        e.sender.send('taught-clicks:event', { kind: 'captured', ...result })
      },
      onCancelled: () => {
        e.sender.send('taught-clicks:event', { kind: 'cancelled' })
      }
    })
    return { ok: started, hotkey: taughtClicksHotkey(), senderId }
  })
  ipcMain.handle('taught-clicks:cancel-capture', () => {
    taughtClicksCancel()
    return { ok: true }
  })

  /* -------------------------------- voice ------------------------------- */

  // Piper TTS — replaces the Web Speech API path. Each `synthesise` call
  // spawns the bundled piper binary, pipes text in, returns WAV bytes
  // the renderer wraps in a Blob URL + plays via <audio>.
  ipcMain.handle('voice:status', () => getVoiceSetupStatus())
  ipcMain.handle(
    'voice:synthesise',
    async (
      _e,
      args: {
        persona: VoicePersona
        text: string
        rate?: number
        tone?: import('@shared/voiceMarkers').ToneTag
      }
    ) => {
      // v2.0 polish — catch + return structured so the renderer's voice
      // queue handles missing-voice / piper-crash cases as data, not as
      // a thrown IPC rejection. Without this catch, Electron logs a
      // noisy "Error occurred in handler for voice:synthesise" stack
      // trace on every boot where a queued speak fires before the user
      // has installed a voice .onnx (common after fresh install +
      // forgetting `npm run piper`).
      try {
        const wav = await piperSynthesise(args)
        // Buffer transfers across IPC as Uint8Array — explicit conversion
        // keeps the wire format predictable across Electron versions.
        return { ok: true as const, bytes: new Uint8Array(wav) }
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
  ipcMain.handle('voice:open-folder', () => shell.openPath(voicesDirectoryPath()))
  ipcMain.handle('voice:migrate-legacy', () => migrateLegacyVoices())

  /* ---------------------------- notebooks ------------------------------ */

  ipcMain.handle('notebook:list', () => listNotebooks())
  ipcMain.handle('notebook:get', (_e, id: string) => getNotebook(id))
  ipcMain.handle('notebook:create', (_e, title?: string) => createNotebook(title))
  ipcMain.handle('notebook:save', (_e, notebook: import('@shared/types').Notebook) =>
    saveNotebook(notebook)
  )
  ipcMain.handle('notebook:rename', (_e, id: string, title: string) => renameNotebook(id, title))
  ipcMain.handle('notebook:delete', (_e, id: string) => deleteNotebook(id))
  ipcMain.handle('notebook:run-cell', (_e, notebookId: string, cellId: string) =>
    runNotebookCell(notebookId, cellId)
  )
  ipcMain.handle('notebook:run-all', (_e, id: string) => runAllNotebookCells(id))

  /* ---------------------------- scheduler ------------------------------ */

  ipcMain.handle('scheduler:list', () => schedListTasks())
  ipcMain.handle('scheduler:add', (_e, input: ScheduledTaskInput) => schedAddTask(input))
  ipcMain.handle('scheduler:remove', (_e, id: string) => {
    schedRemoveTask(id)
  })
  ipcMain.handle('scheduler:set-enabled', (_e, id: string, enabled: boolean) =>
    schedSetEnabled(id, enabled)
  )
  ipcMain.handle('scheduler:run-now', (_e, id: string) => schedRunNow(id))

  /* ------------------------------- logs -------------------------------- */

  ipcMain.handle('logs:get', () => getLogs())
  ipcMain.handle('logs:clear', () => clearLogs())
  ipcMain.handle(
    'logs:write',
    (
      _e,
      level: 'info' | 'success' | 'warn' | 'error',
      category: import('@shared/types').LogCategory,
      message: string,
      detail?: string
    ) => log(level, category, message, detail)
  )

  /* ----------------------------- backup & sync ------------------------- */

  ipcMain.handle('sync:export', async () => {
    const win = getWindow()
    if (!win) return { ok: false, message: 'Window unavailable.' }
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'voidsoul-backup.json',
      filters: [{ name: 'VoidSoul Backup', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, message: 'Export cancelled.' }
    return exportToFile(result.filePath)
  })

  ipcMain.handle('sync:import', async () => {
    const win = getWindow()
    if (!win) return { ok: false, message: 'Window unavailable.' }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'VoidSoul Backup', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: 'Import cancelled.' }
    }
    return importFromFile(result.filePaths[0])
  })

  ipcMain.handle('sync:choose-folder', async () => {
    const win = getWindow()
    if (win) {
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        updateConfig({ syncFolder: result.filePaths[0] })
      }
    }
    return emitConfig()
  })

  ipcMain.handle('sync:clear-folder', () => {
    updateConfig({ syncFolder: '' })
    return emitConfig()
  })

  ipcMain.handle('sync:push', () => syncPush())
  ipcMain.handle('sync:pull', () => syncPull())

  // v2.0 — continuous E2E sync engine. The handlers below talk to a
  // separate module than the legacy manual push/pull above, but the
  // two coexist: users can keep using "Export backup" without ever
  // engaging the engine, and the engine never touches the legacy
  // `voidsoul-sync.json` bundle.
  // v2.0 polish — non-persisting folder picker for the pair wizard. The
  // legacy `sync:choose-folder` writes the picked path into
  // `config.syncFolder` immediately (used by the manual backup bundle).
  // The encrypted-sync wizard needs to pick a folder WITHOUT persisting
  // anywhere until the user confirms by clicking "Create vault" / "Join
  // vault" — otherwise an aborted setup leaves syncFolder pointing at
  // a random Dropbox/iCloud directory and the user later clicks "Push
  // bundle" expecting their old backup folder.
  ipcMain.handle('sync:pick-vault-folder', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle('sync:status', () => syncEngine.getSyncStatus())
  ipcMain.handle('sync:setup-new', async (_e, opts: { folder: string; deviceName: string }) =>
    syncEngine.setupNewVault(opts)
  )
  ipcMain.handle(
    'sync:join',
    async (_e, opts: { folder: string; mnemonic: string; deviceName: string }) =>
      syncEngine.joinExistingVault(opts)
  )
  ipcMain.handle('sync:unpair', () => syncEngine.unpair())
  ipcMain.handle('sync:now', () => syncEngine.syncNow())
  ipcMain.handle('sync:get-mnemonic', () => syncEngine.getMnemonic())

  /**
   * Per-thread export to a document format the user can drop into Word /
   * Excel / a PDF reader. The renderer picks the format and thread; we
   * render + show the save dialog + write the file. Returns a one-line
   * status the renderer can toast.
   *
   * Format-specific filename extension and MIME come from exportThread
   * itself, so adding a new format is a one-file change in
   * services/export/thread.ts — no IPC plumbing churn.
   */
  ipcMain.handle(
    'thread:export',
    async (
      _e,
      args: { threadId: string; format: ThreadExportFormat }
    ): Promise<{ ok: boolean; message: string; path?: string }> => {
      let rendered
      try {
        rendered = await exportThread(args.threadId, args.format)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, message: `Export failed: ${msg}` }
      }
      return promptSaveAndWrite(rendered, args.format, getWindow())
    }
  )

  /* ------------------------------ wake word ---------------------------- */

  // v2.0 round-5 cleanup — `wake-word:keyword-dir` removed (only
  // `keyword-bytes` and `open-folder` are actually called from the
  // renderer).
  ipcMain.handle('wake-word:open-folder', () => shell.openPath(ensureDataPath('wake-words')))
  ipcMain.handle('wake-word:keyword-bytes', async (_e, persona: 'void' | 'soul') => {
    const file = join(dataPath('wake-words'), `${persona}.ppn`)
    if (!existsSync(file)) return null
    // Base64 so the renderer can decode into a Uint8Array — Porcupine accepts
    // either a URL or raw bytes; bytes via IPC keep the file scheme out of it.
    return (await readFile(file)).toString('base64')
  })

  /* ------------------------------ window ------------------------------- */

  ipcMain.handle('window:set-expanded', (_e, expanded: boolean) => setExpanded(expanded))
  ipcMain.handle('window:move-by', (_e, dx: number, dy: number) => moveBy(dx, dy))
  ipcMain.handle('window:hide', () => hideWindow())
  // v2.0 round-5 cleanup — `window:always-on-top` removed (zero renderer
  // callers). Tray.ts calls setAlwaysOnTop directly via the main-process
  // import; the renderer's appearance settings flow through `setAppearance`
  // and main listens for that config change.

  ipcMain.handle('window:open-settings', () => {
    openSettingsWindow()
  })
  ipcMain.handle('window:close-settings', () => {
    closeSettingsWindow()
  })

  // Cross-window cross-thread search trigger. The Settings window can't
  // host its own dialog because chat state lives in the main window's
  // renderer (the per-window Zustand stores aren't synced). Instead, the
  // Settings window asks main to close itself and broadcast an open-event
  // to the main renderer, which mounts the dialog where the chat actually
  // is.
  ipcMain.handle('window:open-global-search', () => {
    closeSettingsWindow()
    showWindow()
    broadcast('widget:open-global-search')
  })

  /* ----------------------------- updater ------------------------------ */

  // Snapshot the current updater state — used by the renderer's "About"
  // panel when it first mounts so the user sees the live status rather
  // than the "idle" default until the next push event lands.
  ipcMain.handle('updater:status', () => getUpdaterStatus())
  // Manual check from the "Check for updates" button. The handler returns
  // the post-check status so the caller can show a one-shot toast.
  ipcMain.handle('updater:check', () => checkForUpdates())
  // Triggered by the "Restart and install" button when an update is
  // downloaded and waiting. No-op if no download is ready (the updater
  // service guards this internally).
  ipcMain.handle('updater:quit-and-install', () => {
    quitAndInstall()
  })

  /* ------------------------------ system ------------------------------- */

  ipcMain.handle('system:pick-file', async (_e, opts?: { images?: boolean }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: opts?.images ? PICKER_FILTERS_IMAGES_ONLY : PICKER_FILTERS_ALL
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = result.filePaths[0]
    const name = basename(path)
    const ext = extname(path).toLowerCase()
    const buffer = await readFile(path)

    if (IMAGE_EXTENSIONS.includes(ext)) {
      const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`
      return {
        path,
        name,
        kind: 'image' as const,
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
      }
    }

    // PDF — extract text (so the model sees readable content) AND keep the
    // original bytes as a data URL so the renderer can show Chromium's
    // built-in viewer inline alongside the chat. Beyond a sensible byte
    // budget the dataUrl is dropped so a large PDF doesn't permanently
    // bloat the history DB; the model side still gets the text.
    if (ext === '.pdf') {
      const text = await extractPdfTextSafe(buffer, name)
      const previewable = buffer.byteLength <= PDF_PREVIEW_MAX_BYTES
      return {
        path,
        name,
        kind: 'pdf' as const,
        text,
        ...(previewable
          ? { dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}` }
          : {})
      }
    }
    // DOCX — text only; no inline preview (Chromium has no built-in DOCX
    // viewer, and shipping one isn't worth a session for the edge case).
    if (ext === '.docx') {
      try {
        const raw = await extractDocxText(buffer)
        const text = raw.trim().slice(0, 200_000)
        return {
          path,
          name,
          kind: 'text' as const,
          text: text || `(no text extractable from ${name})`
        }
      } catch (err) {
        return {
          path,
          name,
          kind: 'text' as const,
          text: `(could not read ${name}: ${err instanceof Error ? err.message : 'unknown error'})`
        }
      }
    }

    return { path, name, kind: 'text' as const, text: buffer.toString('utf-8').slice(0, 50_000) }
  })

  ipcMain.handle('system:pick-folder', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('system:open-data-folder', () => shell.openPath(dataPath()))

  // Drag-and-drop PDFs land in the renderer as ArrayBuffer; the renderer has
  // no PDF parser of its own, so it round-trips the bytes through here for
  // text extraction. Same shape as the pdf branch of `pick-file` above.
  ipcMain.handle(
    'system:parse-pdf',
    async (_e, args: { bytes: ArrayBuffer; name: string }): Promise<string> => {
      // v2.0 round-4 polish — cap PDF payloads at 50 MB. The renderer
      // drags-and-drops a fabricated 500 MB ArrayBuffer (compromised
      // plugin / runaway useEffect) and `Buffer.from(args.bytes)` copies
      // the whole thing into main heap before pdf-parse starts, freezing
      // the UI and risking OOM on low-memory machines.
      const MAX_PDF_BYTES = 50 * 1024 * 1024
      if (!args?.bytes || args.bytes.byteLength === undefined) {
        throw new Error('system:parse-pdf expects an ArrayBuffer of bytes')
      }
      if (args.bytes.byteLength > MAX_PDF_BYTES) {
        throw new Error(`PDF too large (${args.bytes.byteLength} bytes; max ${MAX_PDF_BYTES})`)
      }
      return extractPdfTextSafe(Buffer.from(args.bytes), args.name)
    }
  )

  ipcMain.handle('system:stats', () => getSystemStats())

  // v1.13.5 — Settings diagnostic panel. Runs the actual filesystem /
  // shell / MCP probes (gated on the same permissions the agent uses) so
  // the user can verify the stack from Settings instead of debugging by
  // trial-and-error inside chat.
  ipcMain.handle('system:smoke-test', () => runSmokeTest())

  // v1.13.5 — clipboard write via Electron's native clipboard module.
  // `navigator.clipboard.writeText` in the renderer can silently reject
  // when the window has just lost OS focus or when Permissions Policy
  // resolves it as blocked — and our call sites used `void` so the
  // rejection was invisible while the UI still flashed "Copied". Native
  // clipboard has no focus / permission gate; this is the reliable path.
  ipcMain.handle('system:copy-text', (_e, text: string): boolean => {
    try {
      clipboard.writeText(text ?? '')
      return true
    } catch (err) {
      log(
        'warn',
        'system',
        'Clipboard write failed',
        err instanceof Error ? err.message : String(err)
      )
      return false
    }
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron
  }))
}

export function disposeIpc(): void {
  // Aborts every in-flight LLM call AND every in-flight tool call across
  // every request — covers both groups in one sweep.
  abortAll()
  // v2.0 — drop compiled plugin hook handlers so nothing dangles past
  // quit. Cheap (single array reassignment); pairs with the doc claim
  // in pluginHooks.clearPluginHooks() that this is the cleanup site.
  clearPluginHooks()
  // v2.0 — stop the periodic VACUUM check timer so the interval can't
  // outlive the process and fire after Electron's main has begun
  // shutting down (would throw on the closed DB connection).
  stopVacuumSchedule()
  // v2.0 — tear down every per-thread Python kernel so python.exe /
  // python3 subprocesses don't outlive the desktop app. Fire-and-forget
  // (Promise) since disposeIpc is sync; the main process's hard-exit
  // timer is the safety net if a kernel refuses to die in 1s.
  void disposePythonAll()
}
