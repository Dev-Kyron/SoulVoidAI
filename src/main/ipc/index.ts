/**
 * IPC surface. Every privileged capability the renderer can reach is
 * registered here as a single, typed `ipcMain.handle` channel. The renderer
 * never touches Node, the filesystem or the network directly — it goes
 * through these handlers, which enforce permissions and write the audit log.
 */
import { ipcMain, dialog, app, shell } from 'electron'
import { readFile } from 'node:fs/promises'
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
  setVoice
} from '../services/storage/config'
import { getSystemStats } from '../services/system/stats'
import { setApiKey, setSecret, hasSecret, getSecret } from '../services/storage/keys'
import { saveToFile, uploadGist } from '../services/share'
import {
  clearUsage,
  getBudgetState,
  getSummary as getUsageSummary,
  updateBudget
} from '../services/usage'
import { runCompletion, invokeCompletion, listModels } from '../services/ai'
import { transcribeAudio } from '../services/ai/transcribe'
import { exportToFile, importFromFile, syncPush, syncPull } from '../services/storage/sync'
import { exportThread, promptSaveAndWrite, type ThreadExportFormat } from '../services/export/thread'
import {
  createCheckpoint as createAgentCheckpoint,
  updateCheckpoint as updateAgentCheckpoint,
  finalizeCheckpoint as finalizeAgentCheckpoint,
  listStaleRunning as listStaleAgentCheckpoints,
  getCheckpoint as getAgentCheckpoint,
  deleteCheckpoint as deleteAgentCheckpoint
} from '../services/storage/agent-checkpoints'
import {
  getPermissions,
  setPermission,
  revokeAll
} from '../services/permissions/permissions'
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
import { captureScreen } from '../services/screen/screenshot'
import { extractText } from '../services/screen/ocr'
import { getActiveWindow } from '../services/screen/activeWindow'
import { setScreenAwareness } from '../services/screen/awareness'
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
  setFactModes
} from '../services/storage/memory'
import {
  onUserMessage as sentimentOnUserMessage,
  getEmotionalContext,
  buildSentimentPromptBlock,
  getRecentSentimentHistory
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
import { runAll as runAllNotebookCells, runCell as runNotebookCell } from '../services/notebook/runner'
import {
  backfillFromThreads,
  clearEmbeddings as clearRagIndex,
  getStatus as getRagStatus,
  preferredModel as currentEmbeddingModel,
  removeNonCurrentModel,
  searchSimilar as searchRag
} from '../services/embeddings'
import {
  addFolder as filesRagAddFolder,
  getActiveScan,
  listFiles as filesRagListFiles,
  listFolders as filesRagListFolders,
  removeFolder as filesRagRemoveFolder,
  rescanAll as rescanAllFolders,
  scanFolder
} from '../services/files-rag/manager'
import { broadcast, resolvePendingFlush } from '../events'
import {
  addServer as mcpAddServer,
  callTool as mcpCallTool,
  listServers as mcpListServers,
  reconnectServer as mcpReconnectServer,
  removeServer as mcpRemoveServer,
  setServerEnabled as mcpSetServerEnabled
} from '../services/mcp/manager'
import { runSetupDetection } from '../services/setup/detect'
import {
  importClaudeDesktopServers,
  importCursorServers,
  importEnvKey
} from '../services/setup/import'
import {
  fetchMcpRegistry,
  installRegistryServer
} from '../services/setup/mcp-marketplace'
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
import { refreshTray } from '../tray'
import {
  checkForUpdates,
  getUpdaterStatus,
  quitAndInstall
} from '../services/updater'
import type {
  ActionRequest,
  AgentCheckpointCreate,
  AgentCheckpointStatus,
  AgentCheckpointUpdate,
  AgentRequest,
  AgentResult,
  AppearanceConfig,
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
const PICKER_DOC_EXTS = [
  ...PLAIN_TEXT_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS
].map((e) => e.slice(1))
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
  ipcMain.handle(
    'config:set-memory',
    (e, patch: Partial<import('@shared/types').MemoryConfig>) => {
      updateConfig({ memory: { ...getConfig().memory, ...patch } })
      return emitConfig(e.sender.id)
    }
  )
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
    log(key.trim() ? 'success' : 'info', 'system', `API key ${key.trim() ? 'saved' : 'cleared'} for ${provider}.`)
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

  ipcMain.handle(
    'share:save-file',
    (_e, title: string, content: string, extension?: string) =>
      saveToFile(title, content, extension)
  )
  ipcMain.handle(
    'share:gist',
    (_e, title: string, content: string, isPublic: boolean, extension?: string) =>
      uploadGist(title, content, isPublic, extension)
  )

  /* ------------------------------- usage ------------------------------- */

  ipcMain.handle('usage:summary', () => getUsageSummary())
  ipcMain.handle('usage:get-budget', () => getBudgetState())
  ipcMain.handle('usage:set-budget', (_e, monthlyUsd: number | null) => updateBudget(monthlyUsd))
  ipcMain.handle('usage:clear', () => {
    clearUsage()
  })

  /* -------------------------- Agent checkpoints ------------------------ */

  ipcMain.handle('agent-checkpoint:create', (_e, input: AgentCheckpointCreate) =>
    createAgentCheckpoint(input)
  )
  ipcMain.handle(
    'agent-checkpoint:update',
    (_e, requestId: string, patch: AgentCheckpointUpdate) =>
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
  ipcMain.handle('agent-checkpoint:get', (_e, requestId: string) =>
    getAgentCheckpoint(requestId)
  )
  ipcMain.handle('agent-checkpoint:delete', (_e, requestId: string) =>
    deleteAgentCheckpoint(requestId)
  )

  /* ------------------------------- AI ---------------------------------- */

  ipcMain.handle('ai:chat', async (event, req: ChatRequest): Promise<ChatStreamDone> => {
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

  ipcMain.handle('ai:invoke', async (_e, req: AgentRequest): Promise<AgentResult> => {
    const controller = new AbortController()
    registerAbortable(req.requestId, controller)
    log('info', 'ai', `Agent step via ${req.provider} (${req.model}).`)
    try {
      const result = await invokeCompletion(req, controller.signal)
      if (result.error && result.error !== 'aborted') {
        log('error', 'ai', `Agent step failed: ${result.error}`)
      }
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

  ipcMain.handle('screen:capture', () => captureScreen())
  ipcMain.handle('screen:ocr', (_e, source: string) => extractText(source))
  ipcMain.handle('screen:active-window', () => getActiveWindow())

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
  ipcMain.handle(
    'memory:on-user-message',
    (_e, threadId: string, recentMessages: ChatTurn[]) => {
      // Fire-and-forget; we don't await the classifier here.
      void sentimentOnUserMessage(threadId, recentMessages)
      return { ok: true }
    }
  )
  ipcMain.handle('memory:emotional-context', () => getEmotionalContext())
  ipcMain.handle('memory:sentiment-prompt-block', () => buildSentimentPromptBlock())
  ipcMain.handle('memory:recent-sentiments', (_e, limit?: number) =>
    getRecentSentimentHistory(limit)
  )
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
  ipcMain.handle('history:delete-thread', (_e, id: string) => deleteThread(id))
  ipcMain.handle('history:set-active-thread', (_e, id: string) => {
    setActiveThread(id)
  })
  ipcMain.handle('history:set-pinned', (_e, id: string, pinned: boolean) =>
    setThreadPinned(id, pinned)
  )
  ipcMain.handle('history:set-thread-mode', (_e, id: string, mode: ModeId | null) =>
    setThreadMode(id, mode)
  )
  ipcMain.handle(
    'history:set-thread-system-prompt',
    (_e, id: string, prompt: string | null) => setThreadSystemPrompt(id, prompt)
  )
  ipcMain.handle('history:clear-thread', (_e, id: string) => clearThread(id))
  ipcMain.handle('history:clear-all', () => clearAllThreads())

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
  ipcMain.handle('files-rag:scan-status', () => getActiveScan())

  /* --------------------------------- mcp -------------------------------- */

  ipcMain.handle('mcp:list', () => mcpListServers())
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => mcpAddServer(input))
  ipcMain.handle('mcp:remove', (_e, id: string) => mcpRemoveServer(id))
  ipcMain.handle('mcp:set-enabled', (_e, id: string, enabled: boolean) =>
    mcpSetServerEnabled(id, enabled)
  )
  ipcMain.handle('mcp:reconnect', (_e, id: string) => mcpReconnectServer(id))
  ipcMain.handle(
    'mcp:call-tool',
    (_e, name: string, args: Record<string, unknown>) => mcpCallTool(name, args)
  )

  /* --------------------------------- setup ------------------------------ */

  // First-run "we found X on your machine" scan. Pure read — never mutates
  // state or carries raw API-key values across IPC (only previews; see the
  // SetupReport docs in shared/types.ts for the security rationale).
  ipcMain.handle('setup:detect', () => runSetupDetection())

  // Selective imports — caller passes the names from the report it just
  // received. We re-detect inside the import functions so the data can't
  // go stale between the user opening the panel and clicking import.
  ipcMain.handle('setup:import-claude', (_e, names: string[]) =>
    importClaudeDesktopServers(names)
  )
  ipcMain.handle('setup:import-cursor', (_e, names: string[]) =>
    importCursorServers(names)
  )
  // Env-key import reads process.env on this side so the raw key value
  // never has to cross IPC — only the provider id does.
  ipcMain.handle('setup:import-env-key', (_e, providerId: ProviderId) =>
    importEnvKey(providerId)
  )

  // MCP marketplace — fetch the curated registry list and install a
  // selected entry with the user's filled-in args / env.
  ipcMain.handle('mcp:browse-registry', () => fetchMcpRegistry())
  ipcMain.handle(
    'mcp:install-registry',
    (_e, entry: McpRegistryEntry, values: McpInstallValues) =>
      installRegistryServer({ entry, values })
  )

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
      const wav = await piperSynthesise(args)
      // Buffer transfers across IPC as Uint8Array — explicit conversion
      // keeps the wire format predictable across Electron versions.
      return new Uint8Array(wav)
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
  ipcMain.handle('notebook:rename', (_e, id: string, title: string) =>
    renameNotebook(id, title)
  )
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

  ipcMain.handle('wake-word:keyword-dir', () => ensureDataPath('wake-words'))
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
  ipcMain.handle('window:always-on-top', (_e, value: boolean) => {
    setAlwaysOnTop(value)
    setAppearance({ alwaysOnTop: value })
    refreshTray()
  })

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
    async (_e, args: { bytes: ArrayBuffer; name: string }): Promise<string> =>
      extractPdfTextSafe(Buffer.from(args.bytes), args.name)
  )

  ipcMain.handle('system:stats', () => getSystemStats())

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
}
