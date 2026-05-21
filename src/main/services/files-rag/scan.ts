/**
 * Recursive folder walker that yields every file path under a root, skipping
 * the directories everyone wants to skip (node_modules, .git, build outputs,
 * caches…). Returns absolute paths.
 *
 * Symlinks are not followed — keeps the walk bounded and avoids cycles.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  '.turbo',
  'Saved',
  'Intermediate',
  'Binaries',
  'DerivedDataCache',
  '__pycache__',
  '.venv',
  'venv',
  'target'
])

const MAX_FILES_PER_FOLDER = 10_000

export async function walkFolder(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length && out.length < MAX_FILES_PER_FOLDER) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      log(
        'warn',
        'files-rag',
        `Could not read directory: ${dir}`,
        err instanceof Error ? err.message : String(err)
      )
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
      } else if (entry.isFile()) {
        out.push(full)
        if (out.length >= MAX_FILES_PER_FOLDER) break
      }
    }
  }
  return out
}
