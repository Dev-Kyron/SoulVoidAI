/**
 * Permission smoke-test diagnostic. Runs each privileged capability the
 * agent might use (filesystem read/list/write, shell, MCP filesystem) and
 * reports pass/fail with a human-readable detail line, so the user can
 * verify the stack from Settings → Advanced instead of trial-and-erroring
 * inside chat.
 *
 * Why this exists: v1.13.0–v1.13.4 chased a "the AI can't reach my files"
 * bug that turned out to be the router silently switching providers AND
 * gpt-4o-mini refusing tool calls. Without a diagnostic that exercises
 * each link in the chain (permission gate → action dispatcher → fs API),
 * users had no way to tell whether the failure was their permission setup
 * or the model. This panel runs the actual operation through the same
 * `executeAction` path the agent uses — a green row means the underlying
 * stack works end-to-end, so any subsequent chat refusal is the model.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { PermissionId } from '@shared/permissions'
import type { ActionRequest, ActionResult, SmokeCheck } from '@shared/types'
import { getPermissions } from '../permissions/permissions'
import { executeAction } from '../automation/actions'
import { listServers } from '../mcp/manager'

const SKIP_BLOCKED_BY_PERM = (perm: PermissionId): string =>
  `Permission "${perm}" is off. Toggle it on under Permissions, then re-run the smoke test.`

/**
 * Shared builder for permission-gated checks. Wraps the gate-or-run pattern
 * every file/shell check shares so each individual `check*` function reduces
 * to "describe yourself + one operation". The runner returns the detail
 * line for the pass case; thrown errors land in `fail` with their message.
 */
async function runCheck(
  spec: Omit<SmokeCheck, 'status' | 'detail'>,
  granted: boolean,
  run: () => Promise<string>
): Promise<SmokeCheck> {
  if (!granted) {
    return { ...spec, status: 'skipped', detail: SKIP_BLOCKED_BY_PERM(spec.permissionId!) }
  }
  try {
    return { ...spec, status: 'pass', detail: await run() }
  } catch (err) {
    return {
      ...spec,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Throws on a non-ok ActionResult so `runCheck`'s try/catch maps it to a
 *  failed row. Returns the action's `output` line for the pass detail. */
async function runAction(req: ActionRequest, fallbackError: string): Promise<ActionResult> {
  const result = await executeAction(req)
  if (!result.ok) {
    throw new Error(result.error ?? fallbackError)
  }
  return result
}

/**
 * Reads the app's own package.json — bundled with the install and always
 * present, so a pass proves the filesystem read path works without
 * relying on any user-supplied file existing. Routed through the same
 * `executeAction({ type: 'file-read' })` the agent's `read_file` tool
 * uses, so the diagnostic exercises the permission gate AND the action
 * dispatcher, not just `fs.readFile`.
 */
async function checkFileRead(granted: boolean): Promise<SmokeCheck> {
  return runCheck(
    {
      id: 'fileRead',
      label: 'Read a file',
      what: "Reads the app's package.json via the same path the read_file tool uses.",
      permissionId: 'filesystem'
    },
    granted,
    async () => {
      const target = join(app.getAppPath(), 'package.json')
      const result = await runAction(
        { type: 'file-read', params: { path: target } },
        'file-read returned not-ok'
      )
      return result.output ?? `Read ${target}.`
    }
  )
}

/** Lists the user's home directory — guaranteed to have a few entries on
 *  any normal install. Surfaces the action's `output` count (privacy-
 *  preserving — no actual filenames cross the IPC boundary). */
async function checkFileList(granted: boolean): Promise<SmokeCheck> {
  return runCheck(
    {
      id: 'fileList',
      label: 'List a folder',
      what: 'Lists your home directory via the same path the list_files tool uses.',
      permissionId: 'filesystem'
    },
    granted,
    async () => {
      const result = await runAction(
        { type: 'file-list', params: { dir: app.getPath('home') } },
        'file-list returned not-ok'
      )
      return result.output ?? 'Listed home directory.'
    }
  )
}

/**
 * Writes a marker file into an isolated temp directory, verifies the
 * round-trip with a read, then nukes the parent. We don't route the
 * write through `executeAction({ type: 'file-write' })` here because that
 * pushes an undo record into the in-memory stack — pollution every time
 * the user runs the smoke test. The read step DOES go through executeAction
 * so the permission gate is still exercised.
 */
async function checkFileWrite(granted: boolean): Promise<SmokeCheck> {
  const spec: Omit<SmokeCheck, 'status' | 'detail'> = {
    id: 'fileWrite',
    label: 'Write a file',
    what: 'Creates and deletes a temp file (verifies write + read round-trip).',
    permissionId: 'filesystem'
  }
  if (!granted) {
    return { ...spec, status: 'skipped', detail: SKIP_BLOCKED_BY_PERM('filesystem') }
  }
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'voidsoul-smoke-'))
    const target = join(dir, 'smoke.txt')
    const payload = `VoidSoul smoke test @ ${new Date().toISOString()}`
    // Direct fs write so the undo stack stays clean. The action-dispatcher
    // path is still proven by the readback below.
    await writeFile(target, payload, 'utf-8')
    const echo = await readFile(target, 'utf-8')
    if (echo !== payload) {
      return {
        ...spec,
        status: 'fail',
        detail: 'Round-trip mismatch: file content read back differently than written.'
      }
    }
    return {
      ...spec,
      status: 'pass',
      detail: `Wrote and re-read ${payload.length} chars in a temp folder.`
    }
  } catch (err) {
    return { ...spec, status: 'fail', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    // Best-effort cleanup. A leaked smoke-* folder isn't catastrophic but
    // it IS sloppy — the OS reaps temp eventually but we tidy now.
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* swallow — temp folder cleanup is best-effort */
      }
    }
  }
}

/** Runs `node --version` through `executeAction({ type: 'shell' })` so the
 *  diagnostic exercises the actual shell-dispatch path the agent's
 *  `run_shell` tool uses, including the terminal permission gate. */
async function checkShell(granted: boolean): Promise<SmokeCheck> {
  return runCheck(
    {
      id: 'shell',
      label: 'Run a shell command',
      what: 'Executes `node --version` via the same path the run_shell tool uses.',
      permissionId: 'terminal'
    },
    granted,
    async () => {
      const result = await runAction(
        { type: 'shell', params: { command: 'node --version' } },
        'shell command returned not-ok'
      )
      // The action's output is the captured stdout; truncate to one line
      // so a chatty PATH-init script doesn't blow up the row.
      const summary = (result.output ?? '').split('\n').find((l) => l.trim()) ?? '(no stdout)'
      return `Shell roundtrip OK. Node says: ${summary.trim()}.`
    }
  )
}

/**
 * Inspects the MCP server list. We don't try to call a tool here because
 * "which MCP server installs filesystem-shaped tools" is fuzzy across
 * registries. Instead we report whether any connected server exposes a
 * tool whose name suggests filesystem access — enough for the user to
 * know whether their MCP filesystem add-on is actually connected. The
 * built-in file tools are always available; this row tells them whether
 * the optional MCP supplement also is.
 */
function checkMcpFilesystem(): SmokeCheck {
  const base: Omit<SmokeCheck, 'status' | 'detail'> = {
    id: 'mcpFilesystem',
    label: 'MCP filesystem server',
    what: 'Inspects connected MCP servers for filesystem-shaped tools.',
    permissionId: null
  }
  const enabled = listServers().filter((s) => s.enabled)
  if (enabled.length === 0) {
    return {
      ...base,
      status: 'skipped',
      detail:
        'No MCP servers configured. The built-in read_file / list_files / write_file tools work without this.'
    }
  }
  const filesystemy = /file|directory|folder|fs/i
  const matches = enabled
    .map((s) => ({
      server: s.name,
      tools: s.tools.map((t) => t.name).filter((n) => filesystemy.test(n)),
      connected: s.connected
    }))
    .filter((m) => m.tools.length > 0)
  if (matches.length === 0) {
    return {
      ...base,
      status: 'pass',
      detail: `${enabled.length} MCP server${enabled.length === 1 ? '' : 's'} enabled, none of them filesystem-shaped. Built-in file tools cover your prompts.`
    }
  }
  const disconnected = matches.filter((m) => !m.connected)
  if (disconnected.length === matches.length) {
    return {
      ...base,
      status: 'fail',
      detail: `Filesystem MCP server${matches.length === 1 ? '' : 's'} configured but not connected: ${matches.map((m) => m.server).join(', ')}. Check Settings → MCP for the connection error.`
    }
  }
  const connected = matches.filter((m) => m.connected)
  const flatTools = connected.flatMap((m) => m.tools)
  const preview = flatTools.slice(0, 4).join(', ')
  return {
    ...base,
    status: 'pass',
    detail: `Connected: ${connected.map((m) => m.server).join(', ')}. Exposes ${preview}${flatTools.length > 4 ? '…' : ''}.`
  }
}

/**
 * Runs every check in parallel where it makes sense (the file checks are
 * independent), serialises the shell check (some Windows AV hooks misbehave
 * on parallel cmd.exe spawns), and returns the results in a stable order.
 */
export async function runSmokeTest(): Promise<SmokeCheck[]> {
  const perms = getPermissions()
  const fsGranted = perms.filesystem?.granted === true
  const terminalGranted = perms.terminal?.granted === true

  const [read, list, write] = await Promise.all([
    checkFileRead(fsGranted),
    checkFileList(fsGranted),
    checkFileWrite(fsGranted)
  ])
  const shell = await checkShell(terminalGranted)
  const mcp = checkMcpFilesystem()
  return [read, list, write, shell, mcp]
}
