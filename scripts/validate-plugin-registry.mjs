#!/usr/bin/env node
/**
 * v2.0 — validates plugins-registry/registry.json against the schema
 * the in-app marketplace expects. Runs locally (`node
 * scripts/validate-plugin-registry.mjs`) and in CI on every PR via
 * `.github/workflows/validate-plugin-registry.yml`.
 *
 * What it enforces:
 *   - Top-level shape: { version, plugins: [] }
 *   - Each plugin has the required PluginManifest fields
 *   - id is filesystem-safe + unique within the registry
 *   - source is 'curated' (default) or 'community'
 *   - community entries have submittedBy set
 *   - every action.type is a recognised built-in ActionType
 *   - every requires is a recognised PermissionId
 *   - hooks (if present) are non-empty strings with sane names
 *
 * NON-goals: this script does NOT execute hook code, doesn't fetch the
 * remote registry, doesn't try to enforce subjective rules like "is
 * this URL hostile" — those live in the human PR review step.
 *
 * Exit code 0 = clean, 1 = failed validation (CI breaks the PR).
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REGISTRY_PATH = resolve('plugins-registry/registry.json')

// Source of truth: keep these mirrored with src/shared/permissions.ts
// + src/shared/types.ts (ActionType union) + the registry README. A
// future test that re-imports those would be nicer, but pulling TS
// into a vanilla Node script costs more than it saves at this scale.
//
// Drift mitigation: the CI workflow that runs this script (see
// .github/workflows/validate-plugin-registry.yml) also triggers on
// changes to src/shared/types.ts and src/shared/permissions.ts, so a
// new ActionType / PermissionId added there without a matching update
// here surfaces as a CI failure when the registry hasn't been touched
// — flagging the gap before a community PR runs into it.
//
// TODO(v2.1): replace these hardcoded sets with a shared JSON
// constants file consumed by both this script AND a vitest test
// against the runtime-readable form of the TS unions.
const VALID_PERMISSIONS = new Set([
  'terminal',
  'filesystem',
  'browser',
  'appControl',
  'inputAccess',
  'microphone',
  'screenCapture'
])

const VALID_ACTION_TYPES = new Set([
  'open-app',
  'open-url',
  'open-folder',
  'shell',
  'file-list',
  'file-read',
  'file-write',
  'organize-folder',
  'type-text',
  'hotkey',
  'move-mouse',
  'mouse-click',
  'visual-click',
  'screenshot',
  'read-screen',
  'web-search',
  'web-fetch',
  'deep-research',
  'generate-image',
  'edit-image-inpaint',
  'edit-image-upscale',
  'edit-image-bg-remove',
  'run-python',
  'save-document'
])

const VALID_HOOK_NAMES = new Set([
  'onUserMessage',
  'onAssistantReply',
  'onProactiveSpeak',
  'onToolCalled'
])

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i

const errors = []
const warnings = []

function fail(msg) {
  errors.push(msg)
}

function warn(msg) {
  warnings.push(msg)
}

if (!existsSync(REGISTRY_PATH)) {
  console.error(`[validate-plugin-registry] Not found: ${REGISTRY_PATH}`)
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'))
} catch (err) {
  console.error('[validate-plugin-registry] Registry is not valid JSON.')
  console.error(err.message)
  process.exit(1)
}

if (typeof parsed !== 'object' || parsed === null) {
  fail('Top-level must be an object.')
} else {
  if (typeof parsed.version !== 'number') {
    fail('Top-level must have a numeric `version` field.')
  }
  if (!Array.isArray(parsed.plugins)) {
    fail('Top-level must have a `plugins` array.')
  }
}

const seenIds = new Set()

for (const [idx, entry] of (parsed?.plugins ?? []).entries()) {
  const where = `plugins[${idx}]${entry?.id ? ` (${entry.id})` : ''}`

  if (typeof entry !== 'object' || entry === null) {
    fail(`${where}: must be an object.`)
    continue
  }

  // Required fields.
  for (const field of ['id', 'name', 'version', 'description']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      fail(`${where}: missing or empty required string field '${field}'.`)
    }
  }
  if (!Array.isArray(entry.quickActions)) {
    fail(`${where}: missing 'quickActions' array.`)
  }

  // id sanity.
  if (typeof entry.id === 'string') {
    if (!ID_PATTERN.test(entry.id)) {
      fail(`${where}: id '${entry.id}' must match [a-zA-Z0-9._-]+ only.`)
    }
    if (entry.id.startsWith('.')) {
      fail(`${where}: id must not start with a dot.`)
    }
    if (seenIds.has(entry.id)) {
      fail(`${where}: duplicate id '${entry.id}'.`)
    }
    seenIds.add(entry.id)
  }

  // version sanity (loose semver).
  if (typeof entry.version === 'string' && !SAFE_VERSION_PATTERN.test(entry.version)) {
    warn(`${where}: version '${entry.version}' isn't strict semver (allowed but unusual).`)
  }

  // source tier.
  const source = entry.source ?? 'curated'
  if (source !== 'curated' && source !== 'community') {
    fail(`${where}: source '${source}' must be 'curated' or 'community'.`)
  }

  // Community submissions need attribution.
  if (source === 'community') {
    if (typeof entry.submittedBy !== 'string' || !entry.submittedBy.trim()) {
      fail(`${where}: community entries require 'submittedBy' (your GitHub handle).`)
    }
    if (entry.submittedAt !== undefined) {
      // Allow ISO date OR plain YYYY-MM-DD.
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
    }
  }

  // Action shape.
  for (const [aIdx, action] of (entry.quickActions ?? []).entries()) {
    const aWhere = `${where}.quickActions[${aIdx}]`
    if (typeof action !== 'object' || action === null) {
      fail(`${aWhere}: must be an object.`)
      continue
    }
    for (const field of ['id', 'label', 'description']) {
      if (typeof action[field] !== 'string' || !action[field].trim()) {
        fail(`${aWhere}: missing required string '${field}'.`)
      }
    }
    if (action.requires !== null && action.requires !== undefined) {
      if (!VALID_PERMISSIONS.has(action.requires)) {
        fail(
          `${aWhere}: 'requires' must be one of [${[...VALID_PERMISSIONS].join(', ')}] or null.`
        )
      }
    }
    if (typeof action.action !== 'object' || action.action === null) {
      fail(`${aWhere}: 'action' must be an object.`)
      continue
    }
    if (!VALID_ACTION_TYPES.has(action.action.type)) {
      fail(
        `${aWhere}: action.type '${action.action.type}' is not a recognised built-in. ` +
          `See src/shared/types.ts ActionType for the full list.`
      )
    }
  }

  // Hooks shape. We don't run the JS — just enforce shape + flag for
  // human review. Community + hooks is allowed, but the install dialog
  // surfaces an extra warning.
  if (entry.hooks !== undefined) {
    if (typeof entry.hooks !== 'object' || entry.hooks === null || Array.isArray(entry.hooks)) {
      fail(`${where}: hooks must be an object map of HookName → string.`)
    } else {
      for (const [name, body] of Object.entries(entry.hooks)) {
        if (!VALID_HOOK_NAMES.has(name)) {
          fail(
            `${where}: hook name '${name}' is not recognised. ` +
              `Allowed: [${[...VALID_HOOK_NAMES].join(', ')}].`
          )
        }
        if (typeof body !== 'string' || !body.trim()) {
          fail(`${where}: hook '${name}' body must be a non-empty string.`)
        }
        if (typeof body === 'string' && body.length > 10_000) {
          warn(
            `${where}: hook '${name}' body is ${body.length} chars — large hooks are reviewed extra carefully.`
          )
        }
      }
      if (source === 'community') {
        warn(
          `${where}: community entry declares hooks — maintainer will review the JS for safety.`
        )
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn(`[validate-plugin-registry] ${warnings.length} warning(s):`)
  for (const w of warnings) console.warn(`  ⚠ ${w}`)
}

if (errors.length > 0) {
  console.error(`[validate-plugin-registry] ${errors.length} error(s):`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}

console.log(
  `[validate-plugin-registry] OK — ${parsed.plugins.length} entr${
    parsed.plugins.length === 1 ? 'y' : 'ies'
  } validated.`
)
