/**
 * v1.10.3 — right-click context menu for any focusable window.
 *
 * Electron doesn't show a context menu by default; you have to wire it
 * up via webContents 'context-menu' events and build a Menu yourself.
 * Without this, right-click is a no-op in both the floating panel and
 * the Settings window — surprising for any user used to a normal app.
 *
 * Design rules:
 *  - Pop ONLY when there's something meaningful to offer. Right-click on
 *    the orb / a button / an icon should do nothing, not show an empty
 *    menu. The built-in roles populate based on `params.editFlags`, so
 *    if nothing's clickable in this context we emit zero items and skip
 *    the popup entirely.
 *  - Use Electron's built-in roles ('cut', 'copy', etc.) — they handle
 *    the OS-level clipboard correctly across platforms and inherit the
 *    user's keyboard shortcuts.
 *  - Spellcheck suggestions appear at the top when right-clicking a
 *    misspelled word in an editable field. We already enable the
 *    Chromium spellchecker on both windows (window.ts), so this just
 *    surfaces what the engine already knows.
 *  - "Copy link" appears when right-clicking a hyperlink, so URLs in
 *    chat messages can be copied without selecting text.
 */
import { BrowserWindow, Menu, MenuItem, clipboard } from 'electron'

export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu()
    const { editFlags, isEditable, selectionText, linkURL, misspelledWord, dictionarySuggestions } =
      params

    // Spellcheck suggestions first — they're the most contextually
    // relevant menu items when present. Cap at 5 to keep the menu
    // visually tight.
    if (isEditable && misspelledWord && dictionarySuggestions?.length) {
      for (const word of dictionarySuggestions.slice(0, 5)) {
        menu.append(
          new MenuItem({
            label: word,
            click: () => win.webContents.replaceMisspelling(word)
          })
        )
      }
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({
          label: `Add "${misspelledWord}" to dictionary`,
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
        })
      )
      menu.append(new MenuItem({ type: 'separator' }))
    }

    // Standard edit operations. We use built-in roles so accelerators
    // + clipboard plumbing are handled by Electron, not us.
    if (editFlags.canUndo) {
      menu.append(
        new MenuItem({ label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' })
      )
    }
    if (editFlags.canRedo) {
      menu.append(
        new MenuItem({ label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' })
      )
    }
    if (editFlags.canUndo || editFlags.canRedo) {
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (editFlags.canCut) {
      menu.append(new MenuItem({ label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' }))
    }
    // Copy needs both the capability AND actual selected text — otherwise
    // copying "nothing" is just a visual no-op that wastes a menu slot.
    if (editFlags.canCopy && selectionText) {
      menu.append(
        new MenuItem({ label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' })
      )
    }
    if (editFlags.canPaste) {
      menu.append(
        new MenuItem({ label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' })
      )
    }

    // Link helpers. Appears when the right-click target is a hyperlink —
    // a chat message URL, an external link in Settings, anywhere we
    // surface <a href>. Both copy AND open-in-external feel useful.
    if (linkURL) {
      if (menu.items.length > 0) menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({
          label: 'Copy link address',
          click: () => clipboard.writeText(linkURL)
        })
      )
    }

    // Select all comes last and only when meaningful — editable fields
    // always allow it; static text only when something's selectable.
    if (editFlags.canSelectAll && (isEditable || selectionText)) {
      if (menu.items.length > 0) menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({ label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' })
      )
    }

    // No items → right-click was on the orb / a button / a plain icon
    // surface with nothing actionable. Don't show an empty menu — that
    // would feel like a glitch. Just swallow the gesture.
    if (menu.items.length > 0) {
      menu.popup({ window: win })
    }
  })
}
