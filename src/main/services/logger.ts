/**
 * Activity log. Every meaningful event — AI calls, automation actions,
 * permission changes — is recorded here, persisted, and pushed live to the
 * renderer so the user always has a transparent audit trail.
 */
import { randomUUID } from 'node:crypto'
import { JsonStore } from './storage/store'
import { broadcast } from '../events'
import type { LogCategory, LogEntry, LogLevel } from '@shared/types'

const MAX_ENTRIES = 500

interface LogFile {
  entries: LogEntry[]
}

let cached: JsonStore<LogFile> | null = null
function store(): JsonStore<LogFile> {
  if (!cached) cached = new JsonStore<LogFile>('logs', { entries: [] })
  return cached
}

export function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  detail?: string
): LogEntry {
  const entry: LogEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level,
    category,
    message,
    detail
  }
  const entries = [...store().get().entries, entry].slice(-MAX_ENTRIES)
  store().set({ entries })
  broadcast('log:new', entry)
  return entry
}

export function getLogs(): LogEntry[] {
  return [...store().get().entries].reverse()
}

export function clearLogs(): void {
  store().replace({ entries: [] })
  broadcast('log:cleared')
}
