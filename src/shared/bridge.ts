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
  ProviderPerformance,
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
  ChatTurn,
  EmotionalContextSnapshot,
  MemoryConfig,
  ProactiveVoiceConfig,
  ScreenWatchConfig,
  ScreenWatchStatus,
  SessionSentiment,
  WatchSpec,
  WatchTask,
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
    /** v1.4.0 — patch any subset of the MemoryConfig (emotionalContext
     *  toggle, sentimentModel pin, etc). Merges with existing values. */
    setMemory(patch: Partial<MemoryConfig>): Promise<ClientConfig>
    /** v1.5.0 — patch the proactive-voice master config. Mostly the
     *  master toggle today; will expand if per-task config moves here. */
    setProactiveVoice(patch: Partial<ProactiveVoiceConfig>): Promise<ClientConfig>
    /** v1.7 — patch the screen-watch config. Main re-arms the timer
     *  after applying the patch so cadence changes take effect now. */
    setScreenWatch(patch: Partial<ScreenWatchConfig>): Promise<ClientConfig>
    /** v1.10.1 — patch experimental feature gates (visualClick etc).
     *  Off by default — opt-in for capabilities that work but aren't
     *  yet reliable enough to recommend universally. */
    setExperimentalFeatures(
      patch: Partial<import('./types').ExperimentalFeaturesConfig>
    ): Promise<ClientConfig>
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
    /**
     * v1.4.0 emotional-context hooks.
     *
     * onUserMessage: fire-and-forget after a user message lands; the
     * scheduler counts exchanges and classifies in the background.
     * emotionalContext: snapshot for Settings panel + system prompt.
     * sentimentPromptBlock: pre-rendered block the renderer injects.
     * recentSentiments: history for the Settings rollup view.
     * forgetRecentSentiment: privacy escape hatch — drops the last N
     * days of classifier output (default 7).
     */
    onUserMessage(threadId: string, recentMessages: ChatTurn[]): Promise<{ ok: boolean }>
    emotionalContext(): Promise<EmotionalContextSnapshot>
    sentimentPromptBlock(): Promise<string>
    recentSentiments(limit?: number): Promise<SessionSentiment[]>
    forgetRecentSentiment(days?: number): Promise<{ deleted: number }>
  }
  /** v1.5.0 proactive watch tasks — Soul can initiate without being asked.
   *  All four built-in tasks ship disabled; user opts in via Settings.
   *  v1.6.0: users can create their own custom tasks via `add()` from
   *  the CustomWatchTaskDialog in the Voice settings panel. */
  proactive: {
    list(): Promise<WatchTask[]>
    setEnabled(id: string, enabled: boolean): Promise<WatchTask | null>
    remove(id: string): Promise<{ ok: boolean }>
    /** Chat store fires this on every user send so idle-duration watches
     *  measure from real user activity, not from app start. */
    bumpInteraction(): Promise<{ ok: boolean }>
    /** Create a user-defined watch task. The renderer fully constructs
     *  the spec; main just persists it via the same code path the
     *  boot-time seeder uses for built-ins. */
    add(input: { name: string; spec: WatchSpec; enabled?: boolean }): Promise<WatchTask>
  }
  /** v1.7.3 wake-word state relay across renderer windows. Stores are
   *  per-renderer in Electron, so the Settings-window ArmRow setting
   *  wakeArmed=true does NOTHING for the main-panel useWakeWord hook
   *  unless we explicitly mirror the state. This relay covers BOTH the
   *  arm/listening flags (set by clicks) AND the diagnostic data
   *  (scans/heard) so both windows stay in sync. Any write to any
   *  wake-* field in any window: write locally, then call this; main
   *  rebroadcasts to other windows via wake-diagnostic:update event. */
  wakeDiagnostic: {
    relay(snapshot: {
      armed: boolean
      listening: boolean
      scans: number
      blockedReason: string | null
      heard: Array<{ at: number; text: string; matched: boolean; error?: string }>
    }): Promise<{ ok: boolean }>
  }
  /** v1.8.0 — vision-guided click preview HUD. The preview-window
   *  renderer calls `resolve(token, decision)` when the user cancels or
   *  the countdown elapses; main settles the awaiting Promise and
   *  closes the window. */
  clickPreview: {
    resolve(token: string, decision: 'go' | 'cancel'): Promise<{ ok: boolean }>
  }
  /** v1.7 screen-watch loop — periodic vision observation that may
   *  proactively speak when the model decides there's something
   *  useful to say. Gated by the screenCapture permission + a hard
   *  daily call cap (see config.screenWatch). */
  screenWatch: {
    status(): Promise<ScreenWatchStatus>
    /** Re-arm the loop after a config change (interval / enabled). */
    restart(): Promise<{ ok: boolean }>
    /** One-off "Test now" — runs a tick immediately, returns the
     *  resulting status so the Settings UI can show what Soul saw. */
    observeNow(): Promise<ScreenWatchStatus>
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
    /** v1.11.0 — edit an existing server. Preserves enabled state;
     *  disconnects + restarts the connection so the new command / args
     *  take effect immediately. */
    update(id: string, input: McpServerInput): Promise<McpServerStatus | null>
    /** v1.11.0 — fetch the full persisted config (incl. command / args /
     *  env) for prefilling the Edit form. listServers() doesn't include
     *  these because the status surface stays small for the bulk path. */
    getConfig(id: string): Promise<import('./types').McpServerConfig | null>
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
    /** v1.12.0 — per-provider performance aggregate over the last `days`.
     *  Powers the Provider Performance dashboard in Settings → Usage. */
    providerPerformance(days: number): Promise<ProviderPerformance[]>
    getBudget(): Promise<UsageBudget>
    setBudget(
      monthlyUsd: number | null,
      opts?: { currency?: string; usdRate?: number }
    ): Promise<UsageBudget>
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
  /** Per-thread document export — distinct from the whole-app `sync` bundle.
   *  Renderer picks a thread + format; main process renders + shows save
   *  dialog + writes the file. Result message is user-facing. */
  threadExport: {
    save(args: {
      threadId: string
      format: 'markdown' | 'txt' | 'html' | 'docx' | 'xlsx' | 'pdf'
    }): Promise<{ ok: boolean; message: string; path?: string }>
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
    /** Fetch the curated MCP server registry from the project repo.
     *  Pass `{ force: true }` to bypass the in-process 30s cache — wired
     *  to the in-dialog Refresh button so a manual refresh re-fetches
     *  instead of silently returning cached data. */
    browse(opts?: { force?: boolean }): Promise<McpRegistryEntry[]>
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
     *
     * Optional `tone` (v1.3.0+) selects a Piper parameter preset that
     * shapes length_scale + noise_scale + noise_w to give the voice
     * personality (casual / focused / excited / serious / dry). Stacks
     * UNDER the user's `rate` setting.
     */
    synthesise(args: {
      persona: VoicePersona
      text: string
      rate?: number
      tone?: import('./voiceMarkers').ToneTag
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
    /** Fired when an in-flight completion hit a retryable error on the
     *  selected provider and the dispatcher silently swapped to another
     *  configured one. UI surfaces this as a transient toast so the user
     *  knows their reply is coming from a different model than they picked. */
    onProviderFallback(
      cb: (info: {
        from: ProviderId
        fromLabel: string
        to: ProviderId
        toLabel: string
        reason: string
      }) => void
    ): Unsubscribe
    /** v1.5.0 — a proactive watch task tripped its condition and wants
     *  Soul to speak. Renderer queues `content` through the standard
     *  Web Audio path with the supplied tone. `dynamicRecap` true means
     *  the renderer should generate content from chat history instead of
     *  using `content` verbatim (used by Morning recap). */
    onProactiveSpeak(
      cb: (info: {
        taskId: string
        taskName: string
        content: string
        tone: import('./voiceMarkers').ToneTag
        allowInterrupt: boolean
        dynamicRecap: boolean
      }) => void
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
    /** v1.7.3 — wake-word diagnostic snapshots from the main panel
     *  renderer (where the engine runs). Settings window subscribes
     *  so its diagnostic panel mirrors the engine's actual state
     *  instead of staring at its own empty per-renderer store. */
    onWakeDiagnostic(
      cb: (snapshot: {
        armed: boolean
        listening: boolean
        scans: number
        blockedReason: string | null
        heard: Array<{ at: number; text: string; matched: boolean; error?: string }>
      }) => void
    ): Unsubscribe
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
    /**
     * v1.9.0 — vision-click locate failed (either UIA + vision both
     * missed, screenshot failed, or the click itself errored). Payload
     * carries the user's description + a short reason. The renderer
     * pushes a toast so the user SEES the failure rather than staring
     * at a "✓ tool dispatched" with no visible action.
     *
     * v1.9.1 — also doubles as a progress channel. When `progress: true`
     * the reason is a status message ("Looking for X…", "Asking the
     * model…") and the renderer surfaces it as an info toast instead
     * of an error toast.
     */
    onVisualClickFailure(
      cb: (info: { description: string; reason: string; progress?: boolean }) => void
    ): Unsubscribe
  }
}
