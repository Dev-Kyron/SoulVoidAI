/**
 * Benchmark JSON storage. Two trees:
 *
 *   resources/clickbench/seed/   — checked in, example shapes the harness
 *                                  ships with. Ground truth coords are
 *                                  PLACEHOLDERS until the user
 *                                  re-captures against their own monitor.
 *   <userData>/clickbench/user/  — local, gitignored, captured against
 *                                  the user's actual desktop. Loaded on
 *                                  top of seed so user-captured truth
 *                                  takes precedence by id.
 *
 * Strategies don't care which tree a benchmark came from; the runner
 * just merges by id and runs the union.
 */
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Benchmark } from './types'

function userBenchmarksDir(): string {
  const dir = join(app.getPath('userData'), 'clickbench', 'benchmarks')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function seedBenchmarksDir(): string {
  // Lives alongside the script bundle so it ships with the app. In dev,
  // resolveAssetsDir falls back to the repo's resources/ folder.
  // Lazy require so this file doesn't pull electron-builder asset hooks
  // when imported by tests.
  return join(app.getAppPath(), 'resources', 'clickbench', 'seed')
}

function loadDir(dir: string): Benchmark[] {
  if (!existsSync(dir)) return []
  const out: Benchmark[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Benchmark
      if (raw && typeof raw.id === 'string' && raw.id.trim()) out.push(raw)
    } catch {
      // Skip malformed JSON — don't crash the bench because one file is bad.
    }
  }
  return out
}

/** Read all benchmarks (seed + user, user takes precedence on id collision). */
export function loadAllBenchmarks(): Benchmark[] {
  const byId = new Map<string, Benchmark>()
  for (const b of loadDir(seedBenchmarksDir())) byId.set(b.id, b)
  for (const b of loadDir(userBenchmarksDir())) byId.set(b.id, b)
  return Array.from(byId.values())
}

/**
 * Persist a benchmark to the user tree. Used by capture mode + edit.
 *
 * Atomic write: serialise → write to `.tmp` → rename. Without this, a
 * crash mid-write (rare but possible with Electron renderer-tabs being
 * force-killed by the OS) would leave a half-written JSON file that
 * `loadDir`'s try/catch would silently skip — the user would think
 * their captured benchmark saved but it'd vanish on the next load.
 */
export function saveUserBenchmark(benchmark: Benchmark): string {
  const dir = userBenchmarksDir()
  const path = join(dir, `${benchmark.id}.json`)
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(benchmark, null, 2), 'utf-8')
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    // Best-effort cleanup of the orphaned temp file — don't mask the
    // original error, that's what the user needs to debug.
    try {
      unlinkSync(tmpPath)
    } catch {
      // Temp file already gone or undeletable; nothing useful to do.
    }
    throw err
  }
  return path
}

/** Where the runner writes HTML + CSV reports. */
export function reportsDir(): string {
  const dir = join(app.getPath('userData'), 'clickbench', 'reports')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
