<!--
  Use this template for plugin submissions only.
  For other changes, delete this file's contents and write a normal PR description.
-->

# Plugin: `<your-plugin-id>`

## What does it do?

<!-- One paragraph. What problem does the plugin solve? Who is it for? -->

## Action summary

<!-- One bullet per quickAction the plugin contributes. e.g.
- "Open Figma" → opens https://figma.com in default browser (`browser`)
- "Capture screenshot of current window" → screenshot action (`screenCapture`)
-->

## Submitter checklist

- [ ] I added a single entry to `plugins-registry/registry.json`
- [ ] `source` is set to `"community"`
- [ ] `submittedBy` is my GitHub handle
- [ ] `id` is filesystem-safe (`[a-zA-Z0-9._-]` only) and unique in the registry
- [ ] Every action uses a built-in `action.type` — no custom code
- [ ] I ran `node scripts/validate-plugin-registry.mjs` locally and it passed
- [ ] If my entry has `hooks`, I've explained below WHY they're necessary
  (declarative actions are preferred where possible)

## Hooks justification (if applicable)

<!-- Delete this section if your plugin has no `hooks`. Otherwise:
  - Which hook names do you use?
  - What does each one do?
  - Why couldn't you achieve the same result with declarative actions only?
  - Does any hook make network requests? To which domains, and why?
-->

## Source / docs

<!-- Optional: link to the plugin's source repo if it has one.
     This is what users see when they click "source ↗" on your card. -->

repoUrl: <!-- e.g. https://github.com/you/voidsoul-plugin-foo -->

## Anything else?

<!-- Edge cases, known limitations, future plans, etc. -->
