# VoidSoul Plugin Registry

Public list of community plugins surfaced by the in-app marketplace at
**Settings → Plugins → Browse**.

The Electron app fetches `registry.json` from this folder via the GitHub
`raw.githubusercontent.com` CDN on demand — no backend, no auth.

## Submitting a plugin

1. Open a PR adding an entry to `registry.json`. The entry must be a valid
   `PluginManifest` per `src/shared/types.ts` plus an optional `tags: string[]`
   for marketplace filtering.
2. Required manifest fields: `id`, `name`, `version`, `description`,
   `quickActions[]`. Each action must use one of the built-in
   `ActionType` strings (see `src/main/services/automation/actions.ts`) — no
   arbitrary code runs from plugins.
3. Keep `id` filesystem-safe (`[a-zA-Z0-9._-]` only) since it doubles as the
   on-disk filename in users' plugins folders.
4. Studio reviews the PR for action safety + general fit, then merges.
   The registry is live from `main` — once merged, the entry shows up in
   every installed app's marketplace within an hour (GitHub raw CDN cache).

## Manifest cheat-sheet

```json
{
  "id": "my-plugin",
  "name": "Pretty Display Name",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "One-sentence pitch under ~120 chars.",
  "tags": ["productivity", "developer"],
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

Available `icon` names are anything from the
[lucide-react](https://lucide.dev) icon set. Unknown names fall back to
the generic `Sparkles` icon at runtime.

Available `action.type` values are listed in
[`src/main/services/automation/actions.ts`](../src/main/services/automation/actions.ts)
— common ones: `open-url`, `open-app`, `open-folder`, `screenshot`,
`web-search`, `web-fetch`.

`requires` gates the action behind a permission the user must approve once:
`browser`, `filesystem`, `app`, `microphone`, `screen`, `web`.
