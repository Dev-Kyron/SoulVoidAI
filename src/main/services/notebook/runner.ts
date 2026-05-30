/**
 * Notebook cell runner. Executes one cell at a time; each cell type reuses
 * the same underlying capabilities as the chat surface:
 *
 *  - `prompt`   → `runCompletion` against the active provider
 *  - `python`   → `executeAction({ type: 'run-python', ... })`
 *  - `search`   → `executeAction({ type: 'web-search', ... })`
 *  - `markdown` → no execution, output = trimmed input
 *
 * Templating: any `{{cell-id}}` placeholder in a cell's input is replaced by
 * that prior cell's `output` before the cell runs. Lets the user chain
 * "search → summarise via prompt → run analysis as python" with one click.
 *
 * State persistence is the notebook's `cells[]` array — saving the notebook
 * captures every output, so reopening the app picks up where the user left.
 */
import { randomUUID } from 'node:crypto'
import { runCompletion } from '../ai'
import { executeAction } from '../automation/actions'
import { getConfig } from '../storage/config'
import { hasApiKey } from '../storage/keys'
import { PROVIDER_META } from '../ai/types'
import { log } from '../logger'
import { getNotebook, saveNotebook } from './store'
import type { ChatRequest, Notebook, NotebookCell, NotebookCellKind } from '@shared/types'

/**
 * Replace `{{cell-N}}` (1-based ordinal) and `{{cell-<uuid>}}` placeholders
 * in `input` with the matching cell's `output`. Ordinals are what users
 * type — UUID form is supported for completeness so renamed/reordered cells
 * referenced from frontmatter or pasted snippets still resolve.
 *
 * Unknown references stay verbatim so the dangling lookup is visible rather
 * than silently dropped.
 */
function substituteReferences(input: string, priorCells: NotebookCell[]): string {
  return input.replace(/\{\{cell-([^}]+)\}\}/g, (match, token: string) => {
    const ordinal = Number(token)
    if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= priorCells.length) {
      return priorCells[ordinal - 1].output
    }
    const byId = priorCells.find((c) => c.id === token)
    return byId ? byId.output : match
  })
}

/** Runs one cell type and returns just its text output. */
async function executeKind(kind: NotebookCellKind, resolvedInput: string): Promise<string> {
  if (kind === 'markdown') {
    return resolvedInput.trim()
  }

  if (kind === 'prompt') {
    const config = getConfig()
    const providerId = config.activeProvider
    const provider = config.providers[providerId]
    if (PROVIDER_META[providerId].needsKey && !hasApiKey(providerId)) {
      throw new Error(`${PROVIDER_META[providerId].label} has no API key — set one in Settings.`)
    }
    const req: ChatRequest = {
      requestId: randomUUID(),
      provider: providerId,
      model: provider.model,
      system: config.systemPrompt,
      messages: [{ role: 'user', content: resolvedInput }],
      temperature: 0.4
    }
    const controller = new AbortController()
    const result = await runCompletion(
      req,
      () => {
        /* notebook runs are non-streaming */
      },
      controller.signal
    )
    if (result.error) throw new Error(result.error)
    return result.text
  }

  if (kind === 'python') {
    const result = await executeAction({
      type: 'run-python',
      params: { code: resolvedInput }
    })
    if (!result.ok) throw new Error(result.error ?? 'Python execution failed.')
    return result.output ?? ''
  }

  if (kind === 'search') {
    const result = await executeAction({
      type: 'web-search',
      params: { query: resolvedInput, max_results: 5 }
    })
    if (!result.ok) throw new Error(result.error ?? 'Web search failed.')
    return result.output ?? ''
  }

  throw new Error(`Unknown cell kind: ${kind as string}`)
}

/**
 * Runs a single cell in a notebook, persists the updated cell, returns the
 * full notebook. Errors are captured on the cell rather than thrown so the
 * UI can render them inline.
 */
export async function runCell(notebookId: string, cellId: string): Promise<Notebook | null> {
  const notebook = getNotebook(notebookId)
  if (!notebook) return null
  const cellIdx = notebook.cells.findIndex((c) => c.id === cellId)
  if (cellIdx < 0) return notebook

  const priorCells = notebook.cells.slice(0, cellIdx)
  const cell = notebook.cells[cellIdx]
  const resolvedInput = substituteReferences(cell.input, priorCells)
  const startedAt = Date.now()
  const now = new Date().toISOString()

  let updated: NotebookCell
  try {
    const output = await executeKind(cell.kind, resolvedInput)
    updated = {
      ...cell,
      output,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      error: undefined,
      ranAt: now
    }
    log('success', 'system', `Notebook cell "${cell.kind}" ran in ${updated.durationMs}ms.`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updated = {
      ...cell,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: message,
      ranAt: now
    }
    log('warn', 'system', `Notebook cell "${cell.kind}" failed: ${message}`)
  }

  const nextCells = [...notebook.cells]
  nextCells[cellIdx] = updated
  return saveNotebook({ ...notebook, cells: nextCells })
}

/**
 * Runs every cell in order, stopping at the first error. Returns the final
 * notebook state regardless of whether a cell failed mid-run.
 */
export async function runAll(notebookId: string): Promise<Notebook | null> {
  let notebook = getNotebook(notebookId)
  if (!notebook) return null
  for (const cell of notebook.cells) {
    notebook = (await runCell(notebookId, cell.id)) ?? notebook
    const fresh = notebook.cells.find((c) => c.id === cell.id)
    if (fresh?.status === 'error') break
  }
  return notebook
}
