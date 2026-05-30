# Contributing a plugin

Thank you for wanting to share a plugin with the VoidSoul community.
This is a single-file PR flow — no separate build, no submission portal,
no account to create. Everything is a JSON entry in `registry.json` in
this folder.

## What plugins can do

Plugins bundle one or more **quick actions** — declarative buttons that
appear in the user's Nexus radial / command palette / tray menu. Each
action invokes a built-in `ActionType` (e.g. `open-url`, `open-app`,
`screenshot`) with supplied parameters. **No arbitrary code runs** from
the declarative side — the user grants permission for each `requires`
category once, and the action only fires inside that permission's
scope.

Plugins MAY optionally include `hooks` — small JavaScript snippets
the app compiles via `new Function(payload, context, body)` and runs
in-process. This is gated by:

1. A global master switch (Settings → Plugins → Hooks)
2. The individual plugin being enabled
3. **For community plugins:** an extra install-time confirmation

Community-submitted plugins with hooks are reviewed carefully before
merge. If your plugin can be expressed entirely with declarative
quick actions, prefer that — it ships faster and earns user trust.

---

## Step-by-step

### 1. Fork + branch

```bash
git clone https://github.com/<you>/<this-repo-fork>
git checkout -b plugin/<your-plugin-id>
```

### 2. Add your entry

Append a new object to the `plugins` array in `registry.json`.
A minimal community entry looks like this:

```json
{
  "id": "my-awesome-plugin",
  "name": "My Awesome Plugin",
  "version": "1.0.0",
  "author": "Your Display Name",
  "description": "One sentence about what this plugin does.",
  "tags": ["productivity"],
  "source": "community",
  "submittedBy": "your-github-handle",
  "quickActions": [
    {
      "id": "do-the-thing",
      "label": "Do The Thing",
      "icon": "Sparkles",
      "description": "Tooltip text shown on hover.",
      "requires": "browser",
      "action": {
        "type": "open-url",
        "params": { "url": "https://example.com" }
      }
    }
  ]
}
```

**Required for community entries:**

- `source: "community"`
- `submittedBy` (your GitHub handle)

**Recommended:**

- `repoUrl` — link to your plugin's source if it's tracked elsewhere
- `submittedAt` — the merge date will be added if you omit this

### 3. Validate locally

```bash
node scripts/validate-plugin-registry.mjs
```

The script enforces:

- Schema shape (required fields, types)
- Community entries have `submittedBy`
- IDs are filesystem-safe
- No duplicate IDs
- All `action.type` values are recognised built-ins
- All `requires` values are recognised permissions

CI runs the same script on every PR.

### 4. Open the PR

PR title: `plugin: <your-plugin-name>`

The PR template auto-fills a checklist. Review it, tick the boxes,
and explain anything non-obvious (especially if you've included
`hooks`).

### 5. Review

A maintainer will check:

- Actions match what your description claims
- No `open-url` to obviously hostile destinations
- No `shell` actions running arbitrary commands without good reason
- Hook code (if present) is small, readable, doesn't make network
  requests unless that's the plugin's stated purpose
- Description and labels are clear and not deceptive

Most reviews land within a week. We may ask for minor changes (most
common: tighter description, more specific tags, a missing
`repoUrl`).

### 6. After merge

The marketplace fetches `registry.json` from the GitHub raw CDN, so
your entry appears in users' apps within ~an hour of merge (sooner
if their app's marketplace cache is stale). It also lands in the
bundled fallback shipped with the next desktop app release.

---

## What gets rejected

- Plugins whose only action is "open a URL" to a competitor's
  landing page (we want utility, not promo)
- Hook code that exfiltrates data the plugin doesn't need
- Misleading descriptions
- Duplicate functionality of an existing plugin without meaningful
  improvement
- Anything illegal in major jurisdictions
- Anything designed to bypass the permission system

If your plugin is rejected, we'll explain why and what would change
the answer.

---

## Questions

Open an issue with the `plugin-question` label. We'd rather answer
before you build than reject after.
