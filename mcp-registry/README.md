# VoidSoul MCP server registry

Curated list of popular [MCP](https://modelcontextprotocol.io) servers
surfaced by the in-app marketplace at **Settings → MCP → Browse**.

The Electron app fetches `registry.json` from this folder via the GitHub
raw CDN on demand — no backend, no auth, no API.

## Entry shape

```json
{
  "id": "unique-slug",
  "name": "Display Name",
  "description": "One-sentence pitch.",
  "category": "files | dev | web | data | comms | memory | reasoning",
  "tags": ["essential", "files"],
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-xxx", "{PATH}"],
  "env": {},
  "argPrompts": [
    {
      "key": "PATH",
      "label": "Folder to expose",
      "description": "Help text shown below the input.",
      "type": "folder",
      "placeholder": "C:\\Users\\you\\code"
    }
  ],
  "envPrompts": [
    {
      "key": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "label": "GitHub token",
      "description": "Where to get it.",
      "secret": true
    }
  ],
  "requires": "uv",
  "author": "Anthropic",
  "docsUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/xxx"
}
```

- **`argPrompts`** — placeholders in `args` (`{KEY}`) get filled with the
  user's input at install time. Use `type: "folder"` / `"file"` for
  filesystem-aware prompts (UI hints at picker), or omit for free-text.
- **`envPrompts`** — env vars the user must paste before install. Mark
  `secret: true` for tokens / API keys (password-masked input).
- **`requires`** — runtime prerequisite the user needs installed. Currently
  recognised: `uv` (the Python package manager that bootstraps `uvx`).
  The marketplace card shows a small "requires uv" badge so users know
  before clicking install.

## Submitting a server

1. Test the server entry by hand — `Settings → MCP → Add custom server`
   with the same command/args/env. Confirm it connects and tools appear.
2. Open a PR adding the entry to `registry.json`.
3. Keep `id` filesystem-safe (`[a-z0-9-]`) — used as a stable identifier
   that prevents accidental duplicate-installs in the marketplace UI.
4. Studio reviews + merges. Live from `main` — every installed app's
   marketplace picks up the new entry within an hour (GitHub raw CDN
   cache window).
