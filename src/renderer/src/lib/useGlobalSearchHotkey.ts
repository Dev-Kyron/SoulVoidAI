/**
 * Binds Cmd/Ctrl+F at the renderer root to surface the cross-thread global
 * search dialog. The two renderer windows route the keystroke differently:
 *
 *  - `main` (the floating widget root) toggles the local
 *    `useUiStore.globalSearchOpen` flag, which mounts the dialog directly.
 *  - `settings` (the de-docked Settings window) IPCs main to close the
 *    Settings window, show the main window, and broadcast the open-event
 *    to the main window's renderer. The dialog can't live in Settings
 *    because the chat state it queries (`useChatStore`) is a separate
 *    Zustand instance per window — clicking a search result in Settings
 *    would mutate a chat store nothing renders.
 *
 * Either path skips when the user is mid-edit in an input/textarea so the
 * keystroke can fall through to native browser-find behaviour (a no-op in
 * Electron currently, but better than hijacking and feeling broken).
 */
import { useEffect } from 'react'
import { vs } from './bridge'
import { useUiStore } from '../store/useUiStore'

export function useGlobalSearchHotkey(target: 'main' | 'settings' = 'main'): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const cmdOrCtrl = event.metaKey || event.ctrlKey
      if (!cmdOrCtrl || event.key.toLowerCase() !== 'f') return
      const t = event.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      if (target === 'settings') {
        void vs.window.openGlobalSearch()
      } else {
        useUiStore.getState().setGlobalSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target])
}
