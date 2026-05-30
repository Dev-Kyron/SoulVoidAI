<!--
  Use this template for MCP server submissions only.
  For other changes, delete this file's contents and write a normal PR description.
-->

# MCP server: `<your-server-id>`

## What does this server do?

<!-- One paragraph. What tools does it expose? Who is it for?
     What's the typical use case? -->

## Tool summary

<!-- One bullet per tool the server exposes. e.g.
- `list_issues(repo)` → returns open issues for a GitHub repo
- `create_comment(repo, issue, body)` → posts a comment
-->

## Submitter checklist

- [ ] I added a single entry to `mcp-registry/registry.json`
- [ ] `source` is set to `"community"`
- [ ] `submittedBy` is my GitHub handle
- [ ] `id` is kebab-case (`[a-z0-9-]+`) and unique in the registry
- [ ] I tested the entry by hand via **Settings → MCP → Add custom
      server** and the server booted + tools appeared
- [ ] `command` + `args` point at a real published package (npm /
      uvx / etc.) — not arbitrary user-controlled code
- [ ] Every `{KEY}` placeholder in `args` has a matching `argPrompts`
      entry
- [ ] I ran `node scripts/validate-mcp-registry.mjs` locally and it
      passed
- [ ] `docsUrl` and `repoUrl` are populated so users can audit before
      install

## Permissions / scopes

<!-- What credentials does this server need?
  - API keys / OAuth tokens?
  - Filesystem access? Read-only or read-write?
  - Network access scope? Specific domains or anywhere?
  Helps reviewers understand the attack surface. -->

## Pricing

<!-- Does this server hit a paid API? If so, what's the free tier
     and what does it cost users? Mention only if applicable;
     delete this section otherwise. -->

## Source / docs

repoUrl: <!-- e.g. https://github.com/you/your-mcp-server -->
docsUrl: <!-- e.g. https://github.com/you/your-mcp-server#readme -->

## Anything else?

<!-- Edge cases, OS-specific notes, known issues, future plans, etc. -->
