/**
 * Ephemeral UI state: toast notifications, the interactive permission prompt,
 * and the latest active-window context from screen awareness.
 */
import { create } from 'zustand'
import { uid } from '../lib/utils'
import type { ActiveWindowInfo, AgentCheckpoint } from '@shared/types'
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

interface UiState {
  toasts: ToastItem[]
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
  activeWindow: ActiveWindowInfo | null
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

  pushToast: (kind: ToastKind, message: string, undoId?: string) => void
  dismissToast: (id: string) => void
  promptPermission: (permission: PermissionId, actionLabel: string) => Promise<boolean>
  resolvePermission: (granted: boolean) => void
  /** v1.12.3 — pop the shell approval modal and await the user's decision. */
  promptShellApproval: (command: string, cwd: string | null) => Promise<boolean>
  resolveShellApproval: (approved: boolean) => void
  setActiveWindow: (info: ActiveWindowInfo) => void
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
}

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  permissionPrompt: null,
  permissionQueue: [],
  shellApproval: null,
  shellApprovalQueue: [],
  activeWindow: null,
  paletteOpen: false,
  addActionOpen: false,
  helpOpen: false,
  reviewDialogOpen: false,
  setupDiscoveryOpen: false,
  globalSearchOpen: false,
  canvasContent: null,
  actionToDelete: null,
  staleCheckpoints: [],

  pushToast: (kind, message, undoId) => {
    const id = uid()
    set((state) => ({ toasts: [...state.toasts, { id, kind, message, undoId }] }))
    window.setTimeout(() => get().dismissToast(id), undoId ? 9000 : 5000)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

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
      return head
        ? { permissionPrompt: head, permissionQueue: rest }
        : { permissionPrompt: null }
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
      return head
        ? { shellApproval: head, shellApprovalQueue: rest }
        : { shellApproval: null }
    })
  },

  setActiveWindow: (info) => set({ activeWindow: info }),

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
    }))
}))
