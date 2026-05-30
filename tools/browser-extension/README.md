# VoidSoul Browser Extension (local-only)

A Chromium-family extension (Chrome / Edge / Brave / Arc) that gives you a
VoidSoul chat overlay on any webpage. Highlight some text, press a hotkey,
the overlay pops up with that selection as context and a reply streams in
inline. Same UX paradigm as Raycast's Quick AI, but on the web.

## Why local-only

The extension talks to the **running VoidSoul desktop app** via Chrome's
[Native Messaging](https://developer.chrome.com/docs/apps/nativeMessaging)
protocol. There is no remote server, no cloud relay, no hosted bridge.
Every prompt and reply travels:

```
content script  →  background worker  →  bridge.cjs (Node host)
              chrome.runtime API           stdin/stdout
                                                ↓ Unix socket / Windows named pipe
                                          VoidSoul desktop app
                                                ↓ existing AI gateway
                                          (whatever provider you picked in the app)
```

Nothing crosses the network unless the underlying provider does — exactly
the same trust model as using the desktop app directly.

## Layout

```
tools/browser-extension/
├── README.md             ← this file
├── extension/            ← Chrome extension MV3 source (load unpacked)
│   ├── manifest.json
│   ├── background.js     ← service worker, owns the native port
│   ├── content.js        ← per-page overlay, selection capture, hotkey
│   ├── overlay.css       ← fallback styles (Shadow DOM inlines its own)
│   ├── popup.html        ← toolbar popup (connection status)
│   ├── popup.js
│   ├── options.html      ← extension options (privacy / setup notes)
│   └── icons/
└── native-host/          ← shipped INSIDE the desktop app installer
    ├── bridge.cjs                  ← Chrome spawns this; framed JSON ↔ socket
    ├── host-manifest.template.json ← rewritten by install.mjs
    └── install.mjs                 ← writes per-OS host manifest + registry key
```

The `extension/` subdir is the unpacked extension you load in your
browser. The `native-host/` subdir is bundled into the desktop app's
installer (see `electron-builder.yml`'s `extraResources` block) so the
`install.mjs` and `bridge.cjs` paths exist on every install.

## Install (one-time)

1. **Enable the bridge in the desktop app.**
   Settings → Tools → Browser Extension → flip *Enable bridge* on.
   This starts a per-user local IPC server.

2. **Load the unpacked extension.**
   In Chrome, open `chrome://extensions`, enable Developer mode,
   click *Load unpacked*, and point it at `tools/browser-extension/extension/`.

3. **Copy your extension id.**
   Chrome shows it under the extension name — 32 lowercase letters
   (looks like `pjkljhegncpnkpknbcohdijeoejaedia`).

4. **Register the native-messaging host.**
   Run the install script from a terminal, substituting your extension id:

   ```sh
   node tools/browser-extension/native-host/install.mjs --extension-id YOUR_ID
   ```

   For Edge / Brave / Arc, add `--browser edge|brave|arc`. The script
   writes a per-OS manifest file (and, on Windows, the registry key
   Chrome reads).

5. **Restart your browser.**
   The native-host registration is read once on startup.

## Daily use

- **Hotkey:** `Alt+Shift+J` (`⌥⇧J` on Mac). Highlight some text first;
  the overlay opens with that selection as context.
- **Right-click menu:** select text → right-click → *Ask VoidSoul
  about "…"*. Same surface, same context.
- **Esc** closes the overlay. **Enter** submits the prompt;
  **Shift+Enter** inserts a newline.

If the desktop app isn't running when you trigger the overlay, the
extension surfaces a friendly "VoidSoul desktop app isn't running" error
inside the overlay — nothing hangs.

## Privacy

- The native-host manifest whitelists exactly your extension id under
  `allowed_origins`. Other extensions on the same browser can't talk to
  the bridge.
- The local socket / named pipe is scoped to your user account. Other
  users on a shared Mac/Linux machine can't read it (Unix sockets are
  `chmod 0600`; Windows named pipes carry your user's ACL).
- The desktop app's existing system prompt + active provider apply.
  If you've configured a local provider (Ollama, LM Studio), replies
  never leave your machine.

## Uninstall

```sh
node tools/browser-extension/native-host/install.mjs --uninstall
```

This removes the manifest file (and the Windows registry key, if
applicable). The extension itself is removed via `chrome://extensions`.
