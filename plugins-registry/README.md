# VoidSoul Plugin Registry

Public list of plugins surfaced by the in-app marketplace at
**Settings → Plugins → Browse**.

The Electron app fetches `registry.json` from this folder via
`raw.githubusercontent.com` on demand — no backend, no auth.

Two tiers live here side by side:

- **Curated** (`source: "curated"`) — published by the VoidSoul team.
  These render with a green "Verified" badge in the marketplace.
- **Community** (`source: "community"`) — submitted via a public PR.
  These render with a slate "Community" badge plus author attribution.
  If they declare any JS hooks, the install dialog adds an explicit
  warning that's separate from the global hooks master switch.

Both tiers ship the same declarative `quickActions` (no remote code).
Hooks (small JS snippets that can run in-process when the user opts
in via Settings → Plugins → Hooks) are allowed in either tier — the
trust tier just changes how loudly the UI surfaces them.

---

## Submitting a community plugin

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full walkthrough.
Short version:

1. Fork this repo.
2. Add a single entry to the `plugins` array in `registry.json`,
   following the manifest schema below.
3. Set `"source": "community"`, fill in `"submittedBy"` with your
   GitHub handle, and add `"repoUrl"` if your plugin has a source
   repo people can review.
4. Open a PR titled `plugin: <your-plugin-name>`.
5. CI validates the entry shape + action allowlist on push. Once it's
   green and a maintainer reviews the actions for safety, your entry
   ships in the next registry refresh (live within ~an hour of merge,
   bundled into the next release).

## Manifest cheat-sheet

```json
{
  "id": "my-plugin",
  "name": "Pretty Display Name",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "One-sentence pitch under ~120 chars.",
  "tags": ["productivity", "developer"],
  "source": "community",
  "submittedBy": "your-github-handle",
  "submittedAt": "2026-06-01",
  "repoUrl": "https://github.com/you/my-plugin",
  "quickActions": [
    {
      "id": "action-id",
      "label": "Button Label",
      "icon": "Globe",
      "description": "Tooltip text.",
      "requires": "browser",
      "action": {
        "type": "open-url",
        "params": { "url": "https://example.com" }
      }
    }
  ]
}
```

### Field reference

| Field          | Required | Notes |
|----------------|----------|-------|
| `id`           | yes      | Filesystem-safe (`[a-zA-Z0-9._-]` only). Becomes the on-disk filename. |
| `name`         | yes      | Display name shown in the marketplace. |
| `version`      | yes      | Semver string. |
| `description`  | yes      | One sentence, under 120 chars ideally. |
| `author`       | no       | Display attribution. |
| `tags`         | no       | Free-form strings used for marketplace search/filter. |
| `source`       | no       | `"curated"` (default) or `"community"`. Community PRs must set this. |
| `submittedBy`  | no       | GitHub handle. **Required for community entries.** |
| `submittedAt`  | no       | ISO date. The validator stamps this if you omit it. |
| `repoUrl`      | no       | Optional external link to your plugin's source. |
| `quickActions` | yes      | Array of `QuickAction`. Each must use a built-in `ActionType` — no arbitrary code. |
| `hooks`        | no       | Optional JS hook handlers. Community entries with hooks get an extra install warning. |

### Available icon names

Anything from the [lucide-react](https://lucide.dev) icon set. Unknown
names fall back to the generic `Sparkles` icon at runtime.

### Available `action.type` values

The full list is in [`src/main/services/automation/actions.ts`](../src/main/services/automation/actions.ts).
Common ones:

- `open-url` — open a URL in the user's default browser
- `open-app` — launch an application by name
- `open-folder` — open a folder in the user's file manager
- `screenshot` — capture the screen for analysis
- `web-search` — run a web search (DuckDuckGo / Tavily)
- `web-fetch` — fetch a specific URL and extract main content

### Permission gates (`requires`)

- `browser` — opens a URL in the user's browser
- `filesystem` — reads/writes files in user-approved folders
- `appControl` — launches applications
- `microphone` — captures audio
- `screenCapture` — captures the screen
- `terminal` — runs shell commands

The user is prompted once per permission. Untriggered until the user
clicks the action — no install-time permission grant.
