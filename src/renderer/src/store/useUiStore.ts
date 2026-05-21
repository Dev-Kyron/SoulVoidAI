/**
 * Ephemeral UI state: toast notifications, the interactive permission prompt,
 * and the latest active-window context from screen awareness.
 */
import { create } from 'zustand'
import { uid } from '../lib/utils'
import type { ActiveWindowInfo } from '@shared/types'
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

interface UiState {
  toasts: ToastItem[]
  permissionPrompt: PermissionPrompt | null
  activeWindow: ActiveWindowInfo | null
  paletteOpen: boolean
  addActionOpen: boolean
  helpOpen: boolean
  /** Global cross-thread search dialog open state. Bound to Cmd/Ctrl+F. */
  globalSearchOpen: boolean
  /** Code currently shown in the Canvas dialog (open when non-null). */
  canvasContent: { code: string; language: string } | null
  /** The custom action awaiting delete confirmation, or null. */
  actionToDelete: { id: string; label: string } | null

  pushToast: (kind: ToastKind, message: string, undoId?: string) => void
  dismissToast: (id: string) => void
  promptPermission: (permission: PermissionId, actionLabel: string) => Promise<boolean>
  resolvePermission: (granted: boolean) => void
  setActiveWindow: (info: ActiveWindowInfo) => void
  setPalette: (open: boolean) => void
  setAddActionOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setGlobalSearchOpen: (open: boolean) => void
  setCanvas: (content: { code: string; language: string } | null) => void
  setActionToDelete: (target: { id: string; label: string } | null) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  permissionPrompt: null,
  activeWindow: null,
  paletteOpen: false,
  addActionOpen: false,
  helpOpen: false,
  globalSearchOpen: false,
  canvasContent: null,
  actionToDelete: null,

  pushToast: (kind, message, undoId) => {
    const id = uid()
    set((state) => ({ toasts: [...state.toasts, { id, kind, message, undoId }] }))
    window.setTimeout(() => get().dismissToast(id), undoId ? 9000 : 5000)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  promptPermission: (permission, actionLabel) =>
    new Promise<boolean>((resolve) => {
      set({ permissionPrompt: { permission, actionLabel, resolve } })
    }),

  resolvePermission: (granted) => {
    const prompt = get().permissionPrompt
    if (prompt) {
      prompt.resolve(granted)
      set({ permissionPrompt: null })
    }
  },

  setActiveWindow: (info) => set({ activeWindow: info }),

  setPalette: (open) => set({ paletteOpen: open }),

  setAddActionOpen: (open) => set({ addActionOpen: open }),

  setHelpOpen: (open) => set({ helpOpen: open }),

  setGlobalSearchOpen: (open) => set({ globalSearchOpen: open }),

  setCanvas: (content) => set({ canvasContent: content }),

  setActionToDelete: (target) => set({ actionToDelete: target })
}))
