/**
 * Conversation state and the completion pipeline. Each chat lives in its
 * own ChatThread; the store keeps the full list of threads plus the active
 * thread's messages mirrored at top level so existing selectors keep working
 * without churn.
 *
 * Two paths share one `send`:
 *  - Agent mode ON  — a non-streaming tool-calling loop: the model may call
 *    permission-gated automation tools, results are fed back, repeat until it
 *    answers (capped at MAX_AGENT_STEPS).
 *  - Agent mode OFF — the streaming chat path; tokens arrive over `ai:chunk`.
 */
import { create } from 'zustand'
import { vs } from '../lib/bridge'
import { uid, basename } from '../lib/utils'
import { runAgentTool } from '../lib/actions'
import { detectArtifact } from '../lib/artifactDetector'
import { extractFacts } from '../lib/factExtractor'
import {
  summarizeOlderTurns,
  estimateTokens,
  compactTurnsIfNeeded
} from '../lib/conversationSummarizer'
import { canReuseSummary } from '../lib/summaryReuse'
import { CHAT_STRINGS, formatErrorContent, formatPauseContent } from '../lib/chatStrings'
import { pickProvider, deriveBudgetState, type AvailableProvider } from '../lib/router'
import { getMode } from '@shared/modes'
import { modelHasVision } from '@shared/modelCapabilities'
import { useConfigStore } from './useConfigStore'
import { useWidgetStore } from './useWidgetStore'
import { useUiStore } from './useUiStore'
import { useMemoryStore } from './useMemoryStore'
import { useProjectsStore } from './useProjectsStore'
import { stopSpeaking, StreamingSpeaker } from '../lib/voice'
import {
  WELCOME_MESSAGE_ID,
  isQuietNow,
  type AgentCheckpoint,
  type ChatAttachment,
  type ChatMessage,
  type ChatStreamChunk,
  type ChatTurn,
  type HistorySummary,
  type ModeId,
  type ThreadSummary,
  type ToolInvocation
} from '@shared/types'

/**
 * Hard ceiling on agent-loop iterations. Set high enough that legitimate
 * multi-tool tasks (Discord bootstrap ~29 steps, multi-file refactor,
 * batch automation) complete in a single pass, but low enough that a
 * runaway loop still bails before incinerating tokens.
 *
 * Pre-v1.1 this was 6 — silently exited halfway through anything
 * non-trivial. The new ceiling surfaces a clear "step cap reached"
 * failure when hit, so the user always knows why the loop stopped.
 */
const MAX_AGENT_STEPS = 30
/** Token estimate above which older turns roll into a "story so far" recap. */
const SUMMARIZE_TRIGGER_TOKENS = 10_000
/** Minimum recent messages to keep verbatim once a summary is in play. */
const KEEP_RECENT_MIN = 8
/** Default placeholder titles that get auto-replaced after the first user turn. */
const PLACEHOLDER_TITLES = new Set(['New chat', 'Untitled', ''])

/**
 * Strips image data-URLs out of a ChatTurn[] for checkpoint persistence.
 * The checkpoint's `turns` field is informational only — resume rebuilds
 * the live turns from the thread's message history, not from this stored
 * snapshot. Storing the actual base64 here would bloat the SQLite write
 * by ~100KB per screenshot per step (10 steps × 10 screenshots = ~10MB
 * of redundant I/O on a long visual-agent run).
 *
 * Preserves the image COUNT so a future "stored agent state inspector"
 * can show how many screenshots a run captured, just not the bytes.
 */
function sanitiseTurnsForCheckpoint(turns: ChatTurn[]): ChatTurn[] {
  return turns.map((turn) => {
    if (!turn.images || turn.images.length === 0) return turn
    return { ...turn, images: turn.images.map(() => '[image]') }
  })
}

/** Same shape for invocations — the `image` field on a tool result is
 *  a full base64 data URL of a screenshot or generated image. */
function sanitiseInvocationsForCheckpoint(invs: ToolInvocation[]): ToolInvocation[] {
  return invs.map((inv) => (inv.image ? { ...inv, image: '[image]' } : inv))
}

function welcomeMessage(): ChatMessage {
  return {
    id: WELCOME_MESSAGE_ID,
    role: 'assistant',
    content:
      "I'm **VoidSoul**. Ask me anything — and with **Agent mode** on I can act on your " +
      'machine: open apps, run commands, manage files, read the screen. Every action asks ' +
      'permission first.',
    createdAt: new Date().toISOString()
  }
}

/** Folds text attachments into the message body sent to the model. */
function composeContent(message: ChatMessage): string {
  let body = message.content
  for (const attachment of message.attachments ?? []) {
    if ((attachment.kind === 'text' || attachment.kind === 'pdf') && attachment.text) {
      body += `\n\n--- ${attachment.name} ---\n${attachment.text}`
    }
  }
  return body.trim() || 'Please describe and analyse the attached image.'
}

/** Picks a concise thread title from the first user message in the log. */
function deriveTitle(messages: ChatMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === 'user' && m.content?.trim())
  if (!firstUser) return null
  const text = firstUser.content.trim().replace(/\s+/g, ' ')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** Returns the active thread's summary entry, if any. */
function activeThreadSummary(): ThreadSummary | undefined {
  const { activeThreadId, threads } = useChatStore.getState()
  return activeThreadId ? threads.find((t) => t.id === activeThreadId) : undefined
}

/** Builds the system prompt from base config, active mode, screen + agent context. */
function buildSystemPrompt(historySummary?: string): string {
  const config = useConfigStore.getState().config
  if (!config) return ''
  // Per-thread overrides win over the global config for both mode + the
  // baseline system prompt. Either can be unset independently — the mode
  // fragment still appends on top of the chosen baseline.
  const activeThread = activeThreadSummary()
  const activeModeId = activeThread?.pinnedMode ?? config.activeMode
  const mode = getMode(activeModeId)
  const baseline = activeThread?.pinnedSystemPrompt?.trim() || config.systemPrompt.trim()
  let prompt = baseline
  if (mode.prompt) prompt += `\n\n[${mode.name} mode] ${mode.prompt}`

  // Project instructions append on top of baseline + mode. Differ from
  // pinnedSystemPrompt (which REPLACES the baseline): a project's
  // instructions are a shared addendum, not the user's full voice. Lets
  // someone say "this UE5 project always knows about Unreal 5.5 + Niagara"
  // without rewriting their core system prompt for every thread.
  const projectId = activeThread?.projectId
  if (projectId) {
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
    if (project?.instructions?.trim()) {
      prompt += `\n\n[Project: ${project.name}]\n${project.instructions.trim()}`
    }
  }

  // Long-term memory — durable facts about the user. Mode-scoped facts only
  // surface when the active mode matches; untagged facts are global.
  const allFacts = useMemoryStore.getState().data?.facts ?? []
  const relevantFacts = allFacts.filter(
    (f) => !f.modes || f.modes.length === 0 || f.modes.includes(activeModeId)
  )
  if (relevantFacts.length) {
    prompt +=
      '\n\nWhat you know about the user (long-term memory):\n' +
      relevantFacts.map((f) => `- ${f.text}`).join('\n')
  }

  // Story so far — recap of the older portion of a long conversation that no
  // longer fits in the model's window. Lets the assistant keep continuity.
  if (historySummary) {
    prompt +=
      '\n\nStory so far (earlier conversation summarised for context):\n' + historySummary
  }

  // Screen context honours both the awareness toggle AND private mode — a
  // private chat must not leak which window the user has focused.
  const active = useUiStore.getState().activeWindow
  if (config.appearance.screenAwareness && !config.chat.private && active?.title) {
    prompt += `\n\nScreen context: the user currently has "${active.title}" focused (${
      active.process || 'unknown process'
    }).`
  }
  if (config.chat.agent) {
    prompt +=
      '\n\nYou can operate this computer through tools: open apps, URLs and folders, run shell ' +
      'commands, list/read/write/organise files, type text, send hotkeys, move and click the ' +
      'mouse, read on-screen text (OCR) and — when a model supports vision — `see_screen` to ' +
      'capture the screen as an IMAGE you actually look at. Prefer `see_screen` over `read_screen` ' +
      'when the user asks about visual elements (UI layout, icons, viewports, charts); use ' +
      '`read_screen` when you just need the text. For precise clicks, call `see_screen` first to ' +
      'find the target, then `move_mouse` to those pixel coords, then `click_mouse`. ' +
      '\n\nYou also have three Code-Interpreter-class tools:\n' +
      '- `web_search` — live web search for current events, recent docs, or anything you might not know. Returns a quick summary plus source links. Prefer this over guessing.\n' +
      '- `web_fetch` — pull a specific URL and read its main content. Use after `web_search` to actually open a result, or when the user pastes a link.\n' +
      '- `run_python` — execute Python in a sandboxed temp dir (system interpreter). Use for data crunching, math, file generation, scripting one-offs.\n' +
      '- `generate_image` — generate an image from a prompt via DALL·E 3. Saves a PNG to disk and returns the path.\n\n' +
      'When the user asks you to DO something, call the right tool instead of only explaining. ' +
      'Every tool call is permission-gated and logged — the user explicitly approves anything ' +
      'sensitive. Chain tools for multi-step tasks, then summarise briefly.'
  }
  return prompt
}

/**
 * Decides how to feed a possibly-very-long conversation to the model. When
 * the total estimated tokens cross the trigger threshold, the older messages
 * are rolled into a cached summary (regenerated only when stale) and only the
 * recent tail is sent verbatim. When RAG is enabled, semantically-similar
 * past snippets are also retrieved and appended to the system prompt.
 */
async function prepareConversation(
  all: ChatMessage[]
): Promise<{ system: string; turns: ChatTurn[] }> {
  let summaryText: string | null = null
  let sentMessages: ChatMessage[]

  const totalTokens = estimateTokens(all)
  if (totalTokens <= SUMMARIZE_TRIGGER_TOKENS || all.length <= KEEP_RECENT_MIN) {
    sentMessages = all
  } else {
    const cached = useChatStore.getState().summary
    const reuse = canReuseSummary(cached, all, KEEP_RECENT_MIN)

    summaryText = reuse ? cached!.text : null
    const cutoffIdx = reuse ? reuse.cutoffIdx : all.length - KEEP_RECENT_MIN

    if (!reuse) {
      const older = all.slice(0, cutoffIdx)
      summaryText = await summarizeOlderTurns(older)
      if (summaryText) {
        useChatStore.getState().setSummary({
          text: summaryText,
          coversUpToId: older[older.length - 1].id,
          generatedAt: new Date().toISOString()
        })
      }
      // If summarisation failed, summaryText stays null — the provider gets
      // the full message list and either fits it or surfaces its own error.
    }

    sentMessages = summaryText ? all.slice(cutoffIdx) : all
  }

  let system = buildSystemPrompt(summaryText ?? undefined)

  // RAG augmentation — pull semantically similar snippets from older history
  // and (when any folders are indexed) from local files. Both lookups are
  // independent and failures are non-fatal; the chat continues normally.
  const cfg = useConfigStore.getState().config
  if (cfg?.chat.rag) {
    const lastUser = all[all.length - 1]
    if (lastUser?.role === 'user' && lastUser.content?.trim()) {
      try {
        const hits = await vs.rag.search(lastUser.content, {
          limit: 8,
          excludeIds: sentMessages.map((m) => m.id)
        })
        const chatHits = hits.filter((h) => h.source === 'chat').slice(0, 4)
        const fileHits = hits.filter((h) => h.source === 'file').slice(0, 4)
        if (chatHits.length > 0) {
          const snippets = chatHits
            .map(
              (h) =>
                `- [${h.role}, ${new Date(h.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}] ${h.preview.trim()}`
            )
            .join('\n')
          system +=
            '\n\nPossibly relevant earlier exchanges (retrieved from past chats):\n' + snippets
        }
        if (fileHits.length > 0) {
          const snippets = fileHits
            .map((h) => {
              const fileName = h.filePath ? basename(h.filePath) : 'file'
              return `- [${fileName}#${h.chunkIndex ?? 0}] ${h.preview.trim()}`
            })
            .join('\n')
          system +=
            '\n\nPossibly relevant snippets from your indexed files:\n' + snippets
        }
      } catch (err) {
        void vs.logs.write(
          'warn',
          'rag',
          'RAG injection failed (chat continues without snippets)',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }

  return { system, turns: buildTurns(sentMessages) }
}

/**
 * Per-thread debounced disk-save. Each thread carries its own timer + payload
 * snapshot so a rapid thread switch can't drop a pending save or write one
 * thread's messages under another thread's id.
 *
 * A monotonic generation token still lets `load(force)` invalidate all queued
 * saves at once, so a backup import can't get overwritten by stale persists
 * landing just after.
 */
const SAVE_DEBOUNCE_MS = 1200

interface PendingSave {
  threadId: string
  messages: ChatMessage[]
  summary: HistorySummary | null
}

interface SaveSlot {
  timer: ReturnType<typeof setTimeout>
  payload: PendingSave
}

const savesByThread = new Map<string, SaveSlot>()

function snapshotForActive(): PendingSave | null {
  const state = useChatStore.getState()
  if (!state.activeThreadId) return null
  return {
    threadId: state.activeThreadId,
    messages: state.messages.filter((m) => !m.streaming),
    summary: state.summary ?? null
  }
}

async function writeSlot(slot: SaveSlot): Promise<void> {
  await vs.history.saveThread(
    slot.payload.threadId,
    slot.payload.messages,
    slot.payload.summary
  )
}

function scheduleHistorySave(): void {
  const snapshot = snapshotForActive()
  if (!snapshot) return
  const { threadId } = snapshot
  const existing = savesByThread.get(threadId)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    const slot = savesByThread.get(threadId)
    if (!slot) return
    savesByThread.delete(threadId)
    void writeSlot(slot)
  }, SAVE_DEBOUNCE_MS)

  savesByThread.set(threadId, { timer, payload: snapshot })
}

/**
 * Synchronously flush a thread's pending save right now — used on thread
 * switch / create. Idempotent. Fire-and-forget; the caller doesn't need to
 * await the write because the next navigation isn't gated on it.
 */
function flushPendingSave(threadId: string | null | undefined): void {
  if (!threadId) return
  const slot = savesByThread.get(threadId)
  if (!slot) return
  clearTimeout(slot.timer)
  savesByThread.delete(threadId)
  void writeSlot(slot)
}

/**
 * Awaitable flush of EVERY pending save — used by the main process before
 * quit so debounced writes in the 1.2s window don't get dropped on the
 * floor. Returns when SQLite has confirmed each thread's write.
 */
export async function flushAllPendingSavesAsync(): Promise<void> {
  const slots = Array.from(savesByThread.values())
  for (const slot of slots) clearTimeout(slot.timer)
  savesByThread.clear()
  // Fire all writes in parallel — they're independent threads, no ordering
  // matters. allSettled rather than all so one corrupt thread's write
  // failure (db locked, disk full, JSON serialization throw) doesn't reject
  // the whole batch and lose the other threads' debounced saves on quit.
  const results = await Promise.allSettled(slots.map((s) => writeSlot(s)))
  for (const r of results) {
    if (r.status === 'rejected') {
      // Best-effort log so quit-time data loss leaves a trace. Can't toast —
      // the window is already on the way down.
      console.error('[useChatStore] flushAllPendingSavesAsync — slot failed:', r.reason)
    }
  }
}

function invalidatePendingSaves(): void {
  for (const slot of savesByThread.values()) clearTimeout(slot.timer)
  savesByThread.clear()
}

/** Converts UI messages to provider-agnostic turns (prior tool runs collapse to text). */
function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .filter((m) => {
      if (m.id === WELCOME_MESSAGE_ID) return false
      if (m.role !== 'user' && m.role !== 'assistant') return false
      if (m.role === 'assistant' && m.error) return false
      if (m.role === 'assistant' && !m.content && !m.toolCalls?.length) return false
      return true
    })
    .map((m) => {
      let body = composeContent(m)
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const summary = m.toolCalls.map((t) => `${t.name}${t.ok ? '✓' : '✗'}`).join(', ')
        body += `\n[Actions run: ${summary}]`
      }
      const images = (m.attachments ?? [])
        .filter((a) => a.kind === 'image' && a.dataUrl)
        .map((a) => a.dataUrl as string)
      return { role: m.role, content: body, ...(images.length ? { images } : {}) }
    })
}

interface ChatState {
  /** Active thread's working copy of messages. */
  messages: ChatMessage[]
  /** Active thread's cached "story so far" summary. */
  summary: HistorySummary | null
  /**
   * Lightweight sidebar list — every saved conversation as a summary, not the
   * full message log. Messages are fetched per-thread on switch.
   */
  threads: ThreadSummary[]
  /** Id of the thread currently shown. Null = no thread yet (fresh app). */
  activeThreadId: string | null

  attachments: ChatAttachment[]
  streaming: boolean
  pendingRequestId: string | null
  pendingAssistantId: string | null
  /**
   * Accumulated streamed tokens for the in-flight assistant turn. Lives in
   * its own slot so a 50 tok/s stream isn't cloning the entire `messages`
   * array per token — the bubble for `pendingAssistantId` reads its content
   * AND this delta, then folds the delta into the message on completion.
   */
  streamingContent: string
  /**
   * Currently-executing tool in the agent loop. Lets the chat surface a live
   * "Searching the web…" / "Running Python…" line while a tool is in-flight
   * (the post-hoc tool-call card only shows up AFTER the result lands, which
   * for a slow web search or shell command is several seconds of dead air).
   * Cleared as soon as the call returns; cleared en masse on stop/clear.
   */
  pendingTool: { name: string; args: Record<string, unknown> } | null
  pendingInsert: string | null

  send: (text: string) => Promise<void>
  stop: () => void
  /** Wipes the active thread's messages (the thread itself stays listed). */
  clear: () => void
  /**
   * Loads the persisted thread summaries + the active thread's messages.
   * Passing `force: true` replaces the in-memory state unconditionally
   * (used after a backup import).
   */
  load: (force?: boolean) => Promise<void>
  /** Sets the cached "story so far" recap for the active thread. */
  setSummary: (summary: HistorySummary) => void
  clearSummary: () => Promise<void>

  /** Creates a new thread and switches to it. */
  createThread: () => Promise<ThreadSummary>
  /** Switches to an existing thread. No-op while a reply is streaming. */
  switchThread: (id: string) => Promise<void>
  renameThread: (id: string, title: string) => Promise<void>
  /** Toggles whether a thread is pinned to the top of the sidebar. */
  togglePinned: (id: string) => Promise<void>
  /** Per-thread mode override; pass null to follow the global mode. */
  setThreadMode: (id: string, mode: ModeId | null) => Promise<void>
  /** Per-thread system-prompt override; pass null to follow the global. */
  setThreadSystemPrompt: (id: string, prompt: string | null) => Promise<void>
  deleteThread: (id: string) => Promise<void>
  clearAllThreads: () => Promise<void>

  addImageAttachment: (name: string, dataUrl: string) => void
  addTextAttachment: (name: string, text: string) => void
  /** PDF — `text` powers the model side, `dataUrl` powers the inline preview. */
  addPdfAttachment: (name: string, text: string, dataUrl: string) => void
  removeAttachment: (id: string) => void
  requestInsert: (text: string) => void
  clearInsert: () => void
  applyChunk: (chunk: ChatStreamChunk) => void
  /** User closed the streaming-artifact canvas; suppress further pushes
   *  until the next send() resets the flag. */
  dismissStreamArtifact: () => void
  /**
   * Sticky per-thread model override. When set, future messages in the
   * active thread use this model id instead of the provider's default —
   * lets the user say "this thread should use gpt-4o for vision" without
   * touching their global settings. Cleared on thread switch.
   */
  modelOverride: string | null
  setModelOverride: (model: string | null) => void

  /**
   * Crash-recovery entry point. Called when the user clicks "Resume" on
   * a stale checkpoint (one whose row is still at status='running' from
   * a previous session). Switches to the checkpoint's thread, cleans up
   * the orphan streaming bubble, drops a synthetic "[Resume]" user turn,
   * and fires send() — the agent loop sees the full conversation
   * history with its earlier tool calls and picks up from where it
   * stopped. Deletes the old checkpoint so the new send() creates a
   * fresh row.
   */
  resumeFromCheckpoint: (checkpoint: AgentCheckpoint) => Promise<void>
}

/**
 * Module-scope flag tracking whether the user has dismissed the live-stream
 * artifact for the CURRENT assistant turn. Reset on every new `send()` so
 * each new reply gets its own chance to surface a canvas. State lives outside
 * Zustand because (a) it's a single boolean, (b) no component subscribes to
 * it directly — applyChunk reads, dismiss action sets, send resets.
 */
let streamArtifactDismissed = false

/**
 * Active streaming-TTS speaker for the current send(). Lives at module
 * scope because applyChunk (which feeds the speaker) runs in a different
 * call context than send() (which constructs it). The `requestId` field
 * makes stale instances safe to ignore — if a new send replaces this,
 * any late chunk for an older requestId no-ops out.
 */
let activeSpeaker: { speaker: StreamingSpeaker; requestId: string } | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [welcomeMessage()],
  summary: null,
  threads: [],
  activeThreadId: null,
  attachments: [],
  streaming: false,
  modelOverride: null,
  pendingRequestId: null,
  pendingAssistantId: null,
  streamingContent: '',
  pendingTool: null,
  pendingInsert: null,

  send: async (text) => {
    const content = text.trim()
    const { attachments, streaming, messages } = get()
    if (streaming) return
    // Each new turn gets a fresh shot at surfacing an artifact even if the
    // user dismissed the canvas during the previous reply.
    streamArtifactDismissed = false
    if (!content && attachments.length === 0) return

    const config = useConfigStore.getState().config
    if (!config) {
      useUiStore.getState().pushToast('error', 'Configuration is still loading.')
      return
    }
    const activeProvider = config.providers.find((p) => p.id === config.activeProvider)
    if (!activeProvider) {
      // Active provider id doesn't resolve — config drift. Surface it so the
      // user isn't typing into the void.
      useUiStore
        .getState()
        .pushToast('error', 'No AI provider is configured. Open Settings to pick one.')
      void vs.window.openSettings()
      return
    }
    if (activeProvider.needsKey && !activeProvider.hasKey) {
      useUiStore
        .getState()
        .pushToast('error', `${activeProvider.label} needs an API key — opening Settings.`)
      void vs.window.openSettings()
      return
    }

    // Router pass — if the user has multiple providers configured and
    // hasn't set a per-thread sticky model override, pick the best
    // provider+model for the task at hand (vision-capable for images,
    // fast tool-use for agent loops, strong reasoning for analysis,
    // etc.). The per-thread override is treated as the user's explicit
    // intent and always wins — the router stays silent in that case.
    const override = get().modelOverride
    const hasImage = attachments.some((a) => a.kind === 'image')
    let provider = activeProvider
    let effectiveModel = override || activeProvider.model
    if (!override) {
      const available = config.providers.map<AvailableProvider>((p) => ({
        id: p.id,
        model: p.model,
        usable: p.needsKey ? p.hasKey : Boolean(p.localReady),
        isLocal: !p.needsKey
      }))
      // Cost-aware bias. Fetch the current month's spend + cap so the
      // router can push toward cheap/local when the user is within 20%
      // of their cap. Failures are best-effort — usage IPC hiccups
      // shouldn't block a chat send, but they ARE logged so a pattern
      // of failures is visible in the system log instead of silently
      // turning the cost bias into a no-op.
      let budget: { nearCap: boolean } | undefined
      try {
        const [summary, budgetCfg] = await Promise.all([
          vs.usage.summary(),
          vs.usage.getBudget()
        ])
        budget = deriveBudgetState(summary.totalCost, budgetCfg.monthlyUsd)
      } catch (err) {
        void vs.logs.write(
          'warn',
          'ai',
          'Router: usage IPC failed, routing without cost bias',
          err instanceof Error ? err.message : String(err)
        )
      }
      const pick = pickProvider({
        prompt: content,
        hasImages: hasImage,
        agentMode: config.chat.agent,
        available,
        activeProviderId: config.activeProvider,
        budget
      })
      if (pick && pick.overrideOfActive) {
        const swapped = config.providers.find((p) => p.id === pick.providerId)
        if (swapped) {
          provider = swapped
          effectiveModel = pick.modelId
          // Quiet log only — the assistant bubble already shows the model
          // it answered with via the `model:` stamp, so the user sees the
          // routing decision in the bubble rather than as a separate toast.
          void vs.logs.write('info', 'ai', `Routed to ${pick.reason}`)
        }
      }
    }
    // Image attached but the routed-to model can't see images. Should be
    // rare now that the router prefers vision-capable models when an
    // image is attached, but the warning stays as a safety net for the
    // case where no vision-capable provider is configured at all.
    if (hasImage && !modelHasVision(effectiveModel)) {
      useUiStore
        .getState()
        .pushToast(
          'info',
          `${effectiveModel} can't see images — sending the text only. Switch to a vision-capable model to use the attachment.`
        )
    }

    // First message anywhere? Spin up a thread to anchor everything to.
    if (!get().activeThreadId && !config.chat.private) {
      const thread = await vs.history.createThread()
      set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id }))
    }

    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content,
      attachments: attachments.length ? attachments : undefined,
      createdAt: new Date().toISOString()
    }
    const assistantId = uid()
    const requestId = uid()
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: new Date().toISOString(),
      // Stamp the model that's about to answer so a later override change
      // or thread switch can't retroactively relabel this turn.
      model: effectiveModel
    }

    stopSpeaking()
    // Streaming-TTS speaker: built ONCE per send so the persona / voice
    // URI / rate stay consistent across the run, even if the user opens
    // Settings and changes them mid-reply. Skipped when voice is off
    // or DND is silencing — leaves `activeSpeaker` null and applyChunk
    // / agent-step feeders no-op out.
    activeSpeaker = null
    if (config.voice.enabled && !isQuietNow(config.appearance.dnd)) {
      activeSpeaker = {
        speaker: new StreamingSpeaker(config.voice),
        requestId
      }
    }
    set({
      messages: [...messages, userMessage, assistantMessage],
      attachments: [],
      streaming: true,
      pendingRequestId: requestId,
      pendingAssistantId: assistantId,
      streamingContent: '',
      pendingTool: null
    })
    useWidgetStore.getState().setOrbState('processing')

    const patch = (changes: Partial<ChatMessage>): void =>
      set((state) => ({
        messages: state.messages.map((m) => (m.id === assistantId ? { ...m, ...changes } : m))
      }))
    const isActive = (): boolean => get().pendingRequestId === requestId

    let finalText = ''
    let failure: string | null = null
    // Distinguishes "agent paused mid-task, recoverable" from "agent
    // failed, surface as error". Pause = no red orb, no error toast,
    // softer bubble prefix. Currently only set when MAX_AGENT_STEPS
    // is hit before the model finished — typing "continue" resumes
    // the work because the conversation history already has the
    // tool-call breadcrumbs.
    let isPause = false

    // Wrap the whole send body — prepareConversation, agent loop, chat call,
    // tool runners — in a try/catch. Without this, any uncaught throw
    // (prepareConversation parse failure, JSON crash inside a tool, a
    // type error in the response handler) left `streaming: true` set
    // forever and the assistant bubble animating the dots with no way to
    // recover short of refreshing the panel.
    try {
      // Trim the conversation to fit the model's window. When the chat is
      // long enough, this rolls older turns into a cached "story so far"
      // summary and only sends the recent tail verbatim — keeping
      // continuity without us silently dropping the front of the
      // conversation.
      const { system, turns: baseTurns } = await prepareConversation([
        ...messages,
        userMessage
      ])

      if (config.chat.agent) {
      const turns: ChatTurn[] = [...baseTurns]
      const invocations: ToolInvocation[] = []

      // Track WHY the loop exited so the user always sees a reason. Without
      // this distinction, hitting MAX_AGENT_STEPS, the model returning empty
      // tools, and a clean completion all looked identical in the UI.
      let exitReason: 'completed' | 'step-cap' | 'aborted' | 'error' = 'completed'
      let step = 0

      // Persistent checkpoint of the agent run — survives panel close,
      // app restart, and process crash. Best-effort: a checkpoint write
      // failure is logged but never blocks the loop (the loop's own
      // in-memory state is the source of truth at runtime; checkpoints
      // exist for crash recovery only).
      //
      // Skipped in private mode — private threads leave no trace on disk
      // and that includes the checkpoint table. Also skipped when there
      // is no active thread (rare edge case).
      const checkpointThreadId = get().activeThreadId
      const checkpointEnabled =
        !config.chat.private && checkpointThreadId !== null
      if (checkpointEnabled) {
        void vs.agentCheckpoint
          .create({
            requestId,
            threadId: checkpointThreadId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantId,
            providerId: provider.id,
            modelId: effectiveModel,
            systemPrompt: system,
            turns: sanitiseTurnsForCheckpoint(baseTurns)
          })
          .catch((err) => {
            void vs.logs.write(
              'warn',
              'system',
              'Agent checkpoint create failed',
              err instanceof Error ? err.message : String(err)
            )
          })
      }

      for (; step < MAX_AGENT_STEPS; step++) {
        if (!isActive()) {
          exitReason = 'aborted'
          break
        }
        // Rolling-summary compaction. If the agent has accumulated
        // enough context to threaten the model's window, fold the
        // older turns into a STORY-SO-FAR recap before this step's
        // invoke. No-op when we're well under the budget — cheap
        // token estimate gates the actual LLM call so the per-step
        // overhead is just a character count on the turns array.
        //
        // Provider override is the ROUTED-TO provider, not
        // config.activeProvider. Stops the summariser from picking
        // a provider whose key the user doesn't have configured
        // when the router has moved this loop to a different one.
        const compaction = await compactTurnsIfNeeded(
          turns,
          effectiveModel,
          !provider.needsKey,
          { providerId: provider.id, modelId: effectiveModel }
        )
        if (compaction.compacted) {
          turns.splice(0, turns.length, ...compaction.turns)
        }
        const result = await vs.ai.invoke({
          requestId,
          provider: provider.id,
          model: effectiveModel,
          system,
          messages: turns
        })
        if (result.error) {
          if (result.error !== 'aborted') {
            failure = result.error
            exitReason = 'error'
          } else {
            exitReason = 'aborted'
          }
          break
        }
        if (result.text.trim()) {
          finalText = finalText ? `${finalText}\n\n${result.text}` : result.text
        }
        patch({ content: finalText, toolCalls: invocations.length ? [...invocations] : undefined })
        // Streaming TTS for the agent path. Each step's text lands all
        // at once (invoke is non-streaming, unlike chat), so feed the
        // accumulated finalText after every step. The speaker tracks
        // its own spokenIndex so already-spoken content isn't repeated.
        if (activeSpeaker && activeSpeaker.requestId === requestId && result.text.trim()) {
          activeSpeaker.speaker.feed(finalText)
        }
        if (result.toolCalls.length === 0) {
          exitReason = 'completed'
          break
        }

        turns.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
        const toolResults: Array<{ id: string; name: string; content: string }> = []
        const newImages: string[] = []
        for (const call of result.toolCalls) {
          if (!isActive()) break
          // Surface a live "Running …" line while the tool is in-flight so
          // the user has feedback during slow calls (web search, run_python,
          // long shell commands). Cleared as soon as the result lands.
          set({ pendingTool: { name: call.name, args: call.args } })
          // Pass the agent loop's requestId so the tool's abort controller
          // registers against the same key the LLM call uses — Stop then
          // kills in-flight tool fetch / subprocess too, not just the LLM.
          const invocation = await runAgentTool(call, requestId)
          set({ pendingTool: null })
          invocations.push(invocation)
          toolResults.push({ id: call.id, name: call.name, content: invocation.result })
          if (invocation.image) newImages.push(invocation.image)
          patch({ toolCalls: [...invocations] })
        }
        turns.push({ role: 'tool', content: '', toolResults })
        // If a tool produced screenshots, follow up with a synthetic user
        // turn carrying the images so vision-capable models can actually look.
        if (newImages.length > 0) {
          turns.push({
            role: 'user',
            content:
              newImages.length === 1
                ? 'Here is the current screen for you to look at.'
                : `Here are ${newImages.length} screenshots for you to look at.`,
            images: newImages
          })
        }

        // Persist the step. Fire-and-forget — a write failure here
        // doesn't kill the loop; the next step's write will catch up.
        // The +1 captures "step just completed" so a crash after this
        // write resumes at the right boundary.
        if (checkpointEnabled) {
          void vs.agentCheckpoint
            .update(requestId, {
              step: step + 1,
              turns: sanitiseTurnsForCheckpoint(turns),
              invocations: sanitiseInvocationsForCheckpoint(invocations)
            })
            .catch((err) => {
              void vs.logs.write(
                'warn',
                'system',
                'Agent checkpoint update failed',
                err instanceof Error ? err.message : String(err)
              )
            })
        }
      }
      // Step cap hit while the model still wanted more tools — that's an
      // incomplete run, NOT a successful one. Surface it as a PAUSE
      // (recoverable) rather than an ERROR (failed). Typing "continue"
      // resumes the work because the conversation history already has
      // the tool-call breadcrumbs and the agent re-orients from there.
      if (step >= MAX_AGENT_STEPS && exitReason === 'completed') {
        exitReason = 'step-cap'
        isPause = true
        failure = `Reached the ${MAX_AGENT_STEPS}-step agent ceiling before finishing — type "continue" to keep going.`
      }

      // Finalise the checkpoint row — terminal status, no more writes.
      // Maps the loop's exitReason onto the canonical AgentCheckpointStatus.
      // `step-cap` → `paused` (recoverable via "continue"), everything
      // else maps 1:1. Aborted loops still finalise so the crash-recovery
      // UI doesn't pick them up as candidates.
      if (checkpointEnabled) {
        const status: 'paused' | 'completed' | 'failed' | 'aborted' =
          exitReason === 'step-cap'
            ? 'paused'
            : exitReason === 'aborted'
              ? 'aborted'
              : exitReason === 'error'
                ? 'failed'
                : 'completed'
        void vs.agentCheckpoint
          .finalize(requestId, status, failure)
          .catch((err) => {
            void vs.logs.write(
              'warn',
              'system',
              'Agent checkpoint finalize failed',
              err instanceof Error ? err.message : String(err)
            )
          })
      }

      // Preserve whatever the agent had already produced (multi-step finalText
      // or anything streamed in) if abort/error wipes the new finalText.
      // Gate the final write on the request still being active — `clear()`
      // or a thread switch mid-loop nulls `pendingRequestId`, and we must
      // NOT retro-write into a placeholder bubble that no longer belongs to
      // the current chat.
      if (isActive()) {
        const currentAgent = get().messages.find((m) => m.id === assistantId)?.content ?? ''
        const failureContent = isPause
          ? `${finalText || currentAgent ? `${finalText || currentAgent}\n\n` : ''}${formatPauseContent(failure!)}`
          : formatErrorContent(failure ?? '')
        patch({
          streaming: false,
          // Pause is NOT an error — bubble keeps its normal styling and
          // the orb won't flash red downstream.
          error: Boolean(failure) && !isPause,
          content: failure
            ? failureContent
            : finalText || currentAgent || CHAT_STRINGS.noResponse,
          toolCalls: invocations.length ? invocations : undefined
        })
      }
    } else {
      let done: { text: string; error?: string }
      try {
        done = await vs.ai.chat({
          requestId,
          provider: provider.id,
          model: effectiveModel,
          system,
          messages: baseTurns
        })
      } catch (err) {
        done = { text: '', error: err instanceof Error ? err.message : String(err) }
      }
      failure = done.error && done.error !== 'aborted' ? done.error : null
      finalText = done.text
      // Same guard as the agent path — don't write into a cleared/switched chat.
      if (isActive()) {
        // The streaming slot holds the tokens accumulated by `applyChunk`;
        // fold it into the message now and let the bubble read directly
        // from `content` once the slot is reset below.
        const streamed = get().streamingContent
        patch({
          streaming: false,
          error: Boolean(failure),
          content: failure
            ? streamed || formatErrorContent(done.error ?? 'Request failed')
            : done.text || streamed || CHAT_STRINGS.noResponse
        })
      }
    }
    } catch (err) {
      // Uncaught throw from prepareConversation, the agent loop, a tool
      // runner, or somewhere in the response handler. Without this guard
      // the streaming flag never reset — assistant bubble animated the
      // dots forever and the user had to refresh the panel to recover.
      failure = err instanceof Error ? err.message : String(err)
      if (isActive()) {
        const streamed = get().streamingContent
        patch({
          streaming: false,
          error: true,
          content: streamed || formatErrorContent(failure)
        })
      }
      // Best-effort: mark the checkpoint failed so it isn't picked up
      // by the crash-recovery UI on the next launch. The row may not
      // exist (non-agent path / private mode / create failed silently)
      // — the SQL UPDATE harmlessly matches zero rows in that case.
      void vs.agentCheckpoint.finalize(requestId, 'failed', failure).catch(() => {
        /* best-effort */
      })
    }

    // Only clear streaming/pending bookkeeping if this request still owns them.
    // A clear()/switch may have already reset these — we mustn't unwind a
    // newer, unrelated request that happened to start before we got here.
    if (isActive()) {
      set({
        streaming: false,
        pendingRequestId: null,
        pendingAssistantId: null,
        streamingContent: '',
        pendingTool: null
      })
    } else {
      // The request was abandoned mid-flight; bail out before the post-success
      // bookkeeping (history save, fact extraction, TTS) runs against the
      // wrong thread or an empty placeholder.
      return
    }
    // Pause keeps the orb neutral (success) — the work is intact and
    // recoverable via "continue", so flashing the red error state would
    // misrepresent the situation. Real failures still flash red.
    useWidgetStore
      .getState()
      .setOrbState(failure && !isPause ? 'error' : 'success')
    if (failure && !isPause) {
      useUiStore.getState().pushToast('error', failure)
    } else if (failure && isPause) {
      // Pauses get an info toast — visible but non-alarming.
      useUiStore.getState().pushToast('info', failure)
    } else {
      // Persist the updated transcript and quietly extract any new long-term
      // facts in the background — unless private mode is on, in which case
      // this conversation leaves no trace on disk or in long-term memory.
      const privateChat = useConfigStore.getState().config?.chat.private ?? false
      if (!privateChat) {
        const state = get()
        const activeId = state.activeThreadId
        // Auto-title a freshly-named thread from the first user message.
        if (activeId) {
          const thread = state.threads.find((t) => t.id === activeId)
          if (thread && PLACEHOLDER_TITLES.has(thread.title)) {
            const next = deriveTitle(state.messages)
            if (next) {
              void vs.history.renameThread(activeId, next).then((updated) => {
                if (updated)
                  set((s) => ({
                    threads: s.threads.map((t) => (t.id === activeId ? updated : t))
                  }))
              })
            }
          }
          // Sync the active thread's summary (count / preview / updatedAt /
          // summary recap) — the sidebar shows these, but the messages
          // themselves stay in `state.messages`, not duplicated per-thread.
          set((s) => ({
            threads: s.threads.map((t) =>
              t.id === activeId
                ? {
                    ...t,
                    summary: s.summary,
                    messageCount: s.messages.filter((m) => m.id !== WELCOME_MESSAGE_ID).length,
                    updatedAt: new Date().toISOString()
                  }
                : t
            )
          }))
        }
        scheduleHistorySave()
        void extractFacts(get().messages)
      }
      if (finalText && activeSpeaker && activeSpeaker.requestId === requestId) {
        // Flush the trailing fragment — covers a final sentence that
        // didn't end in punctuation, or any text the chunker held back
        // behind an unclosed code fence that closed at the end of the
        // stream. enqueueSpeak no-ops on an empty tail, so calling
        // this unconditionally is safe even when the speaker already
        // emitted everything mid-stream.
        activeSpeaker.speaker.flush(finalText)
      }
      activeSpeaker = null
    }
  },

  stop: () => {
    stopSpeaking()
    // Drop the streaming speaker so a stale feed() from an in-flight chunk
    // can't queue more sentences after the user hit Stop.
    activeSpeaker = null
    const state = get()
    const requestId = state.pendingRequestId
    const assistantId = state.pendingAssistantId
    const streamed = state.streamingContent
    if (requestId) void vs.ai.abort(requestId)
    // Settle the placeholder bubble — without this the send-loop's active
    // guard skips its final patch, and the assistant message stays stuck
    // with `streaming: true`, animating the dots forever.
    set((s) => ({
      streaming: false,
      pendingRequestId: null,
      pendingAssistantId: null,
      streamingContent: '',
      pendingTool: null,
      messages: assistantId
        ? s.messages.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  // Preserve whatever the streaming slot accumulated; only
                  // fill a placeholder when nothing arrived yet so the user
                  // sees a clean "stopped" line instead of an empty bubble.
                  content: streamed || m.content || CHAT_STRINGS.stopped
                }
              : m
          )
        : s.messages
    }))
  },

  clear: () => {
    invalidatePendingSaves()
    const state = get()
    set({
      messages: [welcomeMessage()],
      attachments: [],
      streaming: false,
      pendingRequestId: null,
      pendingAssistantId: null,
      streamingContent: '',
      pendingTool: null,
      summary: null,
      threads: state.threads.map((t) =>
        t.id === state.activeThreadId
          ? { ...t, messages: [], summary: null, updatedAt: new Date().toISOString() }
          : t
      )
    })
    if (state.activeThreadId) void vs.history.clearThread(state.activeThreadId)
  },

  load: async (force) => {
    // Don't clobber an active conversation that started before load resolved
    // — unless an explicit force is requested (e.g. just-imported backup).
    if (!force && (get().messages.length > 1 || get().streaming)) return
    invalidatePendingSaves()
    const { summaries, activeThreadId } = await vs.history.summaries()
    const active = activeThreadId ? summaries.find((t) => t.id === activeThreadId) : undefined
    // Only the active thread's messages get pulled at load time — every
    // other thread stays as a lightweight summary in the sidebar.
    const messages = active ? await vs.history.getMessages(active.id) : []
    set({
      threads: summaries,
      activeThreadId: active?.id ?? null,
      messages: messages.length > 0 ? messages : [welcomeMessage()],
      summary: active?.summary ?? null,
      attachments: [],
      streaming: false,
      pendingRequestId: null,
      pendingAssistantId: null,
      streamingContent: ''
    })
  },

  setSummary: (summary) => {
    const state = get()
    const activeId = state.activeThreadId
    set({
      summary,
      threads: state.threads.map((t) =>
        t.id === activeId
          ? { ...t, summary, updatedAt: new Date().toISOString() }
          : t
      )
    })
    // Schedule a debounced save so non-`send` callers (e.g. a future
    // "regenerate summary" button) still persist; the active `send` path
    // already schedules its own save after the assistant turn lands, and
    // the per-thread debounce coalesces both into one disk write.
    scheduleHistorySave()
  },

  clearSummary: async () => {
    const state = get()
    const cleanMessages = state.messages.filter((m) => !m.streaming)
    set({
      summary: null,
      threads: state.threads.map((t) =>
        t.id === state.activeThreadId ? { ...t, summary: null } : t
      )
    })
    if (state.activeThreadId) {
      await vs.history.saveThread(state.activeThreadId, cleanMessages, null)
    }
  },

  createThread: async () => {
    // Flush whatever the previous thread had buffered so the disk reflects it
    // before we navigate away. flushPendingSave is a no-op if nothing's
    // pending for that thread.
    flushPendingSave(get().activeThreadId)
    const summary = await vs.history.createThread()
    set((s) => ({
      threads: [summary, ...s.threads.filter((t) => t.id !== summary.id)],
      activeThreadId: summary.id,
      messages: [welcomeMessage()],
      summary: null,
      attachments: [],
      streaming: false,
      pendingRequestId: null,
      pendingAssistantId: null,
      streamingContent: '',
      modelOverride: null
    }))
    return summary
  },

  switchThread: async (id) => {
    const state = get()
    if (state.activeThreadId === id) return
    if (state.streaming) {
      useUiStore.getState().pushToast('info', CHAT_STRINGS.waitForStream)
      return
    }
    const target = state.threads.find((t) => t.id === id)
    if (!target) return
    // Flush the leaving thread's pending save before swapping in-memory state.
    flushPendingSave(state.activeThreadId)
    // Pull just this thread's messages — the sidebar only holds summaries.
    const messages = await vs.history.getMessages(id)
    set({
      activeThreadId: id,
      messages: messages.length > 0 ? messages : [welcomeMessage()],
      summary: target.summary ?? null,
      attachments: [],
      modelOverride: null
    })
    void vs.history.setActiveThread(id)
  },

  resumeFromCheckpoint: async (checkpoint) => {
    // Don't trample an active reply. The checkpoint itself is from a
    // previous session, but the user could plausibly click Resume
    // while a fresh chat is mid-stream in the current session —
    // surface a toast and skip rather than orphaning the live request.
    const state = get()
    if (state.streaming) {
      useUiStore.getState().pushToast('info', CHAT_STRINGS.waitForStream)
      return
    }
    // Switch to the checkpoint's thread if it still exists in the
    // sidebar. If the user deleted the thread between sessions, we
    // can't usefully resume — show a friendly error instead of
    // silently materialising a blank chat.
    const target = state.threads.find((t) => t.id === checkpoint.threadId)
    if (!target) {
      useUiStore
        .getState()
        .pushToast(
          'error',
          'Original thread was deleted — resume not possible. Discarding checkpoint.'
        )
      void vs.agentCheckpoint.delete(checkpoint.requestId).catch(() => {
        /* best-effort */
      })
      return
    }
    if (state.activeThreadId !== checkpoint.threadId) {
      const messages = await vs.history.getMessages(checkpoint.threadId)
      flushPendingSave(state.activeThreadId)
      set({
        activeThreadId: checkpoint.threadId,
        messages: messages.length > 0 ? messages : [welcomeMessage()],
        summary: target.summary ?? null,
        attachments: [],
        modelOverride: null
      })
      void vs.history.setActiveThread(checkpoint.threadId)
    }
    // Cleanup pass: the assistant bubble we left behind when the
    // process died likely has `streaming: true` and possibly empty
    // content. Clear those flags so the user sees a stable bubble
    // before the new agent loop starts adding to the thread.
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === checkpoint.assistantMessageId
          ? { ...m, streaming: false, error: false }
          : m
      )
    }))
    // Drop the old checkpoint row — the new send() below will INSERT
    // a fresh one with its own requestId. Keeping the old row would
    // confuse the next boot's recovery scan.
    void vs.agentCheckpoint.delete(checkpoint.requestId).catch(() => {
      /* best-effort */
    })
    // Kick off a fresh agent round. The conversation history already
    // contains the partial assistant output + every tool call & result
    // from before the crash, so the model has everything it needs to
    // pick up from where the previous loop stopped.
    //
    // When the previous loop hadn't yet completed any tool calls (the
    // crash happened during the very first invoke), the "continue"
    // prompt would land on a thread with no recent agent context and
    // the model would re-answer the original prompt as if fresh.
    // Include the step number as a hint so the model knows we're
    // resuming partway through — minor but reduces the chance of a
    // bland restart-from-scratch answer.
    const hadProgress = checkpoint.step > 0 || checkpoint.invocations.length > 0
    const resumePrompt = hadProgress
      ? `Continue from where you left off (resumed after step ${checkpoint.step}).`
      : 'Continue with the task you started.'
    await get().send(resumePrompt)
  },

  renameThread: async (id, title) => {
    const updated = await vs.history.renameThread(id, title)
    if (!updated) return
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? updated : t))
    }))
  },

  togglePinned: async (id) => {
    const thread = get().threads.find((t) => t.id === id)
    if (!thread) return
    const updated = await vs.history.setPinned(id, !thread.pinned)
    if (!updated) return
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? updated : t))
    }))
  },

  setThreadMode: async (id, mode) => {
    const updated = await vs.history.setThreadMode(id, mode)
    if (!updated) return
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? updated : t))
    }))
  },

  setThreadSystemPrompt: async (id, prompt) => {
    const updated = await vs.history.setThreadSystemPrompt(id, prompt)
    if (!updated) return
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? updated : t))
    }))
  },

  deleteThread: async (id) => {
    const wasActive = get().activeThreadId === id
    // Drop the deleted thread's debounced save before the IPC fires —
    // otherwise the timer wakes up ~1.2s later and writes to a row that's
    // already been removed.
    const slot = savesByThread.get(id)
    if (slot) {
      clearTimeout(slot.timer)
      savesByThread.delete(id)
    }
    const result = await vs.history.deleteThread(id)
    const nextActive = result.activeThreadId
      ? result.summaries.find((t) => t.id === result.activeThreadId)
      : undefined
    // If the active thread was the one deleted, hydrate the messages of
    // whichever thread the main process picked as the new active.
    const nextMessages = wasActive && nextActive
      ? await vs.history.getMessages(nextActive.id)
      : null
    set({
      threads: result.summaries,
      activeThreadId: result.activeThreadId,
      ...(wasActive
        ? {
            messages:
              nextMessages && nextMessages.length > 0 ? nextMessages : [welcomeMessage()],
            summary: nextActive?.summary ?? null,
            attachments: []
          }
        : {})
    })
  },

  clearAllThreads: async () => {
    invalidatePendingSaves()
    await vs.history.clearAll()
    set({
      threads: [],
      activeThreadId: null,
      messages: [welcomeMessage()],
      summary: null,
      attachments: [],
      streaming: false,
      pendingRequestId: null,
      pendingAssistantId: null,
      streamingContent: '',
      pendingTool: null,
      modelOverride: null
    })
  },

  addImageAttachment: (name, dataUrl) =>
    set((state) => ({
      attachments: [...state.attachments, { id: uid(), kind: 'image', name, dataUrl }]
    })),

  addTextAttachment: (name, text) =>
    set((state) => ({
      attachments: [...state.attachments, { id: uid(), kind: 'text', name, text }]
    })),

  addPdfAttachment: (name, text, dataUrl) =>
    set((state) => ({
      attachments: [...state.attachments, { id: uid(), kind: 'pdf', name, text, dataUrl }]
    })),

  removeAttachment: (id) =>
    set((state) => ({ attachments: state.attachments.filter((a) => a.id !== id) })),

  requestInsert: (text) => set({ pendingInsert: text }),

  clearInsert: () => set({ pendingInsert: null }),

  applyChunk: (chunk) => {
    const { pendingRequestId, pendingAssistantId } = get()
    if (!pendingAssistantId || chunk.requestId !== pendingRequestId) return
    // Only the streaming slot moves — components subscribed to `messages`
    // don't re-render at all during a stream.
    const next = get().streamingContent + chunk.delta
    set({ streamingContent: next })
    // Streaming TTS — speak any sentences that just completed. The
    // requestId guard skips this if a newer send has rotated the
    // speaker out; the speaker itself no-ops on chunks that don't
    // contain a sentence boundary, so this stays cheap.
    if (activeSpeaker && activeSpeaker.requestId === pendingRequestId) {
      activeSpeaker.speaker.feed(next)
    }
    // Streaming-artifact detection. If the assistant is currently writing a
    // substantial fenced code block, push it into the Canvas dialog live so
    // the user watches the code grow — Claude's "Artifacts" paradigm. The
    // detector is conservative: short snippets stay inline; only blocks
    // ≥200 chars OR ≥8 lines with a language tag elevate to the canvas.
    if (!streamArtifactDismissed) {
      const candidate = detectArtifact(next)
      if (candidate) {
        const current = useUiStore.getState().canvasContent
        // Only refresh when the code has actually grown — avoids a setState
        // cascade on every delta when the block has paused mid-stream.
        if (!current || current.code.length < candidate.code.length) {
          useUiStore
            .getState()
            .setCanvas({ code: candidate.code, language: candidate.language })
        }
      }
    }
  },

  dismissStreamArtifact: () => {
    streamArtifactDismissed = true
    useUiStore.getState().setCanvas(null)
  },

  setModelOverride: (model) => set({ modelOverride: model })
}))

// Funnel streamed tokens from the main process into the active assistant
// message. Exported as a hook caller so it lives inside React's lifecycle —
// the previous module-scope `vs.events.onChunk(...)` subscription leaked
// duplicate handlers on HMR (every reload re-evaluated this file and added
// another listener without unbinding the previous one), causing each token
// to apply multiple times in dev. Wired from `App.tsx` in a useEffect.
export function subscribeChatChunks(): () => void {
  return vs.events.onChunk((chunk) => useChatStore.getState().applyChunk(chunk))
}
