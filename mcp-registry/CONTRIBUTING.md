# Contributing an MCP server entry

Thank you for wanting to share an MCP server with the VoidSoul
community. This is a single-file PR flow — no separate build, no
submission portal, no account to create. Everything is a JSON entry
in `registry.json` in this folder.

## What MCP entries can do

An entry in this registry is a recipe for spawning a `Model Context
Protocol` server as a local subprocess. It tells VoidSoul:

- **What to run** — `command` + `args`
- **What configuration the user needs to supply** — `argPrompts` for
  paths/flags, `envPrompts` for tokens/keys
- **Optional system prerequisites** — `requires` (e.g. `uv`)
- **Where to read about it** — `docsUrl`, `repoUrl`

The server itself does the real work; this registry just makes it
installable in one click from the in-app marketplace.

---

## Two trust tiers

| Tier | Badge | Who publishes | Review |
|------|-------|---------------|--------|
| `curated` | cyan "Curated" | VoidSoul team | Hand-reviewed; default for studio entries |
| `community` | slate "Community" | Anyone via PR | Reviewed in the PR diff before merge |

Both tiers ship in the same `registry.json` file and are signed by the
same Ed25519 key, so the "Verified" badge applies equally. The
tier label is purely about authorship — it lets users apply more
scrutiny to community entries when scanning the marketplace.

---

## Step-by-step

### 1. Test the server by hand first

Use **Settings → MCP → Add custom server** in your installed VoidSoul
to confirm the `command` + `args` + `env` you'll be submitting
actually boots a working server. The marketplace assumes every entry
is installable; a broken submission wastes everyone's time.

### 2. Fork + branch

```bash
git clone https://github.com/<you>/<this-repo-fork>
git checkout -b mcp/<your-server-id>
```

### 3. Add your entry

Append a new object to the `servers` array in `registry.json`.
A minimal community entry:

```json
{
  "id": "my-mcp-server",
  "name": "My MCP Server",
  "description": "One sentence about what tools this server exposes.",
  "category": "files",
  "tags": ["files", "productivity"],
  "command": "npx",
  "args": ["-y", "@you/voidsoul-mcp-foo"],
  "env": {},
  "argPrompts": [],
  "envPrompts": [
    {
      "key": "FOO_API_KEY",
      "label": "Foo API key",
      "description": "Get it at foo.com/settings/api.",
      "secret": true
    }
  ],
  "source": "community",
  "submittedBy": "your-github-handle",
  "repoUrl": "https://github.com/you/voidsoul-mcp-foo",
  "docsUrl": "https://github.com/you/voidsoul-mcp-foo#readme"
}
```

**Required for community entries:**

- `source: "community"`
- `submittedBy` (your GitHub handle)
- A working `command` + `args` combo

**Strongly encouraged:**

- `repoUrl` linking to your server's source — without it users have
  no way to audit before installing
- `docsUrl` to a README or setup guide
- `tags` for marketplace search

### 4. Categories

Pick the closest existing category from this list:

`files`, `dev`, `web`, `data`, `comms`, `productivity`, `memory`,
`reasoning`, `ai`, `other`

If your server genuinely fits none of these, propose a new category
in the PR description — adding categories is fine, but we keep the
list tight.

### 5. Validate locally

```bash
node scripts/validate-mcp-registry.mjs
```

The script enforces:

- Schema shape (required fields, types)
- Community entries have `submittedBy`
- IDs are kebab-case + unique
- All URLs are http(s)
- Every `{KEY}` placeholder in `args` has a matching `argPrompts`
  entry (otherwise the installer would leave a literal `{KEY}` in
  the spawned command)
- Prompt arrays have unique keys per array

CI runs the same script on every PR.

### 6. Open the PR

PR title: `mcp: <your-server-name>`

The PR template auto-fills a checklist. Review it, tick the boxes,
explain anything non-obvious (especially security-sensitive
permissions or scopes your server requests).

### 7. Review + merge

A maintainer will check:

- The package at `args[1]` (or wherever the entry points) is the
  one you say it is
- The server's tool surface matches the description
- Env-prompt key names match the upstream server's documented
  expectations
- No `command` that runs arbitrary user-controlled code
- Tags + category are accurate

Most reviews land within a week. After merge:

1. The marketplace fetches `registry.json` from the GitHub raw CDN,
   so your entry appears in users' apps within ~an hour of merge.
2. The maintainer re-runs `scripts/sign-mcp-registry.mjs` to refresh
   the Ed25519 signature — community entries inherit the Verified
   badge via the same signature.
3. The next desktop app release bundles the updated registry as the
   offline fallback.

---

## What gets rejected

- Servers whose only purpose is opening a URL or running a script
  that could be a plain `quickAction` plugin instead
- Servers pulling untrusted code from runtime URLs (Smithery's
  reviewed packages are fine; loading from arbitrary CDNs is not)
- Servers that need root / system-level changes to function
- Servers misrepresenting their capabilities ("connects to GitHub"
  when it actually just opens github.com)
- Servers behind a paid API where the entry doesn't say so
- Duplicate functionality of an existing entry without a clear win

If your entry is rejected, we'll explain why and what would change
the answer.

---

## Questions

Open an issue with the `mcp-question` label. We'd rather answer
before you build than reject after.
