#!/usr/bin/env node
/**
 * v2.0 — validates mcp-registry/registry.json against the schema the
 * in-app marketplace expects. Runs locally
 * (`node scripts/validate-mcp-registry.mjs`) and in CI on every PR
 * via `.github/workflows/validate-mcp-registry.yml`.
 *
 * Companion to `validate-plugin-registry.mjs`; same philosophy — pure
 * Node, no `npm install`, fails the PR loudly on hard errors and
 * carries on with warnings on soft ones.
 *
 * What it enforces:
 *   - Top-level shape: { version, servers: [] }
 *   - Each server has id / name / description / command / args
 *   - id is kebab-friendly + unique within the registry
 *   - source is 'curated' (default) or 'community'
 *   - community entries have submittedBy + a valid repoUrl
 *   - argPrompts / envPrompts shape (each key non-empty, no dupes)
 *
 * NON-goals: doesn't run `command`/`args` to verify the package exists,
 * doesn't fetch the remote registry, doesn't perform Ed25519 signing
 * (that's `scripts/sign-mcp-registry.mjs`).
 *
 * Exit 0 = clean, 1 = errors.
 *
 * Drift mitigation: the CI workflow also triggers on changes to
 * src/shared/types.ts, so a future field rename on McpRegistryEntry
 * surfaces here instead of silently in a contributor's PR.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REGISTRY_PATH = resolve('mcp-registry/registry.json')

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i
const VALID_SOURCES = new Set(['curated', 'community'])

const errors = []
const warnings = []

function fail(msg) {
  errors.push(msg)
}

function warn(msg) {
  warnings.push(msg)
}

if (!existsSync(REGISTRY_PATH)) {
  console.error(`[validate-mcp-registry] Not found: ${REGISTRY_PATH}`)
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'))
} catch (err) {
  console.error('[validate-mcp-registry] Registry is not valid JSON.')
  console.error(err.message)
  process.exit(1)
}

if (typeof parsed !== 'object' || parsed === null) {
  fail('Top-level must be an object.')
} else {
  if (typeof parsed.version !== 'number') {
    fail('Top-level must have a numeric `version` field.')
  }
  if (!Array.isArray(parsed.servers)) {
    fail('Top-level must have a `servers` array.')
  }
}

const seenIds = new Set()

for (const [idx, entry] of (parsed?.servers ?? []).entries()) {
  const where = `servers[${idx}]${entry?.id ? ` (${entry.id})` : ''}`

  if (typeof entry !== 'object' || entry === null) {
    fail(`${where}: must be an object.`)
    continue
  }

  // Required fields.
  for (const field of ['id', 'name', 'description', 'command']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      fail(`${where}: missing or empty required string field '${field}'.`)
    }
  }
  if (!Array.isArray(entry.args)) {
    fail(`${where}: 'args' must be an array of strings.`)
  } else if (entry.args.some((a) => typeof a !== 'string')) {
    fail(`${where}: every entry in 'args' must be a string.`)
  }

  // id sanity. MCP ids are kebab-case slugs by convention; we don't
  // need filesystem-safety like plugin ids (MCP entries aren't written
  // to per-id files) but we DO want them stable + searchable.
  if (typeof entry.id === 'string') {
    if (!ID_PATTERN.test(entry.id)) {
      fail(`${where}: id '${entry.id}' must match [a-z0-9][a-z0-9-]* (case-insensitive).`)
    }
    if (seenIds.has(entry.id)) {
      fail(`${where}: duplicate id '${entry.id}'.`)
    }
    seenIds.add(entry.id)
  }

  // source tier.
  const source = entry.source ?? 'curated'
  if (!VALID_SOURCES.has(source)) {
    fail(
      `${where}: source '${source}' must be 'curated' or 'community'. ` +
        `(External aggregators like smithery/glama/pulsemcp are populated by the app at runtime, not in this registry.)`
    )
  }

  if (source === 'community') {
    if (typeof entry.submittedBy !== 'string' || !entry.submittedBy.trim()) {
      fail(`${where}: community entries require 'submittedBy' (your GitHub handle).`)
    }
    if (entry.submittedAt !== undefined) {
      const d = new Date(entry.submittedAt)
      if (Number.isNaN(d.getTime())) {
        fail(`${where}: submittedAt '${entry.submittedAt}' is not a valid date.`)
      }
    }
    if (entry.repoUrl !== undefined) {
      try {
        const url = new URL(entry.repoUrl)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          fail(`${where}: repoUrl must be http(s).`)
        }
      } catch {
        fail(`${where}: repoUrl is not a valid URL.`)
      }
    } else {
      warn(
        `${where}: community entry without a repoUrl — encourage submitters to link the upstream package.`
      )
    }
  }

  // docsUrl is also an external URL we render — same validation.
  if (entry.docsUrl !== undefined) {
    if (typeof entry.docsUrl !== 'string') {
      fail(`${where}: docsUrl must be a string.`)
    } else {
      try {
        const url = new URL(entry.docsUrl)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          fail(`${where}: docsUrl must be http(s).`)
        }
      } catch {
        fail(`${where}: docsUrl is not a valid URL.`)
      }
    }
  }

  // Prompt arrays — keys must be non-empty and unique within their array.
  for (const promptField of ['argPrompts', 'envPrompts']) {
    const list = entry[promptField]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      fail(`${where}: '${promptField}' must be an array.`)
      continue
    }
    const keys = new Set()
    for (const [pIdx, prompt] of list.entries()) {
      const pWhere = `${where}.${promptField}[${pIdx}]`
      if (typeof prompt !== 'object' || prompt === null) {
        fail(`${pWhere}: must be an object.`)
        continue
      }
      if (typeof prompt.key !== 'string' || !prompt.key.trim()) {
        fail(`${pWhere}: missing or empty 'key'.`)
      } else if (keys.has(prompt.key)) {
        fail(`${pWhere}: duplicate prompt key '${prompt.key}' within ${promptField}.`)
      } else {
        keys.add(prompt.key)
      }
      if (typeof prompt.label !== 'string' || !prompt.label.trim()) {
        fail(`${pWhere}: missing or empty 'label'.`)
      }
    }
  }

  // Cross-check both directions between args placeholders and the
  // argPrompts UI definitions:
  //
  //   - {KEY} in args  → must have a matching argPrompts entry,
  //     otherwise the installer leaves a literal "{KEY}" in the
  //     spawned command and the server silently breaks.
  //   - argPrompts key → must appear as {KEY} somewhere in args,
  //     otherwise the user fills in a field whose value goes nowhere
  //     ("dangling prompt") — equally silent footgun.
  //
  // Both halves are 'fail' rather than 'warn' because both shapes are
  // user-hostile bugs that make the registry entry literally not work
  // — better to block the PR than ship broken entries to the CDN.
  if (Array.isArray(entry.args)) {
    const declaredArgKeys = new Set(
      (Array.isArray(entry.argPrompts) ? entry.argPrompts : []).map((p) => p?.key).filter(Boolean)
    )
    const placeholders = new Set()
    for (const a of entry.args) {
      if (typeof a !== 'string') continue
      const matches = a.match(/\{([A-Z0-9_]+)\}/g) ?? []
      for (const m of matches) placeholders.add(m.slice(1, -1))
    }
    // Forward: every {KEY} placeholder needs a declared prompt.
    for (const placeholder of placeholders) {
      if (!declaredArgKeys.has(placeholder)) {
        fail(
          `${where}: args contains {${placeholder}} but no matching argPrompts entry. ` +
            `Add an argPrompts row with key='${placeholder}' so the installer can collect the value.`
        )
      }
    }
    // Reverse: every declared prompt needs a {KEY} somewhere in args.
    for (const declaredKey of declaredArgKeys) {
      if (!placeholders.has(declaredKey)) {
        fail(
          `${where}: argPrompts declares key '${declaredKey}' but no args entry references {${declaredKey}}. ` +
            `Either reference {${declaredKey}} in args (the installer will substitute it) or remove the unused prompt.`
        )
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn(`[validate-mcp-registry] ${warnings.length} warning(s):`)
  for (const w of warnings) console.warn(`  ⚠ ${w}`)
}

if (errors.length > 0) {
  console.error(`[validate-mcp-registry] ${errors.length} error(s):`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}

console.log(
  `[validate-mcp-registry] OK — ${parsed.servers.length} entr${
    parsed.servers.length === 1 ? 'y' : 'ies'
  } validated.`
)
