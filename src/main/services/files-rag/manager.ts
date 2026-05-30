/**
 * File RAG orchestrator. Owns the lifecycle of "indexed folders": add a
 * folder → walk it → extract text → chunk → embed → store. Re-running on the
 * same folder skips unchanged files (matched by sha + mtime).
 *
 * Folders and per-file metadata live in the SQLite `indexed_folders` and
 * `indexed_files` tables; chunk embeddings live alongside chat embeddings in
 * the `embeddings` table with `source = 'file'`.
 *
 * Everything is best-effort: a failed file is skipped, a failed embed batch
 * stops the run gracefully without throwing.
 */
import { stat } from 'node:fs/promises'
import { db } from '../storage/db'
import { extractFile, isSupportedFile } from './extract'
import { walkFolder } from './scan'
import { chunkText } from './chunk'
import { indexFileChunks, removeByFolder, removeByFilePath } from '../embeddings'
import { log } from '../logger'
import type { IndexedFileSummary, IndexedFolder, ScanProgress, ScanResult } from '@shared/types'

export type { IndexedFileSummary, IndexedFolder, ScanProgress, ScanResult }

let activeScan: ScanProgress | null = null
/**
 * Per-folder in-flight scan promise. Used to dedupe concurrent rescans on the
 * same folder — two "Rescan" clicks (or a manual rescan during "Rescan all")
 * would otherwise interleave writes to `indexed_files` and overwrite each
 * other's progress in `activeScan`.
 */
const scanInFlight = new Map<string, Promise<ScanResult>>()
/** Tombstone set of folders the user removed mid-scan — checked in the loop. */
const removedDuringScan = new Set<string>()
/**
 * v2.0 — pause requests. The user clicked Pause while a scan was running;
 * the loop checks this set after each file and exits cleanly. The partial
 * index stays on disk (per-file upserts already commit progress), so a
 * subsequent `scanFolder` call resumes via the existing stat-skip path.
 */
const pauseRequested = new Set<string>()

export function getActiveScan(): ScanProgress | null {
  return activeScan
}

/**
 * v2.0 — request that the in-flight scan for `folder` pause after the
 * current file finishes. Idempotent and safe to call when no scan is
 * running (the flag clears on the next scan start). The in-flight promise
 * resolves with `paused: true` rather than throwing — the renderer treats
 * it as a non-error outcome.
 */
export function stopScan(folder: string): void {
  pauseRequested.add(folder)
}

/* ----------------------------- folder CRUD ------------------------------ */

export function listFolders(): IndexedFolder[] {
  const rows = db()
    .prepare(
      `SELECT f.path, f.added_at, f.last_scan,
              (SELECT COUNT(*) FROM indexed_files WHERE folder = f.path) AS file_count,
              (SELECT COALESCE(SUM(chunk_count), 0) FROM indexed_files WHERE folder = f.path) AS chunk_count
       FROM indexed_folders f
       ORDER BY f.added_at ASC`
    )
    .all() as Array<{
    path: string
    added_at: string
    last_scan: string | null
    file_count: number
    chunk_count: number
  }>
  return rows.map((r) => ({
    path: r.path,
    addedAt: r.added_at,
    lastScan: r.last_scan,
    fileCount: r.file_count,
    chunkCount: r.chunk_count
  }))
}

export function listFiles(folder: string): IndexedFileSummary[] {
  const rows = db()
    .prepare(
      `SELECT path, folder, size, mtime, chunk_count, last_indexed
       FROM indexed_files WHERE folder = ? ORDER BY path ASC`
    )
    .all(folder) as Array<{
    path: string
    folder: string
    size: number
    mtime: string
    chunk_count: number
    last_indexed: string
  }>
  return rows.map((r) => ({
    path: r.path,
    folder: r.folder,
    size: r.size,
    mtime: r.mtime,
    chunkCount: r.chunk_count,
    lastIndexed: r.last_indexed
  }))
}

export async function addFolder(path: string): Promise<IndexedFolder> {
  // Verify the path is a real, readable directory before we register it.
  // Without this an unreadable / deleted / unmounted folder ends up listed
  // as "scanned · 0 files" with no signal that it's actually broken.
  try {
    const stats = await stat(path)
    if (!stats.isDirectory()) {
      throw new Error('Not a directory')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('warn', 'files-rag', `Refused to index "${path}"`, message)
    throw new Error(`Cannot index "${path}": ${message}`)
  }
  const now = new Date().toISOString()
  db()
    .prepare(
      `INSERT INTO indexed_folders (path, added_at, last_scan) VALUES (?, ?, NULL)
       ON CONFLICT(path) DO NOTHING`
    )
    .run(path, now)
  // Clear any leftover tombstone — re-adding a previously removed folder
  // should index normally.
  removedDuringScan.delete(path)
  return (
    listFolders().find((f) => f.path === path) ?? {
      path,
      addedAt: now,
      lastScan: null,
      fileCount: 0,
      chunkCount: 0
    }
  )
}

export function removeFolder(path: string): IndexedFolder[] {
  // Plant a tombstone so any in-flight `scanFolder` for this path aborts on
  // its next iteration instead of resurrecting rows after the delete.
  removedDuringScan.add(path)
  const handle = db()
  const tx = handle.transaction(() => {
    handle.prepare(`DELETE FROM indexed_files WHERE folder = ?`).run(path)
    handle.prepare(`DELETE FROM indexed_folders WHERE path = ?`).run(path)
  })
  tx()
  removeByFolder(path)
  return listFolders()
}

/* -------------------------------- scan ---------------------------------- */

interface FileRow {
  path: string
  size: number
  mtime: string
  sha: string
}

/** Reads existing file rows for a folder into a lookup keyed by path. */
function existingFiles(folder: string): Map<string, FileRow> {
  const rows = db()
    .prepare(`SELECT path, size, mtime, sha FROM indexed_files WHERE folder = ?`)
    .all(folder) as FileRow[]
  return new Map(rows.map((r) => [r.path, r]))
}

function upsertFileRow(
  folder: string,
  file: {
    path: string
    size: number
    mtime: string
    sha: string
    chunkCount: number
  }
): void {
  db()
    .prepare(
      `INSERT INTO indexed_files (path, folder, size, mtime, sha, chunk_count, last_indexed)
       VALUES (@path, @folder, @size, @mtime, @sha, @chunk_count, @last_indexed)
       ON CONFLICT(path) DO UPDATE SET
         folder       = excluded.folder,
         size         = excluded.size,
         mtime        = excluded.mtime,
         sha          = excluded.sha,
         chunk_count  = excluded.chunk_count,
         last_indexed = excluded.last_indexed`
    )
    .run({
      path: file.path,
      folder,
      size: file.size,
      mtime: file.mtime,
      sha: file.sha,
      chunk_count: file.chunkCount,
      last_indexed: new Date().toISOString()
    })
}

function dropFileRow(path: string): void {
  db().prepare(`DELETE FROM indexed_files WHERE path = ?`).run(path)
  removeByFilePath(path)
}

/**
 * Scans (or re-scans) one folder. Files with unchanged sha+size+mtime are
 * skipped. Deleted files have their rows + vectors pruned.
 *
 * Per-folder mutex: a second call while the first is running returns the
 * same promise rather than racing it.
 */
export function scanFolder(
  path: string,
  onProgress?: (p: ScanProgress) => void
): Promise<ScanResult> {
  const inflight = scanInFlight.get(path)
  if (inflight) return inflight
  const work = runScan(path, onProgress).finally(() => {
    if (scanInFlight.get(path) === work) scanInFlight.delete(path)
  })
  scanInFlight.set(path, work)
  return work
}

async function runScan(path: string, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
  // Make sure the folder is registered before we proceed. Validation lives in
  // addFolder so a bad path bubbles up here instead of producing a "0 files"
  // ghost entry.
  try {
    await addFolder(path)
  } catch (err) {
    return {
      folder: path,
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      chunksAdded: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  // A fresh scan run begins — clear any stale tombstone so the new run isn't
  // immediately aborted by a previous removal. Pause flag too: a Pause
  // request from a *previous* run is stale once the user explicitly
  // triggered a new scan.
  removedDuringScan.delete(path)
  pauseRequested.delete(path)

  const result: ScanResult = {
    folder: path,
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksAdded: 0
  }

  let paths: string[]
  try {
    // Sort lexicographically so a resumed scan walks files in the same
    // order as the previous run — gives the stat-skip path a predictable
    // contiguous prefix of "already done" instead of jumping around. Also
    // makes progress feel monotonic to the user staring at the breadcrumb.
    paths = (await walkFolder(path)).filter(isSupportedFile).sort()
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'walk failed'
    return result
  }

  const known = existingFiles(path)
  const seen = new Set<string>()
  activeScan = { folder: path, done: 0, total: paths.length }
  onProgress?.(activeScan)

  // Snapshot the "already indexed" count BEFORE we walk — if this scan was
  // paused and is now resuming, the diff between this and `filesSkipped`
  // at the end tells us how much was previously indexed vs newly skipped.
  const alreadyIndexedAtStart = known.size

  try {
    for (const filePath of paths) {
      // Honour the tombstone — the user removed this folder mid-scan, so stop
      // writing rows for it (they'd zombie back in after the removal).
      if (removedDuringScan.has(path)) {
        result.error = 'Folder removed during scan'
        break
      }
      // User clicked Pause — exit cleanly. Per-file commits already landed
      // for everything we processed, so a future scan picks up here via
      // the stat-skip path.
      if (pauseRequested.has(path)) {
        result.paused = true
        break
      }
      seen.add(filePath)
      activeScan = {
        folder: path,
        done: result.filesScanned,
        total: paths.length,
        current: filePath
      }
      onProgress?.(activeScan)
      result.filesScanned++

      // Cheap stat-first skip: for an unchanged file, this avoids a worker
      // round-trip plus a full file read + sha1 hash. Without it, a rescan
      // of 5000 unchanged files would do 5000 PDF/DOCX parses just to
      // discover nothing changed.
      const prior = known.get(filePath)
      if (prior) {
        try {
          const stats = await stat(filePath)
          if (stats.size === prior.size && stats.mtime.toISOString() === prior.mtime) {
            result.filesSkipped++
            continue
          }
        } catch {
          // stat failed — fall through to the worker which will surface the
          // real error (and skip this file naturally).
        }
      }

      const extracted = await extractFile(filePath)
      if (!extracted || !extracted.text.trim()) {
        result.filesSkipped++
        continue
      }

      // sha is the authoritative tie-breaker — catches content changes that
      // happen without size+mtime moving (rare but possible: copy-over with
      // touched timestamps).
      if (
        prior &&
        prior.sha === extracted.meta.sha &&
        prior.size === extracted.meta.size &&
        prior.mtime === extracted.meta.mtime
      ) {
        result.filesSkipped++
        continue
      }

      // Content changed (or first time) — drop old vectors for this file then
      // re-chunk + re-embed.
      removeByFilePath(filePath)
      const chunks = chunkText(extracted.text)
      if (chunks.length === 0) {
        result.filesSkipped++
        continue
      }
      const added = await indexFileChunks(
        chunks.map((c) => ({
          id: `${filePath}#${c.index}`,
          filePath,
          chunkIndex: c.index,
          content: c.text,
          createdAt: extracted.meta.mtime
        }))
      )
      // Only mark the file as "indexed" when *every* chunk landed. A partial
      // embed (provider went away mid-batch) would otherwise look complete on
      // sha+mtime next scan and never get retried.
      if (added < chunks.length) {
        result.filesSkipped++
        log(
          'warn',
          'files-rag',
          `Partial embed for "${filePath}" (${added}/${chunks.length} chunks) — leaving for retry.`
        )
        continue
      }
      result.chunksAdded += added
      upsertFileRow(path, {
        path: filePath,
        size: extracted.meta.size,
        mtime: extracted.meta.mtime,
        sha: extracted.meta.sha,
        chunkCount: added
      })
      result.filesIndexed++
    }

    // Skip the prune + last_scan update if the folder was removed mid-scan
    // (its rows are already gone via the tombstone-triggered removeFolder)
    // OR if the user paused mid-scan (files past the pause point haven't
    // been visited — pruning would delete legitimately-indexed entries
    // just because we hadn't gotten to verifying their on-disk presence).
    if (!removedDuringScan.has(path) && !result.paused) {
      // Files that vanished from disk since the previous scan get pruned.
      for (const [knownPath] of known) {
        if (!seen.has(knownPath)) dropFileRow(knownPath)
      }
      db()
        .prepare(`UPDATE indexed_folders SET last_scan = ? WHERE path = ?`)
        .run(new Date().toISOString(), path)
    }
  } finally {
    activeScan = null
    pauseRequested.delete(path)
    onProgress?.({ folder: path, done: result.filesScanned, total: paths.length })
  }
  if (result.paused) {
    log(
      'info',
      'files-rag',
      `Scan paused for ${path}: ${result.filesScanned}/${paths.length} files visited (${alreadyIndexedAtStart} already indexed at start). Resume by clicking Rescan.`
    )
  } else {
    log(
      'info',
      'files-rag',
      `Scan finished for ${path}: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.chunksAdded} chunks${alreadyIndexedAtStart > 0 ? ` (${alreadyIndexedAtStart} files carried over from previous runs)` : ''}.`
    )
  }
  return result
}

/** Re-indexes every registered folder. Used by the "Rescan all" button. */
export async function rescanAll(onProgress?: (p: ScanProgress) => void): Promise<ScanResult[]> {
  const folders = listFolders()
  const results: ScanResult[] = []
  for (const folder of folders) {
    results.push(await scanFolder(folder.path, onProgress))
  }
  return results
}

/**
 * Bulk-registers folders from a restored backup. The bundle only captures the
 * paths (not chunks/embeddings — those would balloon the file), so callers
 * should prompt the user to rescan after import.
 */
export function restoreFolders(paths: string[]): IndexedFolder[] {
  const now = new Date().toISOString()
  const handle = db()
  const insert = handle.prepare(
    `INSERT INTO indexed_folders (path, added_at, last_scan) VALUES (?, ?, NULL)
       ON CONFLICT(path) DO NOTHING`
  )
  const tx = handle.transaction((rows: string[]) => {
    for (const p of rows) insert.run(p, now)
  })
  tx(paths)
  return listFolders()
}
