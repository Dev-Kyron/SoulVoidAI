/**
 * Ephemeral UI state: toast notifications, the interactive permission prompt,
 * and the latest active-window context from screen awareness.
 */
import { create } from 'zustand'
import { uid } from '../lib/utils'
import type { ActiveWindowInfo, AgentCheckpoint, ScreenSnapshot } from '@shared/types'
import type { PermissionId } from '@shared/permissions'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  /** When present, the toast shows an "Undo" button for this action. */
  undoId?: string
}

interface PermissionPrompt {
  permission: PermissionId
  actionLabel: string
  resolve: (granted: boolean) => void
}

/**
 * v1.12.3 — per-command approval for `run_shell`. The blanket `terminal`
 * permission is too coarse: once granted, an agent can `rm -rf` without
 * a peep. This modal fires BEFORE every shell call (even when terminal
 * is already granted) so the user sees the exact command + cwd and can
 * cancel anything unexpected. Same queue mechanic as PermissionPrompt
 * for parallel-tool-call safety.
 */
interface ShellApprovalPrompt {
  command: string
  cwd: string | null
  resolve: (approved: boolean) => void
}

/**
 * v1.13.0 — per-write approval for `write_file`. Same shape as shell
 * approval: fires BEFORE the write so the user sees the path + a unified
 * diff (or full-content preview for new files) and can cancel. This is
 * the "feels like Claude / Cursor" piece — agent edits land as proposed
 * changes the user reviews, not as silent overwrites. The undo system
 * inside writeTextFile still works as a backstop, but propose-then-apply
 * is the primary safety surface now.
 */
interface WriteApprovalPrompt {
  path: string
  /** Existing file contents, or null when the file doesn't exist yet
   *  (new-file create). Drives whether the dialog renders a diff or a
   *  full new-content preview. */
  previousContent: string | null
  newContent: string
  /** Pre-computed unified diff text (created in the renderer via the
   *  `diff` package). For new files this is the full content prefixed
   *  with `+` markers. Held here so the dialog stays a dumb renderer. */
  unifiedDiff: string
  resolve: (approved: boolean) => void
}

/**
 * v2.0 — screen-reader announcement payload. `seq` increments on every
 * call so a `<LiveRegion>` keyed on it remounts the announcement text
 * even when the same string is announced twice in a row (e.g. two
 * "Saved." toasts in succession). Without the seq trick AT engines see
 * the live region's DOM text as unchanged and skip the re-read.
 *
 * Two channels:
 *  - polite: queued behind whatever the user is doing (toasts, stream
 *    completion, status updates). Default for almost everything.
 *  - assertive: interrupts. Reserved for error toasts and modal opens
 *    where the user needs to know NOW.
 */
export interface LiveAnnouncement {
  text: string
  seq: number
}

export type AnnouncePriority = 'polite' | 'assertive'

interface UiState {
  toasts: ToastItem[]
  /** v2.0 — last polite announcement pushed to the global LiveRegion. */
  announcePolite: LiveAnnouncement | null
  /** v2.0 — last assertive announcement pushed to the global LiveRegion. */
  announceAssertive: LiveAnnouncement | null
  /** The currently-displayed permission prompt — head of the FIFO queue. */
  permissionPrompt: PermissionPrompt | null
  /**
   * v1.12.3 — FIFO queue of pending permission prompts. Parallel tool
   * calls used to overwrite `permissionPrompt` and orphan the first
   * prompt's resolver forever (the tool that triggered it would hang).
   * Now the second prompt waits until the first resolves.
   */
  permissionQueue: PermissionPrompt[]
  /** v1.12.3 — currently-displayed shell-command approval prompt. */
  shellApproval: ShellApprovalPrompt | null
  /** FIFO queue of pending shell approvals (parallel-call defense). */
  shellApprovalQueue: ShellApprovalPrompt[]
  /** v1.13.0 — currently-displayed write_file approval prompt. */
  writeApproval: WriteApprovalPrompt | null
  /** FIFO queue of pending write approvals. */
  writeApprovalQueue: WriteApprovalPrompt[]
  activeWindow: ActiveWindowInfo | null
  /** v2.0 — latest semantic screen snapshot. Emitted by main when both
   *  `screenAwareness` and `semanticScreenAwareness` are on. Cleared
   *  when either toggle goes off so a stale OCR excerpt can't leak
   *  into the system prompt after the user opted out. */
  screenSnapshot: ScreenSnapshot | null
  paletteOpen: boolean
  addActionOpen: boolean
  helpOpen: boolean
  reviewDialogOpen: boolean
  /**
   * Whether the first-run setup-discovery panel is currently open. Per-window
   * (each renderer has its own zustand instance), which is intentional: the
   * main window auto-opens it on first launch, and the Settings window opens
   * it on demand from About → "Re-run setup" — they shouldn't race each other.
   */
  setupDiscoveryOpen: boolean
  /** Global cross-thread search dialog open state. Bound to Cmd/Ctrl+F. */
  globalSearchOpen: boolean
  /** Code currently shown in the Canvas dialog (open when non-null). */
  canvasContent: { code: string; language: string } | null
  /** The custom action awaiting delete confirmation, or null. */
  actionToDelete: { id: string; label: string } | null
  /**
   * Agent runs that were still at `running` when the app last quit/crashed —
   * fetched once at boot. The recovery banner offers to resume or discard
   * each one. Empty array = banner is hidden.
   */
  staleCheckpoints: AgentCheckpoint[]
  /**
   * v2.0 polish — number of "do not close the window mid-flow" critical
   * operations in progress. Currently used by UnlockEverythingDialog to
   * tell SettingsRoot's Esc handler "don't kill me while I'm halfway
   * through granting 8 permissions + enabling 6 features + iterating
   * every MCP server". Use enter/exit symmetrically; > 0 blocks Esc.
   */
  criticalBusyCount: number

  pushToast: (kind: ToastKind, message: string, undoId?: string) => void
  dismissToast: (id: string) => void
  /**
   * v2.0 — push a short string to the global `<LiveRegion>` so screen
   * readers announce it. Polite by default (queued behind whatever
   * the user is doing); assertive interrupts and is reserved for
   * error toasts + critical modal opens. `pushToast` already calls
   * this internally — direct callers are for non-toast events like
   * "Reply ready" on stream completion.
   */
  announce: (message: string, priority?: AnnouncePriority) => void
  promptPermission: (permission: PermissionId, actionLabel: string) => Promise<boolean>
  resolvePermission: (granted: boolean) => void
  /** v1.12.3 — pop the shell approval modal and await the user's decision. */
  promptShellApproval: (command: string, cwd: string | null) => Promise<boolean>
  resolveShellApproval: (approved: boolean) => void
  /** v1.13.0 — pop the write_file approval modal and await user's decision. */
  promptWriteApproval: (input: {
    path: string
    previousContent: string | null
    newContent: string
    unifiedDiff: string
  }) => Promise<boolean>
  resolveWriteApproval: (approved: boolean) => void
  /**
   * v1.12.5 — deny every pending and active prompt (permission + shell
   * approval) and clear the queues. Called on window close / renderer
   * unload so the agent-side awaits don't hang forever, leaving tool
   * calls dangling indefinitely. Each pending promise resolves to the
   * SAFER outcome (false / denied / cancelled).
   */
  cancelAllPrompts: () => void
  setActiveWindow: (info: ActiveWindowInfo) => void
  /** v2.0 — install latest screen snapshot. Null clears (toggle off). */
  setScreenSnapshot: (snapshot: ScreenSnapshot | null) => void
  setPalette: (open: boolean) => void
  setAddActionOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setReviewDialogOpen: (open: boolean) => void
  setSetupDiscoveryOpen: (open: boolean) => void
  setGlobalSearchOpen: (open: boolean) => void
  setCanvas: (content: { code: string; language: string } | null) => void
  setActionToDelete: (target: { id: string; label: string } | null) => void
  setStaleCheckpoints: (checkpoints: AgentCheckpoint[]) => void
  removeStaleCheckpoint: (requestId: string) => void
  /** v2.0 polish — bump on entering a critical flow, drop on exit. */
  enterCriticalFlow: () => void
  exitCriticalFlow: () => void
}

// v2.0 — module-local monotonic seq for live-region announcements. Lives
// outside the store so we don't churn React subscribers on every toast
// (the increment doesn't need to flow through any selector).
let announceSeq = 0

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  announcePolite: null,
  announceAssertive: null,
  permissionPrompt: null,
  permissionQueue: [],
  shellApproval: null,
  shellApprovalQueue: [],
  writeApproval: null,
  writeApprovalQueue: [],
  activeWindow: null,
  screenSnapshot: null,
  paletteOpen: false,
  addActionOpen: false,
  helpOpen: false,
  reviewDialogOpen: false,
  setupDiscoveryOpen: false,
  globalSearchOpen: false,
  canvasContent: null,
  actionToDelete: null,
  staleCheckpoints: [],
  criticalBusyCount: 0,

  pushToast: (kind, message, undoId) => {
    const id = uid()
    set((state) => ({ toasts: [...state.toasts, { id, kind, message, undoId }] }))
    window.setTimeout(() => get().dismissToast(id), undoId ? 9000 : 5000)
    // v2.0 — mirror every toast into the live-region announcer so screen
    // reader users hear the same status updates sighted users see. Errors
    // get assertive priority (interrupt whatever's being read); info /
    // success stay polite so they queue behind in-flight announcements.
    get().announce(message, kind === 'error' ? 'assertive' : 'polite')
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  announce: (message, priority = 'polite') => {
    const text = message.trim()
    if (!text) return
    announceSeq += 1
    const payload: LiveAnnouncement = { text, seq: announceSeq }
    set(priority === 'assertive' ? { announceAssertive: payload } : { announcePolite: payload })
  },

  promptPermission: (permission, actionLabel) =>
    // v1.12.3 — enqueue instead of overwriting. If no prompt is visible,
    // the new request becomes the head; otherwise it queues behind the
    // active one and surfaces when that one resolves.
    new Promise<boolean>((resolve) => {
      const next: PermissionPrompt = { permission, actionLabel, resolve }
      set((state) =>
        state.permissionPrompt
          ? { permissionQueue: [...state.permissionQueue, next] }
          : { permissionPrompt: next }
      )
    }),

  resolvePermission: (granted) => {
    const prompt = get().permissionPrompt
    if (!prompt) return
    prompt.resolve(granted)
    // Promote the next queued prompt (if any) to the visible slot.
    set((state) => {
      const [head, ...rest] = state.permissionQueue
      return head ? { permissionPrompt: head, permissionQueue: rest } : { permissionPrompt: null }
    })
  },

  promptShellApproval: (command, cwd) =>
    new Promise<boolean>((resolve) => {
      const next: ShellApprovalPrompt = { command, cwd, resolve }
      set((state) =>
        state.shellApproval
          ? { shellApprovalQueue: [...state.shellApprovalQueue, next] }
          : { shellApproval: next }
      )
    }),

  resolveShellApproval: (approved) => {
    const prompt = get().shellApproval
    if (!prompt) return
    prompt.resolve(approved)
    set((state) => {
      const [head, ...rest] = state.shellApprovalQueue
      return head ? { shellApproval: head, shellApprovalQueue: rest } : { shellApproval: null }
    })
  },

  promptWriteApproval: (input) =>
    new Promise<boolean>((resolve) => {
      const next: WriteApprovalPrompt = { ...input, resolve }
      set((state) =>
        state.writeApproval
          ? { writeApprovalQueue: [...state.writeApprovalQueue, next] }
          : { writeApproval: next }
      )
    }),

  resolveWriteApproval: (approved) => {
    const prompt = get().writeApproval
    if (!prompt) return
    prompt.resolve(approved)
    set((state) => {
      const [head, ...rest] = state.writeApprovalQueue
      return head ? { writeApproval: head, writeApprovalQueue: rest } : { writeApproval: null }
    })
  },

  cancelAllPrompts: () => {
    const state = get()
    // Resolve everything to false / cancelled so awaiting callers can
    // unwind. Order doesn't matter since each resolver is independent.
    state.permissionPrompt?.resolve(false)
    for (const p of state.permissionQueue) p.resolve(false)
    state.shellApproval?.resolve(false)
    for (const p of state.shellApprovalQueue) p.resolve(false)
    state.writeApproval?.resolve(false)
    for (const p of state.writeApprovalQueue) p.resolve(false)
    set({
      permissionPrompt: null,
      permissionQueue: [],
      shellApproval: null,
      shellApprovalQueue: [],
      writeApproval: null,
      writeApprovalQueue: []
    })
  },

  setActiveWindow: (info) => set({ activeWindow: info }),

  setScreenSnapshot: (snapshot) => set({ screenSnapshot: snapshot }),

  setPalette: (open) => set({ paletteOpen: open }),

  setAddActionOpen: (open) => set({ addActionOpen: open }),

  setHelpOpen: (open) => set({ helpOpen: open }),

  setReviewDialogOpen: (open) => set({ reviewDialogOpen: open }),

  setSetupDiscoveryOpen: (open) => set({ setupDiscoveryOpen: open }),

  setGlobalSearchOpen: (open) => set({ globalSearchOpen: open }),

  setCanvas: (content) => set({ canvasContent: content }),

  setActionToDelete: (target) => set({ actionToDelete: target }),

  setStaleCheckpoints: (checkpoints) => set({ staleCheckpoints: checkpoints }),

  removeStaleCheckpoint: (requestId) =>
    set((state) => ({
      staleCheckpoints: state.staleCheckpoints.filter((c) => c.requestId !== requestId)
    })),

  enterCriticalFlow: () => set((state) => ({ criticalBusyCount: state.criticalBusyCount + 1 })),

  exitCriticalFlow: () =>
    set((state) => ({ criticalBusyCount: Math.max(0, state.criticalBusyCount - 1) }))
}))
