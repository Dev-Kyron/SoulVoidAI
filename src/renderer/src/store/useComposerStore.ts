/**
 * v2.0 — Composer side-panel state. Cursor-style markdown document the
 * user edits in a side panel; the chat acts as the diff conversation.
 *
 * Scope note: this v2.0 cut keeps the document in renderer memory only.
 * Switching threads or reloading the panel resets the doc — explicit
 * "Save to file" via the existing share/saveFile IPC is the user's
 * escape hatch until v2.1 wires per-thread SQLite persistence.
 *
 * Why renderer-only first: the SQLite schema migration to add a
 * composer column on `threads` is heavier than the rest of v2.0 prep
 * warrants. Shipping the UX surface earns immediate value and the
 * persistence layer can land cleanly as a follow-up.
 */
import { create } from 'zustand'

interface ComposerState {
  /** Whether the side panel is currently visible. */
  open: boolean
  /** Markdown source. Edited live by the user; replaced/appended via
   *  the "Send to Composer" action on assistant bubbles. */
  content: string
  /** Renderer-side timestamp of the last content mutation. Used to
   *  display "edited Nm ago" in the panel header. Not persisted. */
  updatedAt: string | null

  /** Toggle visibility — chat-header button + Esc both call this. */
  toggle: () => void
  setOpen: (open: boolean) => void

  /** Replace the entire document. Used by "Send to Composer" (replace
   *  mode). v2.1 may add a smarter merge that diffs in place; the
   *  replace-then-edit dance covers the common case for now. */
  setContent: (next: string) => void

  /** Append a fenced block / paragraph to the existing content. Used
   *  by "Append to Composer" (alternate mode for users who want to
   *  keep stacking assistant output). Inserts a blank line between
   *  the prior content and the new chunk for readability. */
  appendContent: (chunk: string) => void

  /** Reset to empty. Hooked to a clear button in the panel header. */
  clear: () => void
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  open: false,
  content: '',
  updatedAt: null,

  toggle: () => set({ open: !get().open }),
  setOpen: (open) => set({ open }),

  setContent: (next) => set({ content: next, updatedAt: new Date().toISOString() }),

  appendContent: (chunk) => {
    const current = get().content
    const separator = current.trim() ? '\n\n' : ''
    set({
      content: `${current}${separator}${chunk}`,
      updatedAt: new Date().toISOString()
    })
  },

  clear: () => set({ content: '', updatedAt: null })
}))
