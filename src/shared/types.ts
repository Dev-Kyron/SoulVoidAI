/**
 * Core data contracts shared by the main process, preload bridge and renderer.
 * Keep this file free of any Node or DOM APIs so all three build targets can
 * import it safely.
 */
import type { PermissionId, PermissionState } from './permissions'

/* ----------------------------- AI providers ----------------------------- */

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'groq'
  | 'xai'
  | 'openrouter'
  | 'deepseek'
  | 'mistral'
  | 'custom'

export interface ProviderRuntime {
  id: ProviderId
  label: string
  /** Currently selected model id. */
  model: string
  /** Override endpoint (used by Ollama, optionally others). */
  baseUrl?: string
  /** Whether the provider requires an API key at all. */
  needsKey: boolean
  /** Whether a key is currently stored (the key itself never leaves main). */
  hasKey: boolean
  /** Fallback model list shown before a live list is fetched. */
  defaultModels: string[]
  /**
   * For local providers (Ollama, LM Studio): whether the daemon was reachable
   * on the last boot probe. Undefined for non-local providers. Powers the
   * "✓ detected" / "not running" badge in the provider picker so users see
   * at a glance whether a local backend will actually work.
   */
  localReady?: boolean
}

/* ------------------------------- Chat ----------------------------------- */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatAttachment {
  id: string
  kind: 'image' | 'text' | 'pdf'
  name: string
  /**
   * Present for image attachments AND pdf attachments — a `data:` URL.
   * For PDFs, Chromium's built-in viewer renders it inline when set as the
   * src of an <embed> / <iframe>.
   */
  dataUrl?: string
  /**
   * Present for text and pdf attachments — extracted contents. For PDFs the
   * extracted text powers the model side; the dataUrl powers the inline
   * preview.
   */
  text?: string
}

/* ----------------------------- Agent tools ------------------------------ */

/** A tool the model asked to run. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** A completed tool call, with its result, shown in the transcript. */
export interface ToolInvocation extends ToolCall {
  result: string
  ok: boolean
  /**
   * Base64 `data:` image URL produced by the tool as **model input** (e.g.
   * `see_screen`). The agent loop attaches it to the next user turn so the
   * model can reason visually.
   */
  image?: string
  /**
   * Base64 `data:` image URL produced as **user-facing output** (e.g.
   * `generate_image`). Displayed inline in the assistant message bubble.
   */
  imageOutput?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  attachments?: ChatAttachment[]
  /** Automation actions the assistant ran for this message. */
  toolCalls?: ToolInvocation[]
  createdAt: string
  /** Marks an assistant message that ended in an error. */
  error?: boolean
  /** True while the assistant message is still streaming. */
  streaming?: boolean
  /**
   * Model id that produced this assistant message — captured at send time so
   * a later thread switch / global model change doesn't rewrite history.
   * Lets the UI show "answered by gpt-4o" inline, à la OpenRouter / Cursor.
   */
  model?: string
}

/** Wire format sent to the main process for a completion request. */
export interface ChatTurn {
  role: ChatRole
  content: string
  /** Base64 `data:` image URLs attached to this turn. */
  images?: string[]
  /** Set on assistant turns that requested tools. */
  toolCalls?: ToolCall[]
  /** Set on `tool` turns carrying results back to the model. */
  toolResults?: Array<{ id: string; name: string; content: string }>
}

export interface ChatRequest {
  requestId: string
  provider: ProviderId
  model: string
  system: string
  messages: ChatTurn[]
  temperature?: number
}

/** Request for one non-streaming, tool-enabled agent step. */
export interface AgentRequest {
  requestId: string
  provider: ProviderId
  model: string
  system: string
  messages: ChatTurn[]
}

/** Result of one agent step. */
export interface AgentResult {
  text: string
  toolCalls: ToolCall[]
  error?: string
}

export interface ChatStreamChunk {
  requestId: string
  delta: string
}

export interface ChatStreamDone {
  requestId: string
  text: string
  error?: string
}

/* ------------------------------ Widget ---------------------------------- */

/**
 * Visual state of the orb. `'wake-listening'` is the baseline shown while the
 * wake-word engine is armed but the user hasn't said the keyword yet — distinct
 * from `'listening'`, which means "actively capturing your speech right now".
 */
export type WidgetState =
  | 'idle'
  | 'wake-listening'
  | 'listening'
  | 'processing'
  | 'success'
  | 'error'

/* ----------------------------- Automation ------------------------------- */

export type ActionType =
  | 'open-app'
  | 'open-url'
  | 'open-folder'
  | 'shell'
  | 'file-list'
  | 'file-read'
  | 'file-write'
  | 'organize-folder'
  | 'type-text'
  | 'hotkey'
  | 'move-mouse'
  | 'mouse-click'
  | 'screenshot'
  | 'read-screen'
  | 'web-search'
  | 'web-fetch'
  | 'generate-image'
  | 'run-python'

export interface ActionRequest {
  type: ActionType
  params: Record<string, unknown>
  /**
   * Optional request-correlation id. When set, the main process registers
   * the action's abort controller against this id so `vs.ai.abort(requestId)`
   * cancels in-flight tool I/O (subprocess kill, fetch abort) at the same
   * time it aborts the LLM call. Omitted for one-off user-triggered actions
   * (tray quick-prompts, Nexus buttons) where there's no agent loop to
   * correlate with.
   */
  requestId?: string
}

export interface ActionResult {
  ok: boolean
  type: ActionType
  /** Human-readable output, safe to show in the activity log. */
  output?: string
  /** Structured payload (file lists, screenshot info, etc). */
  data?: unknown
  error?: string
  /** Set when the action was blocked pending a permission grant. */
  needsPermission?: PermissionId
  /** Set when the action can be reversed; pass to `automation.undo`. */
  undoId?: string
  undoLabel?: string
}

export interface ActionDescriptor {
  type: ActionType
  label: string
  description: string
  requires: PermissionId | null
  reversible: boolean
}

/* --------------------------- Quick actions / plugins -------------------- */

/** A one-click, permission-gated action — used by modes and plugins alike. */
export interface QuickAction {
  id: string
  label: string
  /** Lucide icon name, resolved by the renderer. */
  icon: string
  description: string
  requires: PermissionId | null
  action: ActionRequest
}

/** On-disk plugin manifest (a declarative JSON workflow pack). */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  quickActions: QuickAction[]
}

/** Plugin state delivered to the renderer. */
export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  actionCount: number
  /** File name on disk. */
  file: string
  /** Set when the plugin failed to load or validate. */
  error?: string
}

/* ------------------------------- Logs ----------------------------------- */

/**
 * Synthetic id for the renderer's "welcome" greeting message. It's never
 * persisted to disk and never sent to the model — every filter that touches
 * history checks against this constant so changing it here updates every
 * call-site at once.
 */
export const WELCOME_MESSAGE_ID = 'welcome'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type LogCategory =
  | 'ai'
  | 'automation'
  | 'permission'
  | 'screen'
  | 'system'
  | 'rag'
  | 'files-rag'
  | 'memory'
  | 'summarizer'
  | 'mcp'

export interface LogEntry {
  id: string
  ts: string
  level: LogLevel
  category: LogCategory
  message: string
  detail?: string
}

/* ------------------------------ Memory ---------------------------------- */

export interface RecentProject {
  path: string
  name: string
  lastOpened: string
}

export interface FavoriteApp {
  id: string
  label: string
  target: string
}

export interface CustomPrompt {
  id: string
  label: string
  prompt: string
}

/**
 * A durable fact about the user that the assistant should remember across
 * sessions — extracted from conversations or added manually in Settings.
 *
 * `modes` scopes the fact to specific workflow modes so the system prompt
 * stays lean. Empty / missing = global, surfaced in every mode.
 */
export interface UserFact {
  id: string
  text: string
  createdAt: string
  updatedAt: string
  modes?: ModeId[]
}

/**
 * A compact "story so far" recap of the older portion of a long conversation.
 * Prepended to the system prompt when total context exceeds the model window,
 * so older turns can be elided without losing continuity.
 */
export interface HistorySummary {
  /** Prose recap injected into the system prompt. */
  text: string
  /**
   * The id of the last message this summary covers. Treated as the single
   * authoritative pointer — the UI's "covers N messages" label is recomputed
   * live from this boundary, not from any stored count.
   */
  coversUpToId: string
  generatedAt: string
}

/**
 * A named conversation thread. Each thread has its own message log and
 * (optional) "story so far" summary, so the user can keep separate ongoing
 * conversations the way they would in ChatGPT or Claude.
 */
export interface ChatThread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  summary?: HistorySummary | null
  /** Pinned threads float to the top of the sidebar regardless of recency. */
  pinned?: boolean
  /**
   * When set, this thread uses its own mode (and that mode's quick-actions
   * + prompt fragment) regardless of the global `activeMode`. Null/undefined
   * means "follow the global mode" — the default behaviour.
   */
  pinnedMode?: ModeId | null
  /**
   * When set, this thread uses its own base system prompt instead of the
   * global `systemPrompt`. The mode fragment is still appended on top, so
   * the override replaces the baseline only.
   */
  pinnedSystemPrompt?: string | null
  /** Project this thread belongs to (NULL = unfiled). See {@link Project}. */
  projectId?: string | null
}

/**
 * Lightweight thread metadata used by the sidebar and the renderer's thread
 * list. Excludes the message log — only the active thread's messages are
 * held in memory, so 100 threads no longer eagerly load 50k messages.
 */
export interface ThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  /** Cached "story so far" recap, if one exists. Cheap to ship over IPC. */
  summary?: HistorySummary | null
  /** Total number of messages on disk for this thread. */
  messageCount: number
  /** Snippet of the first user message — drives the sidebar preview line. */
  preview: string
  /** Mode pinned to this thread, if any (else fall back to global). */
  pinnedMode?: ModeId | null
  /** System prompt pinned to this thread, if any (else fall back to global). */
  pinnedSystemPrompt?: string | null
  /** Project this thread belongs to (NULL = no project). Project instructions
   *  apply on top of the global system prompt when the thread doesn't have
   *  its own pinned override. */
  projectId?: string | null
}

/**
 * A Project (a.k.a. Collection in some products) — a named grouping of
 * threads with shared instructions. Inspired by Claude Projects: lets the
 * user say "all my UE5 threads share this system prompt" instead of pinning
 * the same prompt to every thread individually.
 */
export interface Project {
  id: string
  name: string
  /** Short blurb shown in the sidebar / picker. Doesn't reach the model. */
  description?: string | null
  /** Shared system-prompt addendum — appended to the global system prompt
   *  for any thread in this project (unless the thread has its own pinned
   *  override, which wins). */
  instructions?: string | null
  createdAt: string
  updatedAt: string
}

/** A single message-search hit returned by `vs.history.search`. */
export interface MessageSearchHit {
  threadId: string
  threadTitle: string
  messageId: string
  role: ChatRole
  createdAt: string
  /** Plain-text snippet around the match, capped for display. */
  snippet: string
}

export interface MemoryState {
  recentProjects: RecentProject[]
  favoriteApps: FavoriteApp[]
  customPrompts: CustomPrompt[]
  /** User-defined quick actions shown on the Nexus HUD circle. */
  customActions: QuickAction[]
  /** Long-term facts about the user, injected into the system prompt. */
  facts: UserFact[]
}

/** Kinds of custom Nexus action a user can create. */
export type CustomActionKind = 'app' | 'url' | 'folder'

/* ------------------------------ Usage & cost --------------------------- */

export type UsageKind = 'chat' | 'invoke' | 'image' | 'embedding'

/** One recorded API call — provider, model, tokens or image count, dollars. */
export interface UsageEntry {
  id: string
  ts: string
  provider: ProviderId
  model: string
  kind: UsageKind
  inputTokens: number
  outputTokens: number
  imageCount?: number
  /** Computed USD cost, or null when we have no pricing for the model. */
  cost: number | null
  /** True when the token counts are estimated client-side rather than reported by the API. */
  estimated: boolean
}

/** Aggregated cost summary for a window (current month by default). */
export interface UsageSummary {
  totalCost: number
  totalEntries: number
  unknownPricing: number
  byProvider: Array<{ provider: ProviderId; cost: number; entries: number }>
  byModel: Array<{ model: string; provider: ProviderId; cost: number; entries: number; tokens: number }>
  /**
   * Daily total cost in USD for the chart. Days with zero spend get an
   * entry too (cost: 0) so the renderer can draw an empty bar without
   * having to compute calendar arithmetic.
   */
  dailyCost: Array<{ date: string; cost: number }>
  recent: UsageEntry[]
  windowStart: string
  windowEnd: string
}

/** Monthly spending cap (USD). Null = no budget set. */
export interface UsageBudget {
  monthlyUsd: number | null
  /** True once a 75% / 90% / 100% warning has fired this month, so we don't repeat. */
  warned75: boolean
  warned90: boolean
  warned100: boolean
  /** ISO month string (YYYY-MM) the warnings apply to — flipping months resets. */
  month: string
}

/* --------------------------- Model Context Protocol --------------------- */

/**
 * Configuration for one MCP server VoidSoul talks to. Stored on disk in
 * `mcp.json`; the manager spawns the command and connects via stdio.
 */
export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

/** A single tool exposed by an MCP server, ready to surface to the agent. */
export interface McpToolInfo {
  /** Prefixed tool name the AI model sees, e.g. `mcp_filesystem_read_file`. */
  name: string
  /** Original tool name on the upstream server. */
  originalName: string
  description: string
  inputSchema: Record<string, unknown>
  serverId: string
  serverName: string
}

/** Live status sent to the renderer for the Settings UI. */
export interface McpServerStatus {
  id: string
  name: string
  enabled: boolean
  connected: boolean
  error: string | null
  tools: McpToolInfo[]
}

/** Input payload when the user adds a new MCP server in Settings. */
export interface McpServerInput {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/* --------------------------- File RAG --------------------------- */

export interface IndexedFolder {
  path: string
  addedAt: string
  lastScan: string | null
  fileCount: number
  chunkCount: number
}

export interface IndexedFileSummary {
  path: string
  folder: string
  size: number
  mtime: string
  chunkCount: number
  lastIndexed: string
}

export interface ScanProgress {
  folder: string
  done: number
  total: number
  /** File currently being processed, for UI breadcrumbs. */
  current?: string
}

export interface ScanResult {
  folder: string
  filesScanned: number
  filesIndexed: number
  filesSkipped: number
  chunksAdded: number
  error?: string
}

/* --------------------------- Notebooks --------------------------- */

export type NotebookCellKind = 'prompt' | 'python' | 'search' | 'markdown'

export type NotebookCellStatus = 'idle' | 'running' | 'ok' | 'error'

export interface NotebookCell {
  id: string
  kind: NotebookCellKind
  /** User-provided source (prompt text, Python code, search query, etc.). */
  input: string
  /** Most recent result. Plain text for now — markdown cells just echo input. */
  output: string
  status: NotebookCellStatus
  /** Wall-clock duration of the last run in ms, when ok. */
  durationMs?: number
  /** Last error message, when status === 'error'. */
  error?: string
  /** ISO timestamp of the last run, when ok or error. */
  ranAt?: string
}

export interface Notebook {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  cells: NotebookCell[]
}

/** Lightweight sidebar entry — cells trimmed to a count. */
export interface NotebookSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  cellCount: number
}

/* --------------------------- Scheduler --------------------------- */

export type ScheduleKind = 'daily' | 'interval' | 'once'

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  /** `daily`: "HH:mm" · `interval`: minutes as string · `once`: ISO timestamp. */
  scheduleValue: string
  enabled: boolean
  createdAt: string
  lastRun: string | null
  nextRun: string | null
  lastResult: string | null
  lastError: string | null
}

/* ------------------------------ Voice ----------------------------------- */

export type VoicePersona = 'void' | 'soul'

export interface VoiceConfig {
  /** Speak assistant replies aloud. */
  enabled: boolean
  /** Which persona currently has the floor. */
  persona: VoicePersona
  /** System speech-synthesis voice URI for the male "Void" persona. */
  voidVoiceURI: string
  /** System speech-synthesis voice URI for the female "Soul" persona. */
  soulVoiceURI: string
  /** Speech rate (0.5 – 1.6). */
  rate: number
  /**
   * Wake-word listener. Off by default — needs a Picovoice access key and a
   * .ppn keyword file per persona (Settings → Integrations → Picovoice).
   */
  wakeWord: { enabled: boolean }
}

/* ------------------------------ Config ---------------------------------- */

export type ModeId =
  | 'indie-dev'
  | 'creator'
  | 'streamer'
  | 'researcher'
  | 'writer'
  | 'productivity'
export type AccentColor =
  | 'violet'
  | 'cyan'
  | 'magenta'
  | 'green'
  | 'amber'
  | 'rose'
  | 'blue'
  | 'teal'

/** Nexus tab layout: a clean app-launcher ('simple') or the full radial HUD. */
export type NexusStyle = 'simple' | 'advanced'

/**
 * Which engine produces RAG embeddings.
 *  - `auto`   — try OpenAI (best quality if a key is set), else Ollama
 *  - `openai` — OpenAI `text-embedding-3-small` only (paid, fast)
 *  - `ollama` — Ollama `nomic-embed-text` only (local daemon required)
 *  - `local`  — Transformers.js `Xenova/all-MiniLM-L6-v2` in-process
 *               (~25 MB one-time download, then offline, free, unlimited)
 */
export type EmbeddingProvider = 'auto' | 'openai' | 'ollama' | 'local'

/**
 * Conversation-behaviour switches. Grouped together because they all govern
 * how a chat turn is processed (tools, memory, persistence, retrieval).
 */
export interface ChatBehaviourConfig {
  /** When true, the assistant can call permission-gated automation tools. */
  agent: boolean
  /** When true, every successful reply triggers a small fact-extraction pass. */
  autoMemory: boolean
  /** When true, the current chat isn't persisted and no facts are extracted. */
  private: boolean
  /** When true, chat messages are embedded so older snippets can be recalled. */
  rag: boolean
  /** Embedding engine for `rag` (and file-RAG indexing). Defaults to `auto`. */
  embeddingProvider: EmbeddingProvider
}

export type ThemeMode = 'dark' | 'light' | 'system'

export interface AppearanceConfig {
  accent: AccentColor
  /**
   * Colour theme. `system` follows the OS preference (light during day,
   * dark at night on most modern desktops); `light`/`dark` lock the app to
   * that mode regardless of OS state.
   */
  theme: ThemeMode
  animations: boolean
  glassOpacity: number
  alwaysOnTop: boolean
  launchOnStartup: boolean
  screenAwareness: boolean
  nexusStyle: NexusStyle
  /** UI language. `system` follows the OS locale; otherwise a BCP-47 tag. */
  locale: LocaleCode
  /** Quiet mode: orb darkens, voice replies suppressed, summon-hotkey only. */
  dnd: DndConfig
}

/** Supported UI languages. `system` follows the OS preference. */
export type LocaleCode = 'system' | 'en' | 'es' | 'ja' | 'de'

export interface DndConfig {
  /** Manual override — when true, DND is on regardless of schedule. */
  enabled: boolean
  /**
   * Optional daily quiet window, e.g. `"22:00"` to `"07:00"`. When set and
   * `enabled` is false, DND auto-activates inside the window. Wraps across
   * midnight if `end < start`.
   */
  quietStart: string | null
  quietEnd: string | null
}

/** True iff DND is currently active per the configured manual override or schedule. */
export function isQuietNow(dnd: DndConfig, now: Date = new Date()): boolean {
  if (dnd.enabled) return true
  if (!dnd.quietStart || !dnd.quietEnd) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const parse = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (h > 23 || mm > 59) return null
    return h * 60 + mm
  }
  const start = parse(dnd.quietStart)
  const end = parse(dnd.quietEnd)
  if (start == null || end == null) return false
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

/**
 * Per-provider record of when each model was first discovered. The renderer
 * uses this to surface a "NEW" badge on models that landed in the last week
 * — closing the day-zero gap as fast as the provider's API does.
 *
 * Values are ISO timestamps, keyed by model id.
 */
export type SeenModels = Partial<Record<ProviderId, Record<string, string>>>

/** The configuration shape delivered to the renderer (never contains keys). */
export interface ClientConfig {
  activeProvider: ProviderId
  providers: ProviderRuntime[]
  activeMode: ModeId
  permissions: Record<PermissionId, PermissionState>
  appearance: AppearanceConfig
  voice: VoiceConfig
  /** First-seen timestamps for every model id we've discovered, per provider. */
  seenModels: SeenModels
  /** Conversation-behaviour toggles, grouped for clarity as they grow. */
  chat: ChatBehaviourConfig
  /** Folder used for backup sync (e.g. a Dropbox/Drive folder). Empty = unset. */
  syncFolder: string
  /** True once the user has seen (or skipped) the first-boot tour. */
  onboarded: boolean
  systemPrompt: string
}

/** Outcome of a backup / sync operation. */
export interface SyncResult {
  ok: boolean
  message: string
}

/* --------------------------- System telemetry --------------------------- */

export interface SystemStats {
  /** Aggregate CPU utilisation, 0–100. */
  cpu: number
  /** Memory used / total, in bytes. */
  memUsed: number
  memTotal: number
  /** Memory utilisation, 0–100. */
  memPercent: number
  /** OS uptime in seconds. */
  uptime: number
  hostname: string
  /** Primary disk usage, in bytes. Null until the first slow poll resolves. */
  disk: { used: number; total: number; percent: number } | null
  /** Discrete GPU telemetry. Null when unavailable; load/temp may be null individually. */
  gpu: { model: string; load: number | null; temp: number | null } | null
  /** CPU package temperature in °C. Null when the platform does not report it. */
  cpuTemp: number | null
  /** Battery state. Null on machines without a battery. */
  battery: { percent: number; charging: boolean } | null
}

/* ------------------------------ Screen ---------------------------------- */

export interface ScreenshotResult {
  path: string
  dataUrl: string
  width: number
  height: number
}

export interface OcrResult {
  text: string
  confidence: number
}

export interface ActiveWindowInfo {
  title: string
  process: string
}

/* ----------------------------- Auto-update ----------------------------- */

/**
 * State of the auto-update pipeline as surfaced to the renderer. Mirrors
 * the lifecycle of electron-updater but keeps the wire shape app-specific
 * so we don't bind to the underlying API's exact event names.
 */
export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'not-available'; checkedAt: string }
  | { kind: 'available'; version: string; releaseNotes: string | null }
  | { kind: 'downloading'; percent: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
