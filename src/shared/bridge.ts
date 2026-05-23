/**
 * The contract for `window.voidsoul` — the single, typed bridge the renderer
 * uses to reach every main-process capability. Implemented by the preload
 * script and consumed throughout the renderer.
 */
import type { PermissionId, PermissionState } from './permissions'
import type {
  ActionDescriptor,
  ActionRequest,
  ActionResult,
  ActiveWindowInfo,
  AgentCheckpoint,
  AgentCheckpointCreate,
  AgentCheckpointStatus,
  AgentCheckpointUpdate,
  AgentRequest,
  AgentResult,
  AppearanceConfig,
  ChatMessage,
  ChatRequest,
  HistorySummary,
  IndexedFileSummary,
  IndexedFolder,
  McpServerInput,
  McpServerStatus,
  MessageSearchHit,
  Notebook,
  Project,
  NotebookSummary,
  ScanProgress,
  ScanResult,
  ScheduledTask,
  ThreadSummary,
  UsageBudget,
  UsageSummary,
  ChatStreamChunk,
  ChatStreamDone,
  ClientConfig,
  CustomPrompt,
  EmbeddingProvider,
  FavoriteApp,
  LogCategory,
  LogEntry,
  MemoryState,
  CustomActionKind,
  ModeId,
  OcrResult,
  McpInstallValues,
  McpMarketplaceInstallResult,
  McpRegistryEntry,
  PluginInfo,
  PluginManifest,
  PluginRegistryEntry,
  ProviderId,
  QuickAction,
  RecentProject,
  ScreenshotResult,
  SetupEnvKeyImportResult,
  SetupImportResult,
  SetupReport,
  SyncResult,
  SystemStats,
  VoicePersona,
  VoiceSetupStatus,
  UpdaterStatus,
  UserFact,
  VoiceConfig
} from './types'

export interface PickedFile {
  path: string
  name: string
  kind: 'image' | 'text' | 'pdf'
  dataUrl?: string
  text?: string
}

export interface AppInfo {
  version: string
  platform: string
  electron: string
}

export type Unsubscribe = () => void

export interface VoidSoulBridge {
  config: {
    get(): Promise<ClientConfig>
    setActiveProvider(provider: ProviderId): Promise<ClientConfig>
    setProvider(
      provider: ProviderId,
      patch: { model?: string; baseUrl?: string }
    ): Promise<ClientConfig>
    setActiveMode(mode: ModeId): Promise<ClientConfig>
    setSystemPrompt(prompt: string): Promise<ClientConfig>
    setAppearance(patch: Partial<AppearanceConfig>): Promise<ClientConfig>
    setVoice(patch: Partial<VoiceConfig>): Promise<ClientConfig>
    setAgentMode(enabled: boolean): Promise<ClientConfig>
    setAutoMemory(enabled: boolean): Promise<ClientConfig>
    setPrivateChat(enabled: boolean): Promise<ClientConfig>
    setRagEnabled(enabled: boolean): Promise<ClientConfig>
    setEmbeddingProvider(provider: EmbeddingProvider): Promise<ClientConfig>
    setOnboarded(value: boolean): Promise<ClientConfig>
    setApiKey(provider: ProviderId, key: string): Promise<ClientConfig>
  }
  ai: {
    chat(req: ChatRequest): Promise<ChatStreamDone>
    invoke(req: AgentRequest): Promise<AgentResult>
    abort(requestId: string): Promise<void>
    listModels(provider: ProviderId): Promise<string[]>
    /**
     * Transcribes a clip of speech. The renderer ships 16kHz mono PCM (the
     * format Whisper natively wants); main routes to OpenAI Whisper or Gemini
     * if keyed, else the local Transformers.js Whisper pipeline.
     */
    transcribe(audio: {
      pcm: Float32Array
      sampleRate: number
    }): Promise<{ text: string; error?: string }>
  }
  permissions: {
    get(): Promise<Record<PermissionId, PermissionState>>
    set(id: PermissionId, granted: boolean): Promise<Record<PermissionId, PermissionState>>
    revokeAll(): Promise<Record<PermissionId, PermissionState>>
  }
  automation: {
    execute(req: ActionRequest): Promise<ActionResult>
    undo(undoId: string): Promise<{ ok: boolean; message: string }>
    list(): Promise<ActionDescriptor[]>
  }
  screen: {
    capture(): Promise<ScreenshotResult>
    ocr(source: string): Promise<OcrResult>
    activeWindow(): Promise<ActiveWindowInfo>
  }
  memory: {
    get(): Promise<MemoryState>
    rememberProject(path: string): Promise<RecentProject[]>
    forgetProject(path: string): Promise<RecentProject[]>
    addFavorite(label: string, target: string): Promise<FavoriteApp[]>
    removeFavorite(id: string): Promise<FavoriteApp[]>
    importTaskbar(): Promise<FavoriteApp[]>
    addPrompt(label: string, prompt: string): Promise<CustomPrompt[]>
    removePrompt(id: string): Promise<CustomPrompt[]>
    addAction(label: string, kind: CustomActionKind, target: string): Promise<QuickAction[]>
    removeAction(id: string): Promise<QuickAction[]>
    addFact(text: string, modes?: ModeId[]): Promise<UserFact[]>
    updateFact(id: string, text: string): Promise<UserFact[]>
    setFactModes(id: string, modes: ModeId[]): Promise<UserFact[]>
    removeFact(id: string): Promise<UserFact[]>
    clearFacts(): Promise<UserFact[]>
  }
  history: {
    /** Lightweight thread list (no message bodies). */
    summaries(): Promise<{ summaries: ThreadSummary[]; activeThreadId: string | null }>
    /** Loads one thread's messages on demand. */
    getMessages(id: string): Promise<ChatMessage[]>
    /** Full-text search across every thread's messages (capped at 200 hits). */
    search(query: string): Promise<MessageSearchHit[]>
    saveThread(
      threadId: string,
      messages: ChatMessage[],
      summary?: HistorySummary | null
    ): Promise<ThreadSummary | null>
    /**
     * Acks main's `events.onFlushPending` signal. The token must match the
     * value main sent so a stale ack from a previous flush window can't
     * release a newer one.
     */
    flushAllAck(token: string): Promise<void>
    createThread(title?: string): Promise<ThreadSummary>
    renameThread(id: string, title: string): Promise<ThreadSummary | null>
    deleteThread(
      id: string
    ): Promise<{ summaries: ThreadSummary[]; activeThreadId: string | null }>
    setActiveThread(id: string): Promise<void>
    setPinned(id: string, pinned: boolean): Promise<ThreadSummary | null>
    /** Pin a mode override on this thread; pass null to fall back to global. */
    setThreadMode(id: string, mode: ModeId | null): Promise<ThreadSummary | null>
    /** Pin a system-prompt override on this thread; pass null to fall back to global. */
    setThreadSystemPrompt(
      id: string,
      prompt: string | null
    ): Promise<ThreadSummary | null>
    clearThread(id: string): Promise<ThreadSummary | null>
    clearAll(): Promise<{ summaries: ThreadSummary[]; activeThreadId: string | null }>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: { name: string; description?: string | null; instructions?: string | null }): Promise<Project>
    update(
      id: string,
      patch: { name?: string; description?: string | null; instructions?: string | null }
    ): Promise<Project | null>
    delete(id: string): Promise<Project[]>
    /** Move a thread into a project (or pass null to unfile it). */
    setThreadProject(threadId: string, projectId: string | null): Promise<ThreadSummary | null>
  }
  mcp: {
    list(): Promise<McpServerStatus[]>
    add(input: McpServerInput): Promise<McpServerStatus>
    remove(id: string): Promise<McpServerStatus[]>
    setEnabled(id: string, enabled: boolean): Promise<McpServerStatus | null>
    reconnect(id: string): Promise<McpServerStatus | null>
    callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>
  }
  secrets: {
    set(id: string, value: string): Promise<boolean>
    has(id: string): Promise<boolean>
    /**
     * Reads a stored secret. Only allowlisted ids (currently `picovoice`)
     * return a value — others return null. Used by the wake-word engine,
     * which has to construct itself in the renderer.
     */
    get(id: string): Promise<string | null>
  }
  share: {
    saveFile(
      title: string,
      content: string,
      extension?: string
    ): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>
    gist(
      title: string,
      content: string,
      isPublic: boolean,
      extension?: string
    ): Promise<{ ok: boolean; url?: string; id?: string; error?: string }>
  }
  usage: {
    summary(): Promise<UsageSummary>
    getBudget(): Promise<UsageBudget>
    setBudget(monthlyUsd: number | null): Promise<UsageBudget>
    clear(): Promise<void>
  }
  /**
   * Persistent agent-loop checkpoints. The renderer writes one row when
   * a multi-step agent run starts, updates it on every step with the
   * latest turns + invocations, and finalises it to a terminal status
   * on exit. On next launch, `listStale()` returns any row still at
   * `running` — those are crash-recovery candidates the UI offers to
   * resume.
   */
  agentCheckpoint: {
    create(input: AgentCheckpointCreate): Promise<void>
    update(requestId: string, patch: AgentCheckpointUpdate): Promise<void>
    finalize(
      requestId: string,
      status: Exclude<AgentCheckpointStatus, 'running'>,
      failure: string | null
    ): Promise<void>
    listStale(): Promise<AgentCheckpoint[]>
    get(requestId: string): Promise<AgentCheckpoint | null>
    delete(requestId: string): Promise<void>
  }
  rag: {
    status(): Promise<{
      available: boolean
      indexed: number
      backfill?: { done: number; total: number }
    }>
    search(
      query: string,
      options?: { limit?: number; excludeIds?: string[]; source?: 'chat' | 'file' }
    ): Promise<
      Array<{
        messageId: string
        source: 'chat' | 'file'
        threadId?: string | null
        filePath?: string | null
        chunkIndex?: number | null
        preview: string
        role: 'user' | 'assistant' | 'file'
        createdAt: string
        score: number
      }>
    >
    backfill(): Promise<number>
    clear(): Promise<void>
  }
  filesRag: {
    listFolders(): Promise<IndexedFolder[]>
    listFiles(folder: string): Promise<IndexedFileSummary[]>
    addFolder(): Promise<{
      ok: boolean
      folders: IndexedFolder[]
      folder?: string
      /** Present when `ok` is false — e.g. the picked folder didn't exist. */
      error?: string
    }>
    removeFolder(folder: string): Promise<IndexedFolder[]>
    rescan(folder: string): Promise<{ ok: boolean }>
    rescanAll(): Promise<{ ok: boolean }>
    scanStatus(): Promise<ScanProgress | null>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]>
    reload(): Promise<PluginInfo[]>
    actions(): Promise<QuickAction[]>
    openFolder(): Promise<void>
    /** Fetch the curated public registry of community plugins. */
    browse(): Promise<PluginRegistryEntry[]>
    /** Install a manifest (typically one returned by `browse()`). */
    install(manifest: PluginManifest): Promise<PluginInfo[]>
  }
  notebook: {
    list(): Promise<NotebookSummary[]>
    get(id: string): Promise<Notebook | null>
    create(title?: string): Promise<Notebook>
    save(notebook: Notebook): Promise<Notebook>
    rename(id: string, title: string): Promise<NotebookSummary | null>
    delete(id: string): Promise<NotebookSummary[]>
    runCell(notebookId: string, cellId: string): Promise<Notebook | null>
    runAll(id: string): Promise<Notebook | null>
  }
  scheduler: {
    list(): Promise<ScheduledTask[]>
    add(input: {
      name: string
      prompt: string
      scheduleKind: 'daily' | 'interval' | 'once'
      scheduleValue: string
    }): Promise<ScheduledTask>
    remove(id: string): Promise<void>
    setEnabled(id: string, enabled: boolean): Promise<ScheduledTask | null>
    runNow(id: string): Promise<ScheduledTask | null>
  }
  logs: {
    get(): Promise<LogEntry[]>
    clear(): Promise<void>
    /**
     * Push a structured log entry from the renderer into the main log store.
     * Used by renderer-side catch sites (fact extraction, summarisation, RAG
     * injection) so silent failures become visible in the Logs view.
     */
    write(
      level: 'info' | 'success' | 'warn' | 'error',
      category: LogCategory,
      message: string,
      detail?: string
    ): Promise<LogEntry>
  }
  sync: {
    export(): Promise<SyncResult>
    import(): Promise<SyncResult>
    chooseFolder(): Promise<ClientConfig>
    clearFolder(): Promise<ClientConfig>
    push(): Promise<SyncResult>
    pull(): Promise<SyncResult>
  }
  window: {
    setExpanded(expanded: boolean): Promise<boolean>
    moveBy(dx: number, dy: number): Promise<void>
    hide(): Promise<void>
    setAlwaysOnTop(value: boolean): Promise<void>
    /** Opens (or focuses) the dedicated Settings window. */
    openSettings(): Promise<void>
    /** Closes the Settings window if it's open. */
    closeSettings(): Promise<void>
    /**
     * Closes the Settings window, shows the main window, and broadcasts an
     * event that the main renderer listens to to open the cross-thread
     * search dialog. Used by Cmd+F inside the Settings window — the
     * dialog can't live in Settings because the chat state it queries
     * lives in the main window's renderer.
     */
    openGlobalSearch(): Promise<void>
  }
  updater: {
    /** Live snapshot of the updater state. */
    status(): Promise<UpdaterStatus>
    /** Manually trigger an update check. Returns the post-check status. */
    check(): Promise<UpdaterStatus>
    /** Restart and install — no-op unless an update is downloaded. */
    quitAndInstall(): Promise<void>
  }
  wakeWord: {
    /** Returns the absolute path to the folder users drop .ppn files in. */
    keywordDir(): Promise<string>
    /** Opens that folder in the OS file explorer. */
    openFolder(): Promise<string>
    /** Base64-encoded .ppn bytes for the persona, or null if absent. */
    keywordBytes(persona: 'void' | 'soul'): Promise<string | null>
  }
  system: {
    pickFile(opts?: { images?: boolean }): Promise<PickedFile | null>
    pickFolder(): Promise<string | null>
    openDataFolder(): Promise<void>
    /** Extracts text from raw PDF bytes (used by drag-drop, which has no parser). */
    parsePdf(args: { bytes: ArrayBuffer; name: string }): Promise<string>
    info(): Promise<AppInfo>
    stats(): Promise<SystemStats>
  }
  setup: {
    /**
     * Scan the machine for already-configured AI tools — Claude Desktop,
     * Cursor, ChatGPT Desktop, env-var API keys, local providers. Returns
     * a structured report the first-run panel + "Import" buttons render
     * from. Pure read; never carries raw API keys (only previews).
     */
    detect(): Promise<SetupReport>
    /** Selectively import named MCP servers from Claude Desktop's config. */
    importClaudeServers(names: string[]): Promise<SetupImportResult>
    /** Selectively import named MCP servers from Cursor's MCP config. */
    importCursorServers(names: string[]): Promise<SetupImportResult>
    /**
     * Import an API key for the given provider from `process.env`.
     * Reads the secret on the main side so it never crosses IPC as
     * plaintext — only the provider id does.
     */
    importEnvKey(providerId: ProviderId): Promise<SetupEnvKeyImportResult>
  }
  mcpMarketplace: {
    /** Fetch the curated MCP server registry from the project repo. */
    browse(): Promise<McpRegistryEntry[]>
    /**
     * Install a registry entry. `values.args` fills the `{KEY}` tokens
     * in `entry.args`; `values.env` is merged on top of `entry.env`.
     * Returns `{ ok: false, error }` on missing prompts or addServer
     * failure, `{ ok: true, status }` on success or already-installed.
     */
    install(
      entry: McpRegistryEntry,
      values: McpInstallValues
    ): Promise<McpMarketplaceInstallResult>
  }
  voice: {
    /** Snapshot of binary availability + installed Void/Soul voices. */
    status(): Promise<VoiceSetupStatus>
    /**
     * Synthesise a chunk of text via Piper. Returns WAV bytes as a
     * Uint8Array — the renderer wraps in a Blob URL + plays via the
     * standard HTMLAudioElement queue.
     */
    synthesise(args: {
      persona: VoicePersona
      text: string
      rate?: number
    }): Promise<Uint8Array>
    /** Opens the per-user voices folder in the OS file explorer. */
    openFolder(): Promise<string>
    /**
     * One-shot copy of any `Voices/` folder at the repo root into the
     * canonical per-user voices/ folder. Called on first launch so the
     * dev's manually-placed Piper voices land in the right place
     * automatically.
     */
    migrateLegacy(): Promise<{ copied: number }>
  }
  events: {
    onChunk(cb: (chunk: ChatStreamChunk) => void): Unsubscribe
    onLog(cb: (entry: LogEntry) => void): Unsubscribe
    onLogCleared(cb: () => void): Unsubscribe
    onActiveWindow(cb: (info: ActiveWindowInfo) => void): Unsubscribe
    /** Fired when the global summon hotkey is pressed. */
    onSummon(cb: (intent: 'expand' | 'toggle') => void): Unsubscribe
    /** Fired when the Settings window asks the main window to open the
     *  cross-thread search dialog. See `window.openGlobalSearch`. */
    onOpenGlobalSearch(cb: () => void): Unsubscribe
    /** Fires on every updater lifecycle transition (checking → available
     *  → downloading → downloaded, plus errors). The renderer can derive
     *  the entire UI state from this stream. */
    onUpdaterStatus(cb: (status: UpdaterStatus) => void): Unsubscribe
    /** Fired when a configured monthly budget threshold (75/90/100%) is first crossed. */
    onBudgetWarning(
      cb: (info: { level: 75 | 90 | 100; total: number; budget: number }) => void
    ): Unsubscribe
    /** Fired when a `listModels` call discovers model ids never seen before. */
    onNewModels(
      cb: (info: { provider: ProviderId; models: string[] }) => void
    ): Unsubscribe
    /** Fired while a file-RAG scan walks the folder; nullable on completion. */
    onFilesRagProgress(cb: (progress: ScanProgress) => void): Unsubscribe
    /** Fired when a file-RAG scan run finishes (single folder or all). */
    onFilesRagDone(cb: (result: ScanResult | null) => void): Unsubscribe
    /**
     * Fired whenever ANY config-mutating IPC handler finishes. Both the
     * floating panel and the Settings window subscribe to keep their copy
     * of `ClientConfig` in sync — without this, editing in one window
     * leaves the other showing the old values.
     */
    onConfigUpdated(cb: (config: ClientConfig) => void): Unsubscribe
    /** Tray asked us to switch to a specific panel tab. */
    onTrayOpenTab(cb: (tab: 'nexus' | 'chat' | 'logs') => void): Unsubscribe
    /** Tray fired a saved quick prompt — renderer sends it as a chat turn. */
    onTrayRunPrompt(cb: (info: { prompt: string; label: string }) => void): Unsubscribe
    /** Fired when a scheduled task fires; payload is the run result. */
    onScheduledTaskRan(
      cb: (info: {
        id: string
        name: string
        ok: boolean
        output: string
        /** True iff the scheduler suppressed its OS notification due to DND. */
        suppressed?: boolean
      }) => void
    ): Unsubscribe
    /**
     * Main signals "we're about to quit — flush any debounced state to disk
     * NOW". Renderer calls `history.flushAllAck(token)` when done so main
     * can proceed without losing the in-flight save window.
     */
    onFlushPending(cb: (token: string) => void): Unsubscribe
    /**
     * Global hotkey (Ctrl/Cmd+Shift+J by default) fired — the renderer
     * opens the Quick AI overlay. No payload; the overlay handles all UI
     * and the chat IPC.
     */
    onQuickAiOpen(cb: () => void): Unsubscribe
  }
}
