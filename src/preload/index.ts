/**
 * Preload bridge. Exposes a single, frozen, typed `window.voidsoul` object to
 * the renderer via contextBridge. The renderer has no Node integration — this
 * is the only channel through which it can reach the main process.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Unsubscribe, VoidSoulBridge } from '@shared/bridge'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: VoidSoulBridge = {
  config: {
    get: () => invoke('config:get'),
    setActiveProvider: (provider) => invoke('config:set-active-provider', provider),
    setProvider: (provider, patch) => invoke('config:set-provider', provider, patch),
    setActiveMode: (mode) => invoke('config:set-active-mode', mode),
    setSystemPrompt: (prompt) => invoke('config:set-system-prompt', prompt),
    setAppearance: (patch) => invoke('config:set-appearance', patch),
    setVoice: (patch) => invoke('config:set-voice', patch),
    setAgentMode: (enabled) => invoke('config:set-agent-mode', enabled),
    setAutoMemory: (enabled) => invoke('config:set-auto-memory', enabled),
    setPrivateChat: (enabled) => invoke('config:set-private-chat', enabled),
    setRagEnabled: (enabled) => invoke('config:set-rag-enabled', enabled),
    setMemory: (patch) => invoke('config:set-memory', patch),
    setProactiveVoice: (patch) => invoke('config:set-proactive-voice', patch),
    setScreenWatch: (patch) => invoke('config:set-screen-watch', patch),
    setExperimentalFeatures: (patch) => invoke('config:set-experimental-features', patch),
    setEmbeddingProvider: (provider) =>
      invoke('config:set-embedding-provider', provider),
    setOnboarded: (value) => invoke('config:set-onboarded', value),
    setApiKey: (provider, key) => invoke('config:set-api-key', provider, key)
  },
  ai: {
    chat: (req) => invoke('ai:chat', req),
    invoke: (req) => invoke('ai:invoke', req),
    abort: (requestId) => invoke('ai:abort', requestId),
    listModels: (provider) => invoke('ai:list-models', provider),
    transcribe: (audio) => invoke('ai:transcribe', audio)
  },
  permissions: {
    get: () => invoke('permissions:get'),
    set: (id, granted) => invoke('permissions:set', id, granted),
    revokeAll: () => invoke('permissions:revoke-all')
  },
  automation: {
    execute: (req) => invoke('automation:execute', req),
    undo: (undoId) => invoke('automation:undo', undoId),
    list: () => invoke('automation:list')
  },
  screen: {
    capture: () => invoke('screen:capture'),
    ocr: (source) => invoke('screen:ocr', source),
    activeWindow: () => invoke('screen:active-window')
  },
  memory: {
    get: () => invoke('memory:get'),
    rememberProject: (path) => invoke('memory:remember-project', path),
    forgetProject: (path) => invoke('memory:forget-project', path),
    addFavorite: (label, target) => invoke('memory:add-favorite', label, target),
    removeFavorite: (id) => invoke('memory:remove-favorite', id),
    importTaskbar: () => invoke('memory:import-taskbar'),
    addPrompt: (label, prompt) => invoke('memory:add-prompt', label, prompt),
    removePrompt: (id) => invoke('memory:remove-prompt', id),
    addAction: (label, kind, target) => invoke('memory:add-action', label, kind, target),
    removeAction: (id) => invoke('memory:remove-action', id),
    addFact: (text, modes) => invoke('memory:add-fact', text, modes),
    updateFact: (id, text) => invoke('memory:update-fact', id, text),
    setFactModes: (id, modes) => invoke('memory:set-fact-modes', id, modes),
    removeFact: (id) => invoke('memory:remove-fact', id),
    clearFacts: () => invoke('memory:clear-facts'),
    // v1.4.0 emotional context — see services/memory/sentiment*.
    onUserMessage: (threadId, recentMessages) =>
      invoke('memory:on-user-message', threadId, recentMessages),
    emotionalContext: () => invoke('memory:emotional-context'),
    sentimentPromptBlock: () => invoke('memory:sentiment-prompt-block'),
    recentSentiments: (limit) => invoke('memory:recent-sentiments', limit),
    forgetRecentSentiment: (days) => invoke('memory:forget-recent-sentiment', days)
  },
  proactive: {
    list: () => invoke('proactive:list'),
    setEnabled: (id, enabled) => invoke('proactive:set-enabled', id, enabled),
    remove: (id) => invoke('proactive:remove', id),
    bumpInteraction: () => invoke('proactive:bump-interaction'),
    add: (input) => invoke('proactive:add', input)
  },
  wakeDiagnostic: {
    relay: (snapshot) => invoke('wake-diagnostic:relay', snapshot)
  },
  clickPreview: {
    // v1.8.0 — preview HUD resolution. The preview-window renderer calls
    // this with its token and the user's decision; main settles the
    // awaiting Promise and closes the window.
    resolve: (token, decision) => invoke('click-preview:resolve', token, decision)
  },
  screenWatch: {
    status: () => invoke('screen-watch:status'),
    restart: () => invoke('screen-watch:restart'),
    observeNow: () => invoke('screen-watch:observe-now')
  },
  history: {
    summaries: () => invoke('history:summaries'),
    getMessages: (id) => invoke('history:get-thread-messages', id),
    search: (query) => invoke('history:search', query),
    saveThread: (threadId, messages, summary) =>
      invoke('history:save-thread', threadId, messages, summary),
    flushAllAck: (token) => invoke('history:flush-all-ack', token),
    createThread: (title) => invoke('history:create-thread', title),
    renameThread: (id, title) => invoke('history:rename-thread', id, title),
    deleteThread: (id) => invoke('history:delete-thread', id),
    setActiveThread: (id) => invoke('history:set-active-thread', id),
    setPinned: (id, pinned) => invoke('history:set-pinned', id, pinned),
    setThreadMode: (id, mode) => invoke('history:set-thread-mode', id, mode),
    setThreadSystemPrompt: (id, prompt) =>
      invoke('history:set-thread-system-prompt', id, prompt),
    clearThread: (id) => invoke('history:clear-thread', id),
    clearAll: () => invoke('history:clear-all')
  },
  projects: {
    list: () => invoke('projects:list'),
    create: (input) => invoke('projects:create', input),
    update: (id, patch) => invoke('projects:update', id, patch),
    delete: (id) => invoke('projects:delete', id),
    setThreadProject: (threadId, projectId) =>
      invoke('projects:set-thread-project', threadId, projectId)
  },
  mcp: {
    list: () => invoke('mcp:list'),
    add: (input) => invoke('mcp:add', input),
    remove: (id) => invoke('mcp:remove', id),
    setEnabled: (id, enabled) => invoke('mcp:set-enabled', id, enabled),
    reconnect: (id) => invoke('mcp:reconnect', id),
    callTool: (name, args) => invoke('mcp:call-tool', name, args)
  },
  secrets: {
    set: (id, value) => invoke('secrets:set', id, value),
    has: (id) => invoke('secrets:has', id),
    get: (id) => invoke('secrets:get', id)
  },
  share: {
    saveFile: (title, content, extension) =>
      invoke('share:save-file', title, content, extension),
    gist: (title, content, isPublic, extension) =>
      invoke('share:gist', title, content, isPublic, extension)
  },
  usage: {
    summary: () => invoke('usage:summary'),
    getBudget: () => invoke('usage:get-budget'),
    setBudget: (monthlyUsd) => invoke('usage:set-budget', monthlyUsd),
    clear: () => invoke('usage:clear')
  },
  agentCheckpoint: {
    create: (input) => invoke('agent-checkpoint:create', input),
    update: (requestId, patch) => invoke('agent-checkpoint:update', requestId, patch),
    finalize: (requestId, status, failure) =>
      invoke('agent-checkpoint:finalize', requestId, status, failure),
    listStale: () => invoke('agent-checkpoint:list-stale'),
    get: (requestId) => invoke('agent-checkpoint:get', requestId),
    delete: (requestId) => invoke('agent-checkpoint:delete', requestId)
  },
  rag: {
    status: () => invoke('rag:status'),
    search: (query, options) => invoke('rag:search', query, options),
    backfill: () => invoke('rag:backfill'),
    clear: () => invoke('rag:clear')
  },
  filesRag: {
    listFolders: () => invoke('files-rag:list-folders'),
    listFiles: (folder) => invoke('files-rag:list-files', folder),
    addFolder: () => invoke('files-rag:add-folder'),
    removeFolder: (folder) => invoke('files-rag:remove-folder', folder),
    rescan: (folder) => invoke('files-rag:rescan', folder),
    rescanAll: () => invoke('files-rag:rescan-all'),
    scanStatus: () => invoke('files-rag:scan-status')
  },
  plugins: {
    list: () => invoke('plugins:list'),
    setEnabled: (id, enabled) => invoke('plugins:set-enabled', id, enabled),
    reload: () => invoke('plugins:reload'),
    actions: () => invoke('plugins:actions'),
    openFolder: () => invoke('plugins:open-folder'),
    browse: () => invoke('plugins:browse'),
    install: (manifest) => invoke('plugins:install', manifest)
  },
  notebook: {
    list: () => invoke('notebook:list'),
    get: (id) => invoke('notebook:get', id),
    create: (title) => invoke('notebook:create', title),
    save: (notebook) => invoke('notebook:save', notebook),
    rename: (id, title) => invoke('notebook:rename', id, title),
    delete: (id) => invoke('notebook:delete', id),
    runCell: (notebookId, cellId) => invoke('notebook:run-cell', notebookId, cellId),
    runAll: (id) => invoke('notebook:run-all', id)
  },
  scheduler: {
    list: () => invoke('scheduler:list'),
    add: (input) => invoke('scheduler:add', input),
    remove: (id) => invoke('scheduler:remove', id),
    setEnabled: (id, enabled) => invoke('scheduler:set-enabled', id, enabled),
    runNow: (id) => invoke('scheduler:run-now', id)
  },
  logs: {
    get: () => invoke('logs:get'),
    clear: () => invoke('logs:clear'),
    write: (level, category, message, detail) =>
      invoke('logs:write', level, category, message, detail)
  },
  sync: {
    export: () => invoke('sync:export'),
    import: () => invoke('sync:import'),
    chooseFolder: () => invoke('sync:choose-folder'),
    clearFolder: () => invoke('sync:clear-folder'),
    push: () => invoke('sync:push'),
    pull: () => invoke('sync:pull')
  },
  threadExport: {
    save: (args) => invoke('thread:export', args)
  },
  window: {
    setExpanded: (expanded) => invoke('window:set-expanded', expanded),
    moveBy: (dx, dy) => invoke('window:move-by', dx, dy),
    hide: () => invoke('window:hide'),
    setAlwaysOnTop: (value) => invoke('window:always-on-top', value),
    openSettings: () => invoke('window:open-settings'),
    closeSettings: () => invoke('window:close-settings'),
    openGlobalSearch: () => invoke('window:open-global-search')
  },
  updater: {
    status: () => invoke('updater:status'),
    check: () => invoke('updater:check'),
    quitAndInstall: () => invoke('updater:quit-and-install')
  },
  wakeWord: {
    keywordDir: () => invoke('wake-word:keyword-dir'),
    openFolder: () => invoke('wake-word:open-folder'),
    keywordBytes: (persona) => invoke('wake-word:keyword-bytes', persona)
  },
  system: {
    pickFile: (opts) => invoke('system:pick-file', opts),
    pickFolder: () => invoke('system:pick-folder'),
    openDataFolder: () => invoke('system:open-data-folder'),
    parsePdf: (args) => invoke('system:parse-pdf', args),
    info: () => invoke('app:info'),
    stats: () => invoke('system:stats')
  },
  setup: {
    detect: () => invoke('setup:detect'),
    importClaudeServers: (names) => invoke('setup:import-claude', names),
    importCursorServers: (names) => invoke('setup:import-cursor', names),
    importEnvKey: (providerId) => invoke('setup:import-env-key', providerId)
  },
  mcpMarketplace: {
    browse: () => invoke('mcp:browse-registry'),
    install: (entry, values) => invoke('mcp:install-registry', entry, values)
  },
  voice: {
    status: () => invoke('voice:status'),
    synthesise: (args) => invoke('voice:synthesise', args),
    openFolder: () => invoke('voice:open-folder'),
    migrateLegacy: () => invoke('voice:migrate-legacy')
  },
  events: {
    onChunk: (cb) => subscribe('ai:chunk', cb),
    onLog: (cb) => subscribe('log:new', cb),
    onLogCleared: (cb) => subscribe('log:cleared', () => cb()),
    onActiveWindow: (cb) => subscribe('screen:active-window', cb),
    onSummon: (cb) => subscribe('widget:summon', cb),
    onOpenGlobalSearch: (cb) => subscribe('widget:open-global-search', () => cb()),
    onUpdaterStatus: (cb) => subscribe('updater:status', cb),
    onBudgetWarning: (cb) => subscribe('usage:budget-warning', cb),
    onNewModels: (cb) => subscribe('ai:new-models', cb),
    onProviderFallback: (cb) => subscribe('ai:fallback', cb),
    onProactiveSpeak: (cb) => subscribe('voice:proactive-speak', cb),
    onFilesRagProgress: (cb) => subscribe('files-rag:progress', cb),
    onFilesRagDone: (cb) => subscribe('files-rag:done', cb),
    onConfigUpdated: (cb) => subscribe('config:updated', cb),
    onWakeDiagnostic: (cb) => subscribe('wake-diagnostic:update', cb),
    onTrayOpenTab: (cb) => subscribe('tray:open-tab', cb),
    onTrayRunPrompt: (cb) => subscribe('tray:run-prompt', cb),
    onScheduledTaskRan: (cb) => subscribe('scheduler:task-ran', cb),
    onFlushPending: (cb) => subscribe('app:flush-pending', cb),
    onQuickAiOpen: (cb) => subscribe('quick-ai:open', cb),
    onVisualClickFailure: (cb) => subscribe('visual-click:failure', cb)
  }
}

contextBridge.exposeInMainWorld('voidsoul', bridge)
