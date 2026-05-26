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
  /**
   * v1.13.6 — present when the auto-router overrode the user's active
   * provider for this turn. Carries the short human-readable reason
   * (e.g. "tool-heavy + filepath → strong reasoning") so the bubble can
   * surface WHY a different model answered. Omitted when the active
   * provider was used as-is or when auto-route is off.
   */
  routingReason?: string
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
  | 'visual-click'
  | 'screenshot'
  | 'read-screen'
  | 'web-search'
  | 'web-fetch'
  | 'generate-image'
  | 'run-python'
  | 'save-document'

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

/**
 * A registry entry — what the marketplace browse view receives. Extends
 * the manifest with optional non-installed metadata (`tags`) that the UI
 * uses for filtering / search and that the installer ignores.
 */
export interface PluginRegistryEntry extends PluginManifest {
  /** Free-form tags for marketplace filtering, e.g. ["productivity", "ai"]. */
  tags?: string[]
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
  /**
   * v1.4.0 Phase 3 — emotional context tag set on auto-saved facts so the
   * sentiment subsystem can surface "last win" / "last friction" to the
   * system prompt. Null / unset = neutral, the existing behaviour for
   * every fact created before v1.4.0.
   */
  emotionalTag?: 'win' | 'friction' | null
}

/* ----------------------- Emotional context (v1.4.0) -------------------- */

/** Bucketed sentiment labels emitted by the classifier. Narrow set so the
 *  model's outputs are well-defined + system prompt copy can talk in
 *  terms it recognises. */
export type SessionSentimentLabel =
  | 'stressed'
  | 'productive'
  | 'stuck'
  | 'excited'
  | 'neutral'

export interface SessionSentiment {
  id: number
  sessionStart: string
  /** Null when this is the currently-active session; stamped on next
   *  session boundary. */
  sessionEnd: string | null
  sentiment: SessionSentimentLabel
  /** 1-5 Likert scale — LLMs handle small discrete scales better than
   *  free floats. */
  intensity: number
  /** Optional one-line note the classifier emits to ground the label
   *  ("crunching on the auth refactor"). Shown in Settings. */
  summary: string | null
  computedAt: string
}

/** Snapshot the system-prompt builder + Settings panel consume. */
export interface EmotionalContextSnapshot {
  current: SessionSentiment | null
  lastWin: { text: string; createdAt: string } | null
  lastFriction: { text: string; createdAt: string } | null
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

export type UsageKind = 'chat' | 'invoke' | 'image' | 'embedding' | 'screen-watch'

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
  /** v1.12.0 — wall-clock time from request issue to response completion,
   *  in milliseconds. Optional because legacy entries (pre-v1.12) didn't
   *  capture it. Drives the per-provider latency aggregates. */
  durationMs?: number
  /** v1.12.0 — false when the provider call errored (HTTP non-2xx, schema
   *  validation failure, timeout). Optional because legacy entries are
   *  treated as success-by-omission. Drives the success-rate aggregate. */
  success?: boolean
  /** Brief error category for diagnostics — set alongside success=false.
   *  E.g. "401 unauthorized", "rate-limited", "timeout". Never a stack
   *  trace or PII; the UI shows recent failures grouped by this label. */
  errorKind?: string
}

/** v1.12.0 — per-provider performance aggregate over a rolling window.
 *  Surfaced in Settings → Usage so users can see which provider is
 *  fastest / cheapest / most reliable and decide which to favour. */
export interface ProviderPerformance {
  provider: ProviderId
  /** Total recorded calls (success + failure). */
  callCount: number
  successCount: number
  failureCount: number
  /** Percentage 0–100. `null` when callCount is 0 (avoids divide-by-zero
   *  rendering). */
  successRate: number | null
  /** Mean latency across successful calls with `durationMs` recorded.
   *  `null` when no recorded latencies exist (e.g. all entries are
   *  legacy pre-v1.12 with no timing). */
  avgLatencyMs: number | null
  /** 95th percentile latency — captures tail performance better than the
   *  mean. `null` when fewer than 5 timed calls. */
  p95LatencyMs: number | null
  /** Total USD cost across all calls in the window. */
  totalCost: number
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

/** Monthly spending cap. Stored canonically in USD (provider APIs bill
 *  in USD); the renderer displays in the user's chosen `currency` at the
 *  manual `usdRate` they set. Null monthlyUsd = no budget. */
export interface UsageBudget {
  monthlyUsd: number | null
  /** True once a 75% / 90% / 100% warning has fired this month, so we don't repeat. */
  warned75: boolean
  warned90: boolean
  warned100: boolean
  /** ISO month string (YYYY-MM) the warnings apply to — flipping months resets. */
  month: string
  /** v1.12.0 — display currency for the Usage panel. Optional for back-
   *  compat: legacy budgets without this field render as USD. */
  currency?: string
  /** v1.12.0 — exchange rate the user set, expressed as "1 USD = N units
   *  of `currency`". Used both ways: input × rate → local display,
   *  local input ÷ rate → stored USD. Defaults to 1 (USD identity). */
  usdRate?: number
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
  /**
   * v1.11.0 — tool names from this server that collide with another
   * source the model also sees (another MCP server OR a built-in tool).
   * Populated post-connection by the manager's duplicate scan. Surfaces
   * as an amber badge on the server row so the user knows the agent's
   * pick between the duplicates is ambiguous (and can rename one server
   * or disable the other to fix). Empty array = no collisions.
   */
  duplicateTools: string[]
}

/** Input payload when the user adds OR edits an MCP server in Settings.
 *  v1.11.0 — same shape covers both add and update paths; the dispatcher
 *  decides based on whether an id is supplied alongside. */
export interface McpServerInput {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/* --------------------------- Setup detection ---------------------------
 *
 * Results of the boot-time / on-demand scan that hunts for AI tools the
 * user has already configured on this machine — Claude Desktop, Cursor,
 * ChatGPT Desktop, env-var API keys, and the existing local-provider
 * probe results. Drives the first-run "we found X, want to import?"
 * panel + the in-Settings "Import from Claude Desktop" buttons.
 *
 * Security: the actual API key VALUES from env vars are NEVER included
 * in this report — only a preview ('sk-ant-...x4z9'). The renderer asks
 * a separate import IPC to actually write the key into the OS keychain,
 * which reads from process.env at import time so the key never crosses
 * the IPC boundary as plaintext.
 * --------------------------------------------------------------------- */

export interface DetectedDesktopApp {
  installed: boolean
  /** Absolute path to install dir / config file, when detected. */
  path?: string
}

export interface DetectedMcpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  source: 'claude-desktop' | 'cursor'
  /** Env keys referenced but empty in the source config — these would
   *  need user input before the imported server could actually run. */
  missingEnv: string[]
}

export interface DetectedEnvKey {
  varName: string
  providerId: ProviderId
  /** Truncated preview safe to display — first 8 chars + last 4. */
  keyPreview: string
}

export interface DetectedLocalProvider {
  providerId: ProviderId
  /** Number of models the daemon advertised on the probe response. */
  modelCount: number
}

export interface SetupReport {
  claudeDesktop: DetectedDesktopApp & { mcpServers: DetectedMcpServer[] }
  cursor: DetectedDesktopApp & { mcpServers: DetectedMcpServer[] }
  chatgptDesktop: DetectedDesktopApp
  envKeys: DetectedEnvKey[]
  localProviders: DetectedLocalProvider[]
  /** ISO timestamp — useful for "last scanned" UX hints. */
  generatedAt: string
}

/** Per-row outcome for a failed MCP-server or env-key import. */
export interface SetupImportFailure {
  /** Server name (MCP imports) or provider id (env-key imports). */
  name: string
  reason: string
}

/**
 * Result of a batch MCP import. `imported` counts new servers actually
 * written to disk; `skipped` counts entries already present (idempotent
 * re-runs); `failures` carries the rest with a human-readable reason.
 */
export interface SetupImportResult {
  imported: number
  skipped: number
  failures: SetupImportFailure[]
}

/** Result of importing a single API key from process.env. */
export interface SetupEnvKeyImportResult {
  providerId: ProviderId
  success: boolean
  error?: string
}

/* ---------------------------- MCP marketplace ---------------------------
 *
 * Curated registry of community MCP servers surfaced inside the in-app
 * marketplace. Entries describe both the install command and the per-
 * server input the user needs to provide (a folder path for filesystem,
 * an API key for GitHub, etc.) so the install dialog can build the right
 * form on the fly instead of dumping users into raw command-line config.
 * ----------------------------------------------------------------------- */

/**
 * Prompt for a value the user fills in before install. `{KEY}` tokens in
 * the server's `args` get replaced with the user-supplied value at install
 * time.
 *
 *  - `type: 'folder' | 'file'` is a UI hint — the dialog could in future
 *    show a native file/folder picker for these; today they're text inputs
 *    either way, but the hint future-proofs the schema.
 *  - `secret: true` flips the input to a password field (masks the value
 *    while typing).
 */
export interface McpRegistryArgPrompt {
  key: string
  label: string
  description?: string
  type?: 'text' | 'folder' | 'file'
  placeholder?: string
  secret?: boolean
}

/** Prompt for an env var the user must paste before install. */
export interface McpRegistryEnvPrompt {
  key: string
  label: string
  description?: string
  /** Default true for tokens / API keys — flips the input to password mode. */
  secret?: boolean
}

export interface McpRegistryEntry {
  id: string
  name: string
  description: string
  category: string
  tags?: string[]
  command: string
  args: string[]
  env: Record<string, string>
  argPrompts: McpRegistryArgPrompt[]
  envPrompts: McpRegistryEnvPrompt[]
  /** Runtime prerequisite (e.g. "uv" for uvx-based servers). UI shows a badge. */
  requires?: string
  author?: string
  docsUrl?: string
  /**
   * v1.11.0 / v1.11.1 — which registry surfaced this entry. Marketplace
   * dialog colour-codes the badge so users can tell our curated picks
   * from the broader community catalogues. Optional for back-compat
   * with the bundled registry shape that predates this field.
   */
  source?: 'curated' | 'smithery' | 'glama' | 'pulsemcp'
  /**
   * v1.12.0 — cryptographic verification flag. Set true only for
   * entries that came from a source whose detached Ed25519 signature
   * verified against the bundled public key (see registry-signing.ts).
   * Today only the curated registry is signed; community sources
   * (Smithery, Glama, PulseMCP) are inherently unverifiable because
   * we don\'t control their upstream signing keys. Surfaces as a
   * "Verified" badge in the marketplace card so users can see the
   * trust gap upfront — pre-empts the "malicious plugin owns your
   * machine" failure mode the audit flagged.
   */
  verified?: boolean
  /**
   * v1.11.4 — discovery-only flag. Set true when the registry surfaced
   * this entry but didn't include enough install info to one-click
   * install (Glama in particular — their list endpoint omits the
   * install command; per-entry details live on a separate page).
   *
   * Discovery-only cards render with a "View on X ↗" button that
   * opens `docsUrl` in the user's browser instead of the install
   * configure dialog. Honest: we can\'t install for you, but we can
   * show you what\'s available and where to learn more — which is
   * still useful for browse + discover.
   */
  discoveryOnly?: boolean
}

/**
 * User-supplied values when installing a registry entry — keyed by the
 * `key` field on `argPrompts` / `envPrompts`. Validated against the
 * entry's prompt lists in the main-process installer.
 */
export interface McpInstallValues {
  args: Record<string, string>
  env: Record<string, string>
}

/**
 * Result of a marketplace install attempt.
 *  · `ok: true, skipped: false` → freshly installed; toast "X connected"
 *  · `ok: true, skipped: true`  → was already installed; toast "Already installed"
 *  · `ok: false`                → install failed; `error` carries the reason
 *
 * The `skipped` flag is what lets the dialog avoid the misleading
 * "X connected · 6 tools" success toast when nothing actually happened.
 */
export interface McpMarketplaceInstallResult {
  ok: boolean
  /** True when the server was already installed; no new addServer call ran. */
  skipped?: boolean
  status?: McpServerStatus
  error?: string
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

/**
 * Two flavours of stored task in the same `scheduled_tasks` table.
 *   'cron'  — fires on a clock (the original v1.0 scheduled-tasks
 *             feature; uses scheduleKind + scheduleValue + nextRun)
 *   'watch' — fires when a runtime condition becomes true (v1.5.0
 *             proactive voice). scheduleValue holds a JSON-encoded
 *             WatchSpec; nextRun is unused.
 */
export type TaskKind = 'cron' | 'watch'

/**
 * Conditions a watch task can subscribe to. Polled types (idle-duration,
 * time-of-day-window) are checked once per scheduler tick; event types
 * (task-complete, sentiment-shift) are fired immediately from the
 * subsystem that emits them.
 */
export type WatchConditionType =
  | 'idle-duration' // fires when user has been silent for N minutes
  | 'task-complete' // fires when a long-running tool call wraps
  | 'sentiment-shift' // fires when the sentiment label changes
  | 'time-of-day-window' // daily nudge at a specific local-time window

export interface WatchSpec {
  type: WatchConditionType
  /** Per-type config:
   *   idle-duration       — { minutes: number, activeFrom?: 'HH:mm', activeTo?: 'HH:mm' }
   *   task-complete       — { minDurationSec: number }
   *   sentiment-shift     — { to?: SessionSentimentLabel } (optional filter)
   *   time-of-day-window  — { at: 'HH:mm' } */
  params: Record<string, unknown>
  /** The thing Soul says when this watch fires. */
  action: ProactiveAction
  /** Don't re-fire within this many minutes after the last fire. */
  throttleMinutes: number
}

/**
 * What a watch task does when its condition trips. Currently only
 * 'speak' — but kept as a discriminated union so future actions
 * (notify, run shell, etc) slot in without breaking the schema.
 */
export type ProactiveAction =
  | {
      type: 'speak'
      /** Static text the model speaks. For 'morning-recap' this is
       *  ignored; the runner generates content dynamically. */
      content: string
      tone?: import('./voiceMarkers').ToneTag
      /** If true, an in-flight voice clip gets pre-empted. Default
       *  false so users aren't interrupted mid-reply. */
      allowInterrupt?: boolean
      /** Special flag for built-in 'morning recap' — runner ignores
       *  `content` and asks the cheap model to summarise yesterday. */
      dynamicRecap?: boolean
    }

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  /** v1.5.0+ — discriminator. Existing pre-v1.5 rows default to 'cron'
   *  via the migration's column default. */
  kind: TaskKind
  scheduleKind: ScheduleKind
  /** `daily`: "HH:mm" · `interval`: minutes as string · `once`: ISO
   *  timestamp · `watch` (kind='watch'): JSON-stringified WatchSpec. */
  scheduleValue: string
  enabled: boolean
  createdAt: string
  lastRun: string | null
  nextRun: string | null
  lastResult: string | null
  lastError: string | null
}

/**
 * v1.5.0 master config for the proactive-voice subsystem. Master toggle
 * is on by default; individual watch tasks ship disabled so a fresh
 * install has zero unprompted speech until the user opts in.
 */
export interface ProactiveVoiceConfig {
  /** Master kill-switch. Off = no watch task ever fires regardless
   *  of per-task enabled flag. */
  enabled: boolean
}

/**
 * v1.7 screen-watch config — Soul periodically looks at your screen
 * (with explicit opt-in) and may speak if she sees something useful.
 * Ships disabled. Requires the screenCapture permission to actually
 * fire. Wraps gating + cost-cap into config so the user has one place
 * to tune the cadence/budget.
 */
export interface ScreenWatchConfig {
  /** Master switch for the screen-watch loop. Ships off. */
  enabled: boolean
  /** Minutes between observation ticks. Each tick = one vision call. */
  intervalMinutes: number
  /** Optional local-time window. Both required to apply; format "HH:mm".
   *  Soul stays silent outside this window even if enabled. */
  activeFrom: string | null
  activeTo: string | null
  /** Hard cap on observation calls per day (resets at local midnight).
   *  Once hit, the loop pauses until the next reset — protects against
   *  runaway cost on cloud providers. */
  dailyCap: number
}

/** Last observation result — surfaced in Settings so the user can see
 *  what Soul saw and decided. Stored in memory only (volatile). */
export interface ScreenWatchStatus {
  enabled: boolean
  intervalMinutes: number
  /** Calls fired today (resets at local midnight). */
  callsToday: number
  /** Daily cap from config — mirrored here so the UI doesn't have to
   *  pull config separately. */
  dailyCap: number
  /** ISO timestamp of the last tick (success or skip). */
  lastObservationAt: string | null
  /** True when the most recent observation triggered a spoken nudge. */
  lastSpoke: boolean
  /** Soul's last decision content (whether spoken or not — for "she
   *  decided to stay silent because…" transparency). */
  lastReason: string | null
}

/** Renderer-facing shape of a watch task — id + name + per-task
 *  enabled + the full spec + last-fire telemetry. */
export interface WatchTask {
  id: string
  name: string
  enabled: boolean
  spec: WatchSpec
  createdAt: string
  lastRun: string | null
  lastResult: string | null
  lastError: string | null
}

/* ------------------------------ Voice ----------------------------------- */

export type VoicePersona = 'void' | 'soul'

/**
 * A Piper TTS voice installed on the user's machine. One per persona's
 * folder under `<userData>/voices/<persona>/`. Surfaced to the settings
 * UI so the user sees the actual voice name (Amy, Arctic, etc.) rather
 * than a generic "voice selected" state.
 */
export interface InstalledVoice {
  /** Absolute path to the .onnx model file. */
  modelPath: string
  /** Filename without extension (e.g., "en_US-amy-medium"). */
  id: string
  /** Friendly name pulled from the .onnx.json metadata when present. */
  name: string
  sizeBytes: number
  language?: string
  quality?: string
}

/** Snapshot of the voice subsystem the settings UI renders from. */
export interface VoiceSetupStatus {
  /** Piper binary bundled with the install + reachable from main. */
  binaryAvailable: boolean
  void: InstalledVoice | null
  soul: InstalledVoice | null
}

export interface VoiceConfig {
  /** Speak assistant replies aloud. */
  enabled: boolean
  /** Which persona currently has the floor. */
  persona: VoicePersona
  /** Speech rate (0.5 – 1.6). Maps to Piper's `--length_scale` inversely. */
  rate: number
  /**
   * Speech volume (0 – 1). 1 = system volume, 0 = silent (but still queues —
   * use `enabled: false` to actually stop scheduling utterances). Independent
   * of the OS / app volume mixer so users can mute Void/Soul without muting
   * everything else from the app.
   */
  volume: number
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
  /**
   * v1.13.4 — controls the auto-router that can switch providers mid-prompt.
   * When ON (default), the router scores each send against capability /
   * speed / cost signals and may pick a DIFFERENT provider than the one
   * the user set as Active — e.g. routing tool-heavy prompts to gpt-4o-
   * mini for speed even when Anthropic Claude is the active pick. That
   * behaviour is what produced the v1.13.x "gpt-4o-mini refuses to call
   * tools" failure mode reported by beta users.
   *
   * When OFF, every send goes to the user's Active provider verbatim
   * (modulo error-retry fallback, which is a separate path). Optional
   * because the routing is genuinely useful when configured providers
   * span very different price/speed tiers, but the user needs control
   * when the router picks a worse model for a given task.
   */
  autoRoute: boolean
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

/**
 * v1.4.0 emotional-memory config. Lives on ClientConfig under `memory`.
 * Sentiment subsystem is opt-in (default ON, beta testers seem to want
 * it) and silently skips when no fast model is reachable.
 */
export interface MemoryConfig {
  /** Whether the sentiment classifier runs at all. Off = no extra model
   *  calls, no <sentiment> block in the system prompt, no rows written. */
  emotionalContext: boolean
  /**
   * Which model to use for the classifier. Null = auto-pick based on the
   * active provider (Haiku for Anthropic, gpt-4o-mini for OpenAI,
   * gemini-2.0-flash for Gemini, defaultModel for local). User can pin
   * a specific model when they care about cost or quality trade-offs.
   */
  sentimentModel: string | null
}

/** The configuration shape delivered to the renderer (never contains keys). */
/**
 * v1.10.1 — experimental / beta-flagged features.
 *
 * Soft gates for capabilities that are functional but not reliable enough
 * to recommend for everyone yet. Off by default; user opts in from
 * Settings → Experimental with an explicit "we know this is rough" copy.
 * When a flag is off, the corresponding tool is NOT exposed to the AI
 * (filtered out of TOOL_SPECS at compose time) so the model can't even
 * call it. Honest preview > polished promise.
 */
export interface ExperimentalFeaturesConfig {
  /**
   * click_on_screen (the vision-guided + UIA click tool) shipped in v1.8.0
   * and has been iterated on heavily, but the underlying accuracy is a
   * function of vision-model precision (gpt-4o-mini etc. struggle on
   * small icon-only buttons in busy UIs) and accessibility-tree exposure
   * (browser web content often hides its content from UIA). Works great
   * for native desktop apps with proper accessibility labels; best-effort
   * for browser content. Opt-in until we ship browser DevTools integration
   * (or until model precision reaches the bar without it).
   */
  visualClick: boolean
}

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
  /** v1.4.0+ emotional context + sentiment classifier. */
  memory: MemoryConfig
  /** v1.5.0+ proactive watch tasks master switch. */
  proactiveVoice: ProactiveVoiceConfig
  /** v1.7+ screen-watch loop config. */
  screenWatch: ScreenWatchConfig
  /** v1.10.1+ experimental feature gates. */
  experimentalFeatures: ExperimentalFeaturesConfig
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

/**
 * v1.13.5 — single row in the Settings → Permissions smoke-test panel.
 * Each row corresponds to one capability the agent relies on (filesystem
 * read/list/write, shell, MCP filesystem). The renderer renders these as
 * pass/fail/skipped chips next to a short detail line.
 */
export type SmokeStatus = 'pass' | 'fail' | 'skipped'

export interface SmokeCheck {
  id: string
  label: string
  /** Short noun phrase explaining what this check actually does. */
  what: string
  status: SmokeStatus
  /** One-line outcome (success summary, error message, or skip reason). */
  detail: string
  /** Permission this check depends on, or null if there's no gate. */
  permissionId: import('./permissions').PermissionId | null
}

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

/* ------------------------- Agent checkpoints --------------------------- */

/**
 * Lifecycle of a single agent-loop invocation. Persisted to SQLite so
 * a crash, restart, or sleep mid-step doesn't lose the user's work.
 *
 *   running    — loop is actively iterating
 *   paused     — hit MAX_AGENT_STEPS; resumable by sending "continue"
 *   completed  — model returned without more tool calls (success)
 *   failed     — uncaught error or provider 4xx/5xx
 *   aborted    — user clicked Stop, or thread switched mid-loop
 *
 * On next launch, any row still at `running` is interpreted as a crash:
 * the recovery UI offers to resume it from the last persisted step.
 */
export type AgentCheckpointStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface AgentCheckpoint {
  requestId: string
  threadId: string
  userMessageId: string
  assistantMessageId: string
  providerId: ProviderId
  modelId: string
  systemPrompt: string
  turns: ChatTurn[]
  invocations: ToolInvocation[]
  step: number
  status: AgentCheckpointStatus
  failure: string | null
  createdAt: string
  updatedAt: string
}

/** Initial-state payload for `vs.agentCheckpoint.create`. */
export interface AgentCheckpointCreate {
  requestId: string
  threadId: string
  userMessageId: string
  assistantMessageId: string
  providerId: ProviderId
  modelId: string
  systemPrompt: string
  turns: ChatTurn[]
}

/** Mid-loop update — bumps step + accumulated turns/invocations. */
export interface AgentCheckpointUpdate {
  step: number
  turns: ChatTurn[]
  invocations: ToolInvocation[]
}
