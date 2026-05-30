# VoidSoul MCP server registry

Curated + community list of [MCP](https://modelcontextprotocol.io)
servers surfaced by the in-app marketplace at **Settings → MCP →
Browse**.

The Electron app fetches `registry.json` from this folder via the
GitHub raw CDN on demand — no backend, no auth, no API. The file is
Ed25519-signed; the app verifies the signature before trusting the
remote copy.

## Two trust tiers

Two tiers live side by side in this single file:

- **`source: "curated"`** — published by the VoidSoul team. Renders
  with a cyan "Curated" badge in the marketplace.
- **`source: "community"`** — submitted via a public PR by a
  community contributor. Renders with a slate "Community" badge
  plus author attribution. Same JSON, same signature, just different
  authorship — the badge lets users apply more scrutiny.

External catalogues (Smithery, Glama, PulseMCP) are populated by the
app at runtime, separate from this file, and render with their own
distinct badges. Don't set `source` to one of those values here —
the validator rejects it.

---

## Submitting a server

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full walkthrough.
Short version:

1. Test your entry by hand via **Settings → MCP → Add custom server**
   to confirm the spawn recipe actually works.
2. Open a PR adding a single entry to the `servers` array.
3. Set `"source": "community"`, fill in `"submittedBy"` with your
   GitHub handle, and add `"repoUrl"` linking to the upstream
   package source.
4. Run `node scripts/validate-mcp-registry.mjs` locally — CI runs
   the same script on every PR.

---

## Entry shape

```json
{
  "id": "unique-kebab-id",
  "name": "Display Name",
  "description": "One-sentence pitch.",
  "category": "files",
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
  "docsUrl": "https://github.com/.../tree/main/src/xxx",

  "source": "community",
  "submittedBy": "your-github-handle",
  "submittedAt": "2026-06-01",
  "repoUrl": "https://github.com/you/your-mcp-server"
}
```

### Field reference

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Kebab-case, unique. Stable identifier; prevents accidental duplicate-installs. |
| `name` | yes | Display name shown in the marketplace. |
| `description` | yes | One sentence. |
| `category` | yes | One of: files, dev, web, data, comms, productivity, memory, reasoning, ai, other. |
| `command` | yes | The binary to spawn (`npx`, `uvx`, etc.). |
| `args` | yes | Argument array. `{KEY}` placeholders get filled at install time from `argPrompts`. |
| `env` | no | Default env vars. User-supplied values from `envPrompts` merge on top. |
| `argPrompts` | no | UI prompts for each `{KEY}` placeholder in `args`. |
| `envPrompts` | no | UI prompts for env vars the user must supply. |
| `requires` | no | Runtime prerequisite (e.g. `uv`). Surfaces as a marketplace badge. |
| `author` | no | Display attribution for the *server*'s author. |
| `docsUrl` | no | Link to the server's README / docs page. |
| `tags` | no | Free-form strings used for marketplace search. |
| `source` | no | `"curated"` (default) or `"community"`. Community PRs must set this. |
| `submittedBy` | no | GitHub handle. **Required for community entries.** |
| `submittedAt` | no | ISO date. The validator stamps this if you omit it. |
| `repoUrl` | no | Optional external link to your server's source. Strongly encouraged for community entries. |

### Prompt-array semantics

- **`argPrompts`** — placeholders in `args` (`{KEY}`) get filled with
  the user's input at install time. Use `type: "folder"` /
  `"file"` for filesystem-aware prompts (UI hints at picker), or
  omit for free-text.
- **`envPrompts`** — env vars the user must paste before install.
  Mark `secret: true` for tokens / API keys (password-masked input).
- Keys within each array must be unique. Validator enforces.

### `requires` values

Currently recognised: `uv` (the Python package manager that
bootstraps `uvx`). The marketplace card shows a small "requires uv"
badge so users know before clicking install.
