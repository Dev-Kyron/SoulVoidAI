/**
 * Usage log + monthly budget. SQLite-backed: one row per recorded API call
 * (with the full UsageEntry as JSON), plus a singleton budget row.
 *
 * On first boot we ingest the legacy `usage.json` file (entries + budget)
 * and archive it so it isn't re-imported on the next launch.
 */
import { db, ingestLegacyJson } from '../storage/db'
import type { UsageBudget, UsageEntry } from '@shared/types'

const MAX_ENTRIES = 5000

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const DEFAULT_BUDGET: UsageBudget = {
  monthlyUsd: null,
  warned75: false,
  warned90: false,
  warned100: false,
  month: currentMonth()
}

let migrated = false

function readBudgetRow(): UsageBudget {
  const row = db().prepare(`SELECT json FROM usage_budget WHERE id = 1`).get() as
    | { json: string }
    | undefined
  if (!row) return { ...DEFAULT_BUDGET }
  try {
    return JSON.parse(row.json) as UsageBudget
  } catch {
    return { ...DEFAULT_BUDGET }
  }
}

function writeBudgetRow(budget: UsageBudget): void {
  db()
    .prepare(
      `INSERT INTO usage_budget(id, json) VALUES(1, @json)
         ON CONFLICT(id) DO UPDATE SET json = @json`
    )
    .run({ json: JSON.stringify(budget) })
}

function ensureMigrated(): void {
  if (migrated) return
  migrated = true
  ingestLegacyJson<{ entries?: UsageEntry[]; budget?: UsageBudget }>('usage', (parsed) => {
    if (parsed.budget) writeBudgetRow(parsed.budget)
    if (parsed.entries?.length) {
      const handle = db()
      const insert = handle.prepare(`
        INSERT OR REPLACE INTO usage_entries (id, ts, provider, model, json)
        VALUES (@id, @ts, @provider, @model, @json)
      `)
      const tx = handle.transaction((rows: UsageEntry[]) => {
        for (const e of rows) {
          insert.run({
            id: e.id,
            ts: e.ts,
            provider: e.provider,
            model: e.model,
            json: JSON.stringify(e)
          })
        }
      })
      tx(parsed.entries)
    }
  })
}

export function getEntries(): UsageEntry[] {
  ensureMigrated()
  const rows = db().prepare(`SELECT json FROM usage_entries ORDER BY ts ASC`).all() as {
    json: string
  }[]
  return rows.map((r) => JSON.parse(r.json) as UsageEntry)
}

export function appendEntry(entry: UsageEntry): void {
  ensureMigrated()
  const handle = db()
  const insert = handle.prepare(`
    INSERT OR REPLACE INTO usage_entries (id, ts, provider, model, json)
    VALUES (@id, @ts, @provider, @model, @json)
  `)
  const trim = handle.prepare(`
    DELETE FROM usage_entries WHERE id IN (
      SELECT id FROM usage_entries ORDER BY ts ASC LIMIT @overflow
    )
  `)
  const tx = handle.transaction(() => {
    insert.run({
      id: entry.id,
      ts: entry.ts,
      provider: entry.provider,
      model: entry.model,
      json: JSON.stringify(entry)
    })
    const count = (
      handle.prepare(`SELECT COUNT(*) AS c FROM usage_entries`).get() as {
        c: number
      }
    ).c
    if (count > MAX_ENTRIES) trim.run({ overflow: count - MAX_ENTRIES })
  })
  tx()
}

export function clearEntries(): void {
  ensureMigrated()
  db().prepare(`DELETE FROM usage_entries`).run()
}

export function getBudget(): UsageBudget {
  ensureMigrated()
  const budget = readBudgetRow()
  // Auto-reset the warned flags when the month rolls over.
  const now = currentMonth()
  if (budget.month !== now) {
    const reset: UsageBudget = {
      monthlyUsd: budget.monthlyUsd,
      warned75: false,
      warned90: false,
      warned100: false,
      month: now
    }
    writeBudgetRow(reset)
    return reset
  }
  return budget
}

export function setBudget(
  monthlyUsd: number | null,
  opts: { currency?: string; usdRate?: number } = {}
): UsageBudget {
  ensureMigrated()
  const current = getBudget()
  const next: UsageBudget = {
    monthlyUsd,
    warned75: false,
    warned90: false,
    warned100: false,
    month: current.month,
    // v1.12.0 — preserve currency/rate across budget updates unless
    // explicitly overridden. Falls back to USD identity when neither
    // current nor incoming value is set.
    currency: opts.currency ?? current.currency ?? 'USD',
    usdRate: opts.usdRate ?? current.usdRate ?? 1
  }
  writeBudgetRow(next)
  return next
}

/** Replaces every entry + the budget from a backup bundle, used by sync.ts. */
export function replaceUsage(entries: UsageEntry[], budget: UsageBudget | null): void {
  ensureMigrated()
  const handle = db()
  const tx = handle.transaction(() => {
    handle.prepare(`DELETE FROM usage_entries`).run()
    if (entries.length > 0) {
      const insert = handle.prepare(`
        INSERT OR REPLACE INTO usage_entries (id, ts, provider, model, json)
        VALUES (@id, @ts, @provider, @model, @json)
      `)
      for (const e of entries) {
        insert.run({
          id: e.id,
          ts: e.ts,
          provider: e.provider,
          model: e.model,
          json: JSON.stringify(e)
        })
      }
    }
    if (budget) writeBudgetRow(budget)
  })
  tx()
}

export function markWarned(level: 75 | 90 | 100): UsageBudget {
  ensureMigrated()
  const current = getBudget()
  const next: UsageBudget = {
    ...current,
    warned75: level === 75 ? true : current.warned75,
    warned90: level === 90 ? true : current.warned90,
    warned100: level === 100 ? true : current.warned100
  }
  writeBudgetRow(next)
  return next
}
