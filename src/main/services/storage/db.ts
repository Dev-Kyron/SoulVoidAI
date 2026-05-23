/**
 * SQLite singleton + schema for the high-churn stores (embeddings, history,
 * usage, indexed files). Small/human-readable stores (config, keys, memory,
 * mcp, plugins) stay on the JsonStore — they're below the threshold where
 * SQLite earns its keep.
 *
 * Native module: `better-sqlite3`. Synchronous API; calls from the main
 * process are fine because the database file lives on disk next to the user
 * data directory and a single-instance lock guarantees one writer.
 *
 * Migrations: tracked by a `schema_version` row in `meta`. Each `MIGRATIONS`
 * entry runs once, in order. Add new entries to the array; never edit old
 * ones — old installs will have already executed them.
 */
import { dataPath } from './store'
import { existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

const DB_FILENAME = 'voidsoul.db'

/** Each migration runs once, in order. Never edit an existing entry. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        summary     TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        position    INTEGER NOT NULL,
        json        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_thread_pos
        ON messages(thread_id, position);

      CREATE TABLE IF NOT EXISTS embeddings (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL DEFAULT 'chat',
        thread_id   TEXT,
        file_path   TEXT,
        chunk_index INTEGER,
        role        TEXT NOT NULL,
        preview     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        model       TEXT NOT NULL,
        vector      BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS embeddings_thread ON embeddings(thread_id);
      CREATE INDEX IF NOT EXISTS embeddings_file   ON embeddings(file_path);
      CREATE INDEX IF NOT EXISTS embeddings_model  ON embeddings(model);

      CREATE TABLE IF NOT EXISTS indexed_files (
        path         TEXT PRIMARY KEY,
        folder       TEXT NOT NULL,
        size         INTEGER NOT NULL,
        mtime        TEXT NOT NULL,
        sha          TEXT NOT NULL,
        chunk_count  INTEGER NOT NULL,
        last_indexed TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS indexed_files_folder ON indexed_files(folder);

      CREATE TABLE IF NOT EXISTS indexed_folders (
        path        TEXT PRIMARY KEY,
        added_at    TEXT NOT NULL,
        last_scan   TEXT
      );

      CREATE TABLE IF NOT EXISTS usage_entries (
        id          TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        json        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_entries_ts ON usage_entries(ts);

      CREATE TABLE IF NOT EXISTS usage_budget (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        json        TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        prompt         TEXT NOT NULL,
        schedule_kind  TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        last_run       TEXT,
        next_run       TEXT,
        last_result    TEXT,
        last_error     TEXT
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_enabled ON scheduled_tasks(enabled);
    `
  },
  {
    // The RAG worker's hot path filters by `WHERE model = ? AND source = ?`
    // — replace the single-column model index with a composite one so the
    // planner can use both columns of the predicate directly.
    version: 3,
    sql: `
      DROP INDEX IF EXISTS embeddings_model;
      CREATE INDEX IF NOT EXISTS embeddings_model_source
        ON embeddings(model, source);
    `
  },
  {
    // Per-thread mode + system-prompt overrides. NULL on either column means
    // "follow the global config" — the existing behaviour for all threads
    // before this migration.
    version: 4,
    sql: `
      ALTER TABLE threads ADD COLUMN pinned_mode TEXT;
      ALTER TABLE threads ADD COLUMN pinned_system_prompt TEXT;
    `
  },
  {
    // Notebook-style threads — a separate first-class entity. Each notebook
    // owns an ordered list of cells (prompt / python / search / markdown)
    // serialised as JSON; cells reference each other's output via {{cell-N}}
    // template substitution.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS notebooks (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cells      TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS notebooks_updated ON notebooks(updated_at DESC);
    `
  },
  {
    // Projects / Collections — group threads under a shared system prompt
    // and instructions. Closes the Claude-Projects feature gap. Threads
    // can opt into a project (project_id) or stay loose (NULL = no project).
    // The project's `instructions` field becomes the system prompt for any
    // thread in it that doesn't have its own pinned override.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        instructions  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_updated ON projects(updated_at DESC);
      ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
    `
  },
  {
    // Agent-loop checkpoints. One row per in-flight or terminal agent
    // invocation; persisted on every step so a crash / sleep / restart
    // mid-task doesn't lose the user's progress.
    //
    // Lifecycle: created at status='running' when the loop starts,
    // updated each step with new turns/invocations/step, finalised to
    // 'paused' | 'completed' | 'failed' | 'aborted' when the loop exits.
    // Rows stuck at 'running' on next launch are crash-recovery candidates.
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        request_id            TEXT PRIMARY KEY,
        thread_id             TEXT NOT NULL,
        user_message_id       TEXT NOT NULL,
        assistant_message_id  TEXT NOT NULL,
        provider_id           TEXT NOT NULL,
        model_id              TEXT NOT NULL,
        system_prompt         TEXT NOT NULL,
        turns_json            TEXT NOT NULL,
        invocations_json      TEXT NOT NULL DEFAULT '[]',
        step                  INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        failure               TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_checkpoints_status
        ON agent_checkpoints(status);
      CREATE INDEX IF NOT EXISTS agent_checkpoints_updated
        ON agent_checkpoints(updated_at DESC);
    `
  },
  {
    // v1.4.0 Phase 3 — emotional context memory. session_sentiment is
    // append-only: every periodic classification run by the sentiment
    // scheduler writes one row. "Last 7 days" rollups + the current
    // session pull from here. session_end is nullable — the row is
    // written at compute time with session_end open, and stamped only
    // when a new session begins (so the most-recent open-ended row is
    // always "the current session").
    //
    // sentiment enum kept narrow (5 buckets) so the classifier output
    // stays well-defined + the system prompt copy can speak in terms
    // the model recognises. intensity 1-5 makes the model think in a
    // small Likert-scale rather than a free float (LLMs are bad at
    // free-scale numbers, decent at 1-5).
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS session_sentiment (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_start TEXT NOT NULL,
        session_end   TEXT,
        sentiment     TEXT NOT NULL
                      CHECK (sentiment IN ('stressed','productive','stuck','excited','neutral')),
        intensity     INTEGER NOT NULL CHECK (intensity BETWEEN 1 AND 5),
        summary       TEXT,
        computed_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_sentiment_computed_at
        ON session_sentiment(computed_at DESC);
    `
  }
]

let dbInstance: Database.Database | null = null

/** Returns the shared connection, opening + migrating on first use. */
export function db(): Database.Database {
  if (dbInstance) return dbInstance
  const file = dataPath(DB_FILENAME)
  // dataPath() ensures the parent dir exists, but be defensive in case the
  // store helper was bypassed by tests.
  const parent = dirname(file)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  dbInstance = openOrRecover(file)
  return dbInstance
}

/**
 * Opens the SQLite file, applies pragmas, runs migrations. If any of those
 * steps throw (corrupt header, partial WAL, truncated mid-write from a power
 * loss), the existing file is renamed to a timestamped `.corrupt-*.db`
 * sidecar and a fresh database is created in its place. This trades a single
 * total-failure boot crash for "your chat history is gone but the app works
 * and the old file is recoverable on disk".
 *
 * The renamed sidecar lets the user (or a future recovery flow) attempt to
 * dump rows out via `sqlite3 corrupt-*.db .dump` rather than losing data
 * silently.
 */
function openOrRecover(file: string): Database.Database {
  try {
    const handle = new Database(file)
    handle.pragma('journal_mode = WAL')
    handle.pragma('foreign_keys = ON')
    handle.pragma('synchronous = NORMAL')
    migrate(handle)
    return handle
  } catch (err) {
    // Only the existence-and-load failure modes trigger quarantine — a
    // logic error inside migrate() would loop forever otherwise. We log
    // and rethrow if the file simply isn't there; only corruption-flavoured
    // errors prompt the sidecar dance.
    if (!existsSync(file)) throw err
    const message = err instanceof Error ? err.message : String(err)
    const quarantine = `${file}.corrupt-${Date.now()}.db`
    try {
      renameSync(file, quarantine)
      // WAL/SHM sidecars too — leaving them around would let SQLite try to
      // reapply the bad journal to the fresh database.
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${file}${suffix}`
        if (existsSync(sidecar)) {
          try {
            renameSync(sidecar, `${quarantine}${suffix}`)
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      // If rename failed too, we're in a worse state — rethrow original.
      throw err
    }
    // Spawn a fresh DB. If THIS fails we have a real problem worth crashing on.
    const handle = new Database(file)
    handle.pragma('journal_mode = WAL')
    handle.pragma('foreign_keys = ON')
    handle.pragma('synchronous = NORMAL')
    migrate(handle)
    // Stamp the recovery in the meta table so it's visible later.
    try {
      handle
        .prepare(
          `INSERT INTO meta(key, value) VALUES('recovered_from', @v)
           ON CONFLICT(key) DO UPDATE SET value = @v`
        )
        .run({ v: `${quarantine} (${message})` })
    } catch {
      /* meta might not exist if migrate failed; non-fatal */
    }
    return handle
  }
}

function currentVersion(handle: Database.Database): number {
  handle
    .prepare(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    .run()
  const row = handle.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row ? Number(row.value) : 0
}

function migrate(handle: Database.Database): void {
  const current = currentVersion(handle)
  const setVersion = handle.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version', @v)
       ON CONFLICT(key) DO UPDATE SET value = @v`
  )
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    handle.exec(m.sql)
    setVersion.run({ v: String(m.version) })
  }
}

/** Encodes a vector for BLOB storage. Float32 keeps the file ~4x smaller. */
export function vectorToBlob(vector: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4)
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4)
  return buf
}

/** Decodes a BLOB back into a plain number[]. Cheap; allocates once. */
export function blobToVector(blob: Buffer): number[] {
  const out = new Array<number>(blob.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = blob.readFloatLE(i * 4)
  return out
}

/* --------------------------- one-shot JSON ingest --------------------------- */

/**
 * One-time migrator: if the legacy JSON file for a store exists, read it,
 * write rows via `ingest`, then rename it to `*.json.migrated` so it isn't
 * re-applied on the next boot. Best-effort — failures leave the JSON alone.
 */
export function ingestLegacyJson<T>(
  name: string,
  ingest: (parsed: T) => void
): { migrated: boolean; error?: string } {
  const file = dataPath(`${name}.json`)
  if (!existsSync(file)) return { migrated: false }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as T
    ingest(parsed)
    try {
      renameSync(file, join(dirname(file), `${name}.json.migrated`))
    } catch {
      // If rename fails (e.g. permissions), at least the data is in SQL.
    }
    return { migrated: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return { migrated: false, error: message }
  }
}

/** Closes the connection; used on app quit and by tests. */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
