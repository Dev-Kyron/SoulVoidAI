/**
 * Modular automation engine. Every action is permission-gated, logged, and —
 * where it makes sense — reversible. Actions never run unless the matching
 * permission has been granted; a blocked action returns `needsPermission` so
 * the renderer can prompt the user explicitly.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, basename, extname, dirname } from 'node:path'
import { app, shell } from 'electron'
import { assertGranted, PermissionDeniedError } from '../permissions/permissions'
import { log } from '../logger'
import { captureScreen } from '../screen/screenshot'
import { extractText } from '../screen/ocr'
import { moveMouse, mouseClick, sendHotkey } from './input'
import { performVisualClick } from './visualClick'
import { rememberProject } from '../storage/memory'
import { getApiKey, getSecret } from '../storage/keys'
import { getConfig, resolveBaseUrl } from '../storage/config'
import { dataPath } from '../storage/store'
import { renderContent, promptSaveAndWrite, type ThreadExportFormat } from '../export/thread'
import { recordUsage } from '../usage'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extractFromHtml } from './readability'
import { runWebSearch } from './search'
import {
  callHomeAssistantService,
  getHomeAssistantState,
  listHomeAssistantStates
} from './homeassistant'
import { runDeepResearch } from './deepResearch'
import { checkUrlSafe } from './urlSafety'
import { ENDPOINTS } from './endpoints'
import { execInThread as runPersistentPython } from '../python-sandbox/manager'
import { PYTHON_CMD } from '../python-sandbox/kernel'
import type { ActionDescriptor, ActionRequest, ActionResult } from '@shared/types'

/**
 * Bounds the user-supplied (or model-supplied) timeout to a sane window.
 * 30s default keeps interactive cells snappy; 2-minute ceiling protects
 * against a runaway model that asks for an hour. Both `run-python`
 * branches (persistent + ephemeral) call this so a tweak to the policy
 * lands in one place.
 */
function normalizePythonTimeoutMs(raw: unknown): number {
  return Math.min(Number(raw ?? 30000), 120_000)
}

const execAsync = promisify(exec)
const MAX_READ_CHARS = 200_000

/**
 * v2.0 — shared image saver for the generate-image + edit-image-* actions.
 * Writes PNG bytes to `<dataDir>/generated-images/<prefix>-<ts>.png` and
 * returns both the path (for chat references) and a data URL (for inline
 * preview). Lives at module scope so all four image actions reuse one
 * implementation — the previous inline copy in generate-image's case was
 * fine when it was alone, but four copies of the same five lines would be
 * the worst kind of drift bait.
 */
async function saveImagePng(
  b64: string,
  prefix: string
): Promise<{ path: string; dataUrl: string }> {
  const dir = dataPath('generated-images')
  await mkdir(dir, { recursive: true })
  const filename = `${prefix}-${Date.now()}.png`
  const filepath = join(dir, filename)
  await writeFile(filepath, Buffer.from(b64, 'base64'))
  return { path: filepath, dataUrl: `data:image/png;base64,${b64}` }
}

export const ACTION_DESCRIPTORS: ActionDescriptor[] = [
  {
    type: 'open-app',
    label: 'Open Application',
    description: 'Launch an application by name or path.',
    requires: 'appControl',
    reversible: false
  },
  {
    type: 'open-url',
    label: 'Open URL',
    description: 'Open a link in the default browser.',
    requires: 'browser',
    reversible: false
  },
  {
    type: 'open-folder',
    label: 'Open Folder',
    description: 'Reveal a folder in the file explorer.',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'shell',
    label: 'Run Shell Command',
    description: 'Execute a command in the system shell.',
    requires: 'terminal',
    reversible: false
  },
  {
    type: 'file-list',
    label: 'List Files',
    description: 'List the contents of a directory.',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'file-read',
    label: 'Read File',
    description: 'Read a UTF-8 text file.',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'file-write',
    label: 'Write File',
    description: 'Write text to a file (the previous contents are kept for undo).',
    requires: 'filesystem',
    reversible: true
  },
  {
    type: 'organize-folder',
    label: 'Organise Folder',
    description: 'Sort a folder into typed sub-folders.',
    requires: 'filesystem',
    reversible: true
  },
  // v2.0 round-8 multi-platform — input-driving actions (type, hotkey,
  // mouse, visual-click) currently only have a Windows implementation in
  // src/main/services/automation/input.ts. The `platforms: ['win32']`
  // tag lets executeAction() reject cross-platform calls up front with a
  // clear "Not supported on darwin/linux" error, instead of letting the
  // agent retry into opaque "PowerShell SendKeys failed" stderr.
  {
    type: 'type-text',
    label: 'Type Text',
    description: 'Send keystrokes to the focused window.',
    requires: 'inputAccess',
    reversible: false,
    platforms: ['win32']
  },
  {
    type: 'hotkey',
    label: 'Send Hotkey',
    description: 'Send a keyboard shortcut (e.g. ctrl+s) to the focused window.',
    requires: 'inputAccess',
    reversible: false,
    platforms: ['win32']
  },
  {
    type: 'move-mouse',
    label: 'Move Cursor',
    description: 'Move the mouse cursor to screen coordinates.',
    requires: 'inputAccess',
    reversible: false,
    platforms: ['win32']
  },
  {
    type: 'mouse-click',
    label: 'Mouse Click',
    description: 'Perform a left or right mouse click.',
    requires: 'inputAccess',
    reversible: false,
    platforms: ['win32']
  },
  {
    type: 'visual-click',
    label: 'Click on Screen',
    // Permission gate is `inputAccess` (the actual click); the visual-click
    // dispatcher also calls screen capture but we surface that as a friendly
    // sub-check inside the orchestrator with its own error instead of
    // requiring TWO permission prompts up front. That keeps the descriptor
    // honest (one permission per action) and gives the user a clearer error
    // path if only screenCapture is missing.
    description:
      'Click a UI element described in plain English. Vision model finds it; a 3s preview HUD lets the user cancel.',
    requires: 'inputAccess',
    reversible: false,
    platforms: ['win32']
  },
  {
    type: 'screenshot',
    label: 'Capture Screenshot',
    description: 'Capture the primary display.',
    requires: 'screenCapture',
    reversible: false
  },
  {
    type: 'read-screen',
    label: 'Read Screen Text',
    description: 'Capture the screen and extract its text via OCR.',
    requires: 'screenCapture',
    reversible: false
  },
  {
    type: 'web-search',
    label: 'Web Search',
    description: 'Search the live web for a query (DuckDuckGo by default; Tavily if configured).',
    requires: 'browser',
    reversible: false
  },
  {
    type: 'web-fetch',
    label: 'Fetch Web Page',
    description: 'Download a specific URL and extract its readable main content.',
    requires: 'browser',
    reversible: false
  },
  {
    type: 'deep-research',
    label: 'Deep Research',
    description:
      'Plan sub-queries, search the web, fetch top sources, and synthesise a cited markdown answer.',
    // v2.0 — gated on browser permission for the same reasons web-search +
    // web-fetch are: every internal step hits the network. Reuses those
    // primitives, so a user who granted browser for the simple search/fetch
    // pair has already opted into this tool's network surface.
    requires: 'browser',
    reversible: false
  },
  {
    type: 'generate-image',
    label: 'Generate Image',
    description: 'Generate an image from a text prompt (OpenAI DALL·E 3).',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'edit-image-inpaint',
    label: 'Inpaint Image',
    description:
      'Replace a masked region of an existing image with content described by a prompt (Stability AI).',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'edit-image-upscale',
    label: 'Upscale Image',
    description: 'Upscale an image while preserving detail (Stability AI conservative upscaler).',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'edit-image-bg-remove',
    label: 'Remove Background',
    description:
      'Cut out the foreground subject and return a transparent-background PNG (Stability AI).',
    requires: 'filesystem',
    reversible: false
  },
  {
    type: 'run-python',
    label: 'Run Python',
    description: 'Execute Python in an isolated temp dir using the system interpreter.',
    requires: 'terminal',
    reversible: false
  },
  {
    type: 'save-document',
    label: 'Save Document',
    description:
      'Save AI-generated content as a downloadable document (DOCX, PDF, XLSX, MD, TXT, HTML).',
    // No permission gate — the user explicitly picks the destination via
    // the OS save dialog, which is the consent grant. Requiring filesystem
    // permission would block users who turned it off but still want to
    // save the document they just asked the assistant to write.
    requires: null,
    reversible: false
  },
  /* ------------- v2.0 Home Assistant integration ------------- */
  {
    type: 'ha-list-entities',
    label: 'List HA Entities',
    description:
      'List Home Assistant entities (lights, locks, climate, etc), optionally by domain.',
    requires: 'homeAssistant',
    reversible: false
  },
  {
    type: 'ha-get-state',
    label: 'Read HA Entity',
    description: 'Read the current state and attributes of one HA entity.',
    requires: 'homeAssistant',
    reversible: false
  },
  {
    type: 'ha-call-service',
    label: 'Call HA Service',
    description:
      'Call a Home Assistant service (turn_on/off, lock/unlock, set_temperature, scene, script, etc).',
    requires: 'homeAssistant',
    reversible: false
  }
]

/* ------------------------------ undo registry --------------------------- */

interface UndoEntry {
  label: string
  run: () => Promise<void>
}

const undoRegistry = new Map<string, UndoEntry>()

function registerUndo(
  label: string,
  run: () => Promise<void>
): {
  undoId: string
  undoLabel: string
} {
  const undoId = randomUUID()
  undoRegistry.set(undoId, { label, run })
  if (undoRegistry.size > 50) {
    const oldest = undoRegistry.keys().next().value
    if (oldest) undoRegistry.delete(oldest)
  }
  return { undoId, undoLabel: label }
}

export async function undoAction(undoId: string): Promise<{ ok: boolean; message: string }> {
  const entry = undoRegistry.get(undoId)
  if (!entry) {
    return { ok: false, message: 'Nothing to undo — the action may have expired.' }
  }
  try {
    await entry.run()
    undoRegistry.delete(undoId)
    log('success', 'automation', `Undid: ${entry.label}`)
    return { ok: true, message: `Undid: ${entry.label}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('error', 'automation', `Undo failed: ${entry.label}`, message)
    return { ok: false, message }
  }
}

/* ------------------------------ utilities ------------------------------- */

function param(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required parameter: "${key}".`)
  }
  return value
}

function optParam(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) {
    throw new Error(`Missing or invalid numeric parameter: "${key}".`)
  }
  return parsed
}

/** Resolves `~`-prefixed location tokens (e.g. `~downloads`) to real paths. */
function resolvePath(input: string): string {
  const tokens: Record<string, string> = {
    '~home': app.getPath('home'),
    '~downloads': app.getPath('downloads'),
    '~desktop': app.getPath('desktop'),
    '~documents': app.getPath('documents'),
    '~videos': app.getPath('videos'),
    '~pictures': app.getPath('pictures'),
    '~music': app.getPath('music')
  }
  if (tokens[input]) return tokens[input]
  for (const [token, value] of Object.entries(tokens)) {
    if (input.startsWith(`${token}/`) || input.startsWith(`${token}\\`)) {
      return join(value, input.slice(token.length + 1))
    }
  }
  return input
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '')
}

/* ----------------------------- app launching ---------------------------- */

interface AppSpec {
  target: string
  cwd?: string
  args?: string
}

function resolveApp(key: string): AppSpec {
  // v2.0 round-7 multi-platform — the known-app shortcuts now branch on
  // platform. The previous version returned Windows-only paths/binaries
  // (obs64.exe, %LOCALAPPDATA%\Discord\Update.exe, wt) regardless of
  // platform; the mac/linux branches of launchApp then fed those into
  // `open -a` / `xdg-open` which fail (the bare filename + Windows path
  // isn't a mac bundle name). Now each shortcut resolves to the
  // platform-appropriate identifier.
  const platform = process.platform
  switch (key.toLowerCase()) {
    case 'vscode':
    case 'code':
      // VS Code's CLI is `code` on every platform when its `Install 'code'
      // command in PATH` step has run (default on Windows + mac post-install).
      return { target: 'code' }
    case 'terminal':
      if (platform === 'darwin') return { target: 'Terminal' }
      if (platform === 'win32') return { target: 'wt' }
      // Linux: try gnome-terminal first; xdg-open will fall back gracefully.
      return { target: 'gnome-terminal' }
    case 'obs':
      if (platform === 'darwin') return { target: 'OBS' }
      if (platform === 'win32') {
        return { target: 'obs64.exe', cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit' }
      }
      return { target: 'obs' }
    case 'discord':
      if (platform === 'darwin') return { target: 'Discord' }
      if (platform === 'win32') {
        return {
          target: expandEnv('%LOCALAPPDATA%\\Discord\\Update.exe'),
          args: '--processStart Discord.exe'
        }
      }
      // Linux: snap/flatpak/distro packages all expose `discord` in PATH.
      return { target: 'discord' }
    default:
      return { target: key }
  }
}

// v2.0 round-3 security polish — whitelist for the open-app `key` arg.
// resolveApp's `default` branch passes the model-supplied key straight
// through to the shell command on Windows, where the surrounding `"..."`
// can be broken with a `"` byte (or `&`, `|`, `;` in args). Restricting
// the key to a benign character class makes injection structurally
// impossible without rejecting legitimate apps (executable names, app
// IDs, file paths with spaces all match this).
const APP_KEY_OK = /^[A-Za-z0-9 ._\-:\\/]+$/
const REJECT_APP_KEY_HINT =
  'The application name must contain only letters, digits, spaces, and the characters . _ - : / \\'

async function launchApp(key: string): Promise<string> {
  const spec = resolveApp(key)
  // v2.0 round-3 — sanity-check the resolved target. Hardcoded specs
  // (vscode, terminal, obs, discord) bypass since their target is a
  // trusted constant; the default-branch fall-through is where the
  // injection risk lives.
  if (!APP_KEY_OK.test(spec.target)) {
    throw new Error(`Refusing to launch app — invalid characters. ${REJECT_APP_KEY_HINT}`)
  }

  if (process.platform === 'darwin') {
    await execAsync(`open -a ${JSON.stringify(spec.target)}`)
    return `Launched ${key}.`
  }
  if (process.platform === 'linux') {
    await execAsync(`xdg-open ${JSON.stringify(spec.target)}`)
    return `Launched ${key}.`
  }

  const cwdPart = spec.cwd ? `/d "${spec.cwd}" ` : ''
  const argsPart = spec.args ? ` ${spec.args}` : ''
  try {
    await execAsync(`start "VoidSoul" ${cwdPart}"${spec.target}"${argsPart}`, {
      shell: 'cmd.exe',
      windowsHide: true
    })
    return `Launched ${key}.`
  } catch (err) {
    if (key.toLowerCase() === 'terminal') {
      await execAsync('start "VoidSoul" "powershell.exe"', { shell: 'cmd.exe' })
      return 'Launched terminal (PowerShell).'
    }
    throw err
  }
}

/* ------------------------------- shell ---------------------------------- */

async function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd ? resolvePath(cwd) : app.getPath('home'),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      // Node 15+ honours `signal` on child_process options — abort sends
      // SIGTERM to the child, which is what we want when the user clicks
      // Stop mid-shell-command.
      signal,
      windowsHide: true
    })
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(command produced no output)'
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
    throw new Error(output || e.message || 'Command failed.')
  }
}

/* ------------------------------ keystrokes ------------------------------ */

function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * v1.12.3 — cap on a single `type-text` invocation. SendKeys runs on the
 * UI thread of whatever window has focus; pushing megabytes of text
 * through it would block that app's input loop for tens of seconds and
 * also include any errant Enter / Tab keystrokes the model may have
 * accidentally generated. 4096 chars is plenty for any legitimate paste
 * (≈800 words) and small enough to fail fast on a hostile or runaway
 * agent.
 */
const TYPE_TEXT_MAX_CHARS = 4096

/**
 * v1.12.3 — serialise typeText calls so two parallel invocations don't
 * spawn two PowerShell processes that interleave keystrokes into the
 * focused window. Each PS spawn is ~150-300ms; without a mutex, a tight
 * agent loop calling type-text twice in close succession would produce
 * scrambled output (chunk A's first half + chunk B's first half + chunk
 * A's tail + ...). Tools are sequential in the agent loop today (see
 * useChatStore), but defensive code is cheap.
 */
let typeTextChain: Promise<void> = Promise.resolve()

async function typeText(text: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Keystroke automation is currently implemented for Windows only.')
  }
  if (text.length > TYPE_TEXT_MAX_CHARS) {
    throw new Error(
      `type-text input exceeds the ${TYPE_TEXT_MAX_CHARS}-character cap (got ${text.length}). ` +
        `Split into smaller chunks or write to a file and open it instead.`
    )
  }
  // Wait for any prior typeText to finish before spawning a new PS process.
  // .catch on the chain so one failure doesn't poison subsequent calls.
  const prior = typeTextChain
  let resolveNext: () => void = () => {}
  typeTextChain = new Promise<void>((res) => {
    resolveNext = res
  })
  try {
    await prior.catch(() => {
      /* swallow — prior call's error already reached its own caller */
    })
    const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''")
    const script =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      'Start-Sleep -Milliseconds 400; ' +
      `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`
    // v1.12.5 — 30s timeout. Previously a hung PowerShell process (OS
    // resource starvation, a focused window that swallows input
    // forever, etc.) would block the type-text mutex indefinitely; every
    // subsequent type-text call would queue behind it with no escape.
    // 30s is generous for typing 4096 chars (~40 chars/sec is human-
    // slow) and short enough that a genuinely stuck call surfaces
    // before the user gives up.
    await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(script)}`, {
      windowsHide: true,
      timeout: 30_000
    })
  } finally {
    resolveNext()
  }
}

/* --------------------------- folder organising -------------------------- */

const FILE_CATEGORIES: Record<string, string[]> = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'heic'],
  Videos: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  Documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz'],
  Installers: ['exe', 'msi', 'dmg', 'pkg', 'appimage'],
  Code: ['js', 'ts', 'tsx', 'py', 'json', 'html', 'css', 'cpp', 'cs', 'rs', 'go', 'sh']
}

function categoryFor(ext: string): string {
  const clean = ext.replace('.', '').toLowerCase()
  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if (extensions.includes(clean)) return category
  }
  return 'Other'
}

async function organizeFolder(dirInput: string): Promise<ActionResult> {
  const dir = resolvePath(dirInput)
  const entries = await readdir(dir, { withFileTypes: true })
  const moves: Array<{ from: string; to: string }> = []
  const categories = new Set<string>()

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const category = categoryFor(extname(entry.name))
    const categoryDir = join(dir, category)
    await mkdir(categoryDir, { recursive: true })

    const from = join(dir, entry.name)
    let to = join(categoryDir, entry.name)
    let counter = 1
    while (await pathExists(to)) {
      const ext = extname(entry.name)
      to = join(categoryDir, `${basename(entry.name, ext)} (${counter++})${ext}`)
    }
    await rename(from, to)
    moves.push({ from, to })
    categories.add(category)
  }

  if (moves.length === 0) {
    return {
      ok: true,
      type: 'organize-folder',
      output: 'Nothing to organise — no loose files found.'
    }
  }

  const undo = registerUndo(`Organise of ${basename(dir)}`, async () => {
    for (const move of [...moves].reverse()) {
      try {
        await rename(move.to, move.from)
      } catch {
        // File moved/removed since — skip it.
      }
    }
  })

  return {
    ok: true,
    type: 'organize-folder',
    output: `Organised ${moves.length} file(s) into ${categories.size} folder(s): ${[...categories].join(', ')}.`,
    data: { moved: moves.length, categories: [...categories] },
    ...undo
  }
}

async function writeTextFile(file: string, content: string): Promise<ActionResult> {
  let previous: string | null = null
  try {
    previous = await readFile(file, 'utf-8')
  } catch {
    previous = null
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf-8')

  const undo = registerUndo(`Write to ${basename(file)}`, async () => {
    if (previous === null) await rm(file, { force: true })
    else await writeFile(file, previous, 'utf-8')
  })

  return {
    ok: true,
    type: 'file-write',
    output: `Wrote ${content.length} character(s) to ${file}.`,
    ...undo
  }
}

/* ------------------------------ dispatch -------------------------------- */

/** Common UA + accept-header pair shared by every web-fetch hop. */
const WEB_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (VoidSoul AI Companion) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
} as const

/**
 * Follows up to 5 redirect hops manually, re-checking each Location against
 * the SSRF guard so an open redirect on a public host can't bounce us into
 * a private IP. Returns either `{ response }` with the terminal response or
 * `{ blocked }` with a reason if a hop was refused — the caller surfaces
 * the latter as the action's error.
 */
async function followRedirects(
  initial: Response,
  originalUrl: string,
  signal?: AbortSignal
): Promise<{ response: Response } | { blocked: string }> {
  if (initial.status < 300 || initial.status >= 400) {
    return { response: initial }
  }
  let next = initial.headers.get('location')
  let hops = 0
  let current: Response = initial
  // v1.12.1 — single shared deadline across all redirect hops. Previously
  // each hop got its own 15s timer, so a chain of 5 redirects could block
  // for up to 75s before the caller's signal could fire. Now the budget
  // is capped at 30s for the whole chain regardless of hop count.
  const chainDeadline = Date.now() + 30_000
  while (next && hops < 5) {
    const nextUrl = new URL(next, current.url || originalUrl)
    const safety = checkUrlSafe(nextUrl)
    if (!safety.ok) {
      return { blocked: `Redirect blocked: ${safety.reason}` }
    }
    const remaining = chainDeadline - Date.now()
    if (remaining <= 0) {
      return { blocked: 'Redirect chain exceeded 30s total budget' }
    }
    const hopCtrl = new AbortController()
    const hopTimer = setTimeout(() => hopCtrl.abort(), remaining)
    const hopAbort = (): void => hopCtrl.abort()
    signal?.addEventListener('abort', hopAbort)
    current = await fetch(nextUrl.toString(), {
      signal: hopCtrl.signal,
      redirect: 'manual',
      headers: WEB_FETCH_HEADERS
    }).finally(() => {
      clearTimeout(hopTimer)
      signal?.removeEventListener('abort', hopAbort)
    })
    if (current.status < 300 || current.status >= 400) break
    next = current.headers.get('location')
    hops++
  }
  return { response: current }
}

async function dispatch(req: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
  const p = req.params

  switch (req.type) {
    case 'open-app':
      return { ok: true, type: req.type, output: await launchApp(param(p, 'app')) }

    case 'open-url': {
      const url = param(p, 'url')
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed.')
      await shell.openExternal(url)
      return { ok: true, type: req.type, output: `Opened ${url}` }
    }

    case 'open-folder': {
      const dir = resolvePath(param(p, 'dir'))
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
      rememberProject(dir)
      return { ok: true, type: req.type, output: `Opened ${dir}` }
    }

    case 'shell': {
      const output = await runShell(param(p, 'command'), optParam(p, 'cwd'), signal)
      return { ok: true, type: req.type, output }
    }

    case 'file-list': {
      const dir = resolvePath(param(p, 'dir'))
      const entries = await readdir(dir, { withFileTypes: true })
      const data = entries.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? 'dir' : 'file'
      }))
      return { ok: true, type: req.type, output: `${data.length} item(s) in ${dir}`, data }
    }

    case 'file-read': {
      const file = resolvePath(param(p, 'path'))
      let text = await readFile(file, 'utf-8')
      const truncated = text.length > MAX_READ_CHARS
      if (truncated) text = `${text.slice(0, MAX_READ_CHARS)}\n…(truncated)`
      return {
        ok: true,
        type: req.type,
        output: `Read ${file} (${text.length} chars${truncated ? ', truncated' : ''})`,
        data: { text }
      }
    }

    case 'file-write':
      return writeTextFile(resolvePath(param(p, 'path')), optParam(p, 'content'))

    case 'organize-folder':
      return organizeFolder(param(p, 'dir'))

    case 'type-text': {
      const text = param(p, 'text')
      await typeText(text)
      return { ok: true, type: req.type, output: `Typed ${text.length} character(s).` }
    }

    case 'hotkey': {
      const combo = param(p, 'keys')
      await sendHotkey(combo)
      return { ok: true, type: req.type, output: `Sent hotkey: ${combo}` }
    }

    case 'move-mouse': {
      const x = numberParam(p, 'x')
      const y = numberParam(p, 'y')
      await moveMouse(x, y)
      return {
        ok: true,
        type: req.type,
        output: `Moved cursor to ${Math.round(x)}, ${Math.round(y)}.`
      }
    }

    case 'mouse-click': {
      const button = optParam(p, 'button') === 'right' ? 'right' : 'left'
      await mouseClick(button)
      return {
        ok: true,
        type: req.type,
        output: `${button === 'right' ? 'Right' : 'Left'} mouse click.`
      }
    }

    case 'visual-click': {
      // visual-click handles its own permission feedback for screenCapture
      // and threads the request-wide abort signal into the vision call so
      // Stop in chat halts the LLM mid-locate. Returns a full ActionResult.
      // v1.10.0 — passes in_window through when supplied; the orchestrator
      // enumerates windows, focuses the matched one, and scopes UIA +
      // screenshot to it.
      const button = optParam(p, 'button') === 'right' ? 'right' : 'left'
      const rawInWindow = optParam(p, 'in_window')
      const inWindow = rawInWindow.trim() || null
      return performVisualClick({
        what: param(p, 'what'),
        button,
        inWindow,
        signal
      })
    }

    case 'screenshot': {
      const shot = await captureScreen()
      return {
        ok: true,
        type: req.type,
        output: `Captured a ${shot.width}×${shot.height} screenshot.`,
        data: shot
      }
    }

    case 'read-screen': {
      const shot = await captureScreen()
      const ocr = await extractText(shot.path)
      return {
        ok: true,
        type: req.type,
        output: `Read ${ocr.text.length} character(s) from screen (${ocr.confidence}% confidence).`,
        data: { text: ocr.text, confidence: ocr.confidence, ...shot }
      }
    }

    case 'web-search': {
      const query = String(p.query ?? '').trim()
      if (!query) return { ok: false, type: req.type, error: 'No query supplied.' }
      const maxResults = Math.min(Number(p.max_results ?? 5), 10)
      // Tavily if the user has paid the key tax for it; otherwise DuckDuckGo
      // so the tool works out of the box. Same return shape either way.
      const key = getSecret('tavily')
      try {
        const data = await runWebSearch(query, maxResults, key, signal)
        const blocks: string[] = []
        if (data.answer) blocks.push(`Quick answer: ${data.answer}`)
        for (const r of data.results) {
          blocks.push(`• ${r.title}\n  ${r.url}\n  ${r.snippet}`)
        }
        const output = blocks.join('\n\n').slice(0, 8000) || '(no results)'
        log(
          'info',
          'system',
          `web_search via ${data.source}: "${query}" → ${data.results.length} result(s)`
        )
        return { ok: true, type: req.type, output, data }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : 'Search error.'
        }
      }
    }

    case 'web-fetch': {
      const url = String(p.url ?? '').trim()
      if (!url) return { ok: false, type: req.type, error: 'No URL supplied.' }
      // SSRF guard — block agent-driven fetches to private/loopback/link-
      // local addresses (router admin, cloud metadata, localhost services).
      // Covers scheme allowlist too so we don't need a separate check.
      const safety = checkUrlSafe(url)
      if (!safety.ok) {
        return { ok: false, type: req.type, error: safety.reason ?? 'Unsafe URL.' }
      }
      try {
        // Compose two abort sources: our own 15s safety timeout AND the
        // caller's request-wide signal (so Stop in the chat cancels the
        // download mid-flight). Whichever fires first wins.
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        const onUpstreamAbort = (): void => controller.abort()
        signal?.addEventListener('abort', onUpstreamAbort)
        const res = await fetch(url, {
          signal: controller.signal,
          // `redirect: 'manual'` so we can re-check each hop ourselves —
          // an open redirect on a public host could otherwise bounce us
          // straight into a private IP, defeating the guard above.
          redirect: 'manual',
          headers: WEB_FETCH_HEADERS
        }).finally(() => {
          clearTimeout(timeout)
          signal?.removeEventListener('abort', onUpstreamAbort)
        })
        // Manual redirect handling: follow up to 5 hops, re-checking safety
        // on each Location header. Returns the terminal response — or a
        // safety-violation result that the caller bubbles directly.
        const followed = await followRedirects(res, url, signal)
        if ('blocked' in followed) {
          return { ok: false, type: req.type, error: followed.blocked }
        }
        const finalRes = followed.response
        if (!finalRes.ok) {
          return {
            ok: false,
            type: req.type,
            error: `Fetch failed: ${finalRes.status} ${finalRes.statusText}`
          }
        }
        const contentType = finalRes.headers.get('content-type') ?? ''
        const text = await finalRes.text()
        // For plain-text / markdown / JSON, skip the HTML pipeline.
        if (
          !contentType.includes('html') &&
          (contentType.includes('text/') || contentType.includes('json'))
        ) {
          const truncated = text.length > 32_000
          const body = truncated ? `${text.slice(0, 32_000)}\n\n[…content truncated…]` : text
          return {
            ok: true,
            type: req.type,
            output: `Fetched ${url} (${contentType}, ${body.length} chars)\n\n${body}`,
            data: { url, title: '', text: body, truncated, contentType }
          }
        }
        const extracted = extractFromHtml(text, url)
        const header = extracted.title ? `# ${extracted.title}\n${url}\n\n` : `${url}\n\n`
        return {
          ok: true,
          type: req.type,
          output: `${header}${extracted.text}`,
          data: { ...extracted, contentType }
        }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : 'Web fetch failed.'
        }
      }
    }

    case 'deep-research': {
      // v2.0 — Perplexity-style multi-step research. Plans sub-queries
      // via the active LLM, runs them via the same search backend as
      // web-search, fetches top results, synthesises a cited markdown
      // answer. The whole pipeline runs in one tool-call from the
      // agent's perspective; internal steps log to the structured log
      // store for debugging but don't surface as separate tool cards.
      const topic = String(p.topic ?? '').trim()
      if (!topic) return { ok: false, type: req.type, error: 'No research topic supplied.' }
      const rawDepth = String(p.depth ?? 'standard').toLowerCase()
      const depth: 'quick' | 'standard' | 'deep' =
        rawDepth === 'quick' || rawDepth === 'deep' ? rawDepth : 'standard'
      return runDeepResearch({ topic, depth, signal })
    }

    case 'generate-image': {
      const prompt = String(p.prompt ?? '').trim()
      if (!prompt) return { ok: false, type: req.type, error: 'No prompt supplied.' }
      const requested = String(p.provider ?? 'auto').toLowerCase()
      const size = String(p.size ?? '1024x1024')

      // "auto" picks the best backend the user has set up — Stability first
      // (best quality), then DALL-E, then Imagen, then Pollinations as the
      // keyless safety net. So image gen always works, even with zero keys.
      const provider = (() => {
        if (requested !== 'auto') return requested
        if (getSecret('stability')) return 'stability'
        if (getApiKey('openai')) return 'openai'
        if (getApiKey('gemini')) return 'gemini'
        return 'pollinations'
      })()

      // Inline alias kept so the body below reads identically to the v1.13
      // shape — the function moved to module scope as `saveImagePng` so
      // the v2.0 image-editing actions can reuse it.
      const saveImage = saveImagePng

      try {
        if (provider === 'stability' || provider === 'sdxl') {
          const key = getSecret('stability')
          if (!key) {
            return {
              ok: false,
              type: req.type,
              error:
                'Stability AI key not configured. Settings → Integrations → paste a key from platform.stability.ai.'
            }
          }
          // Stable Diffusion 3 (Stable Image Ultra/Core) accepts a multipart form.
          const form = new FormData()
          form.append('prompt', prompt)
          form.append('output_format', 'png')
          // aspect_ratio maps from the same size hint the caller used.
          const aspect = size === '1792x1024' ? '16:9' : size === '1024x1792' ? '9:16' : '1:1'
          form.append('aspect_ratio', aspect)
          const res = await fetch(ENDPOINTS.stabilityImage, {
            method: 'POST',
            signal,
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            body: form
          })
          if (!res.ok) {
            const text = await res.text()
            return {
              ok: false,
              type: req.type,
              error: `Stability image gen failed: ${res.status} ${text.slice(0, 200)}`
            }
          }
          const data = (await res.json()) as { image?: string; finish_reason?: string }
          if (!data.image) {
            return { ok: false, type: req.type, error: 'Stability returned no image data.' }
          }
          const saved = await saveImage(data.image, 'sdxl')
          recordUsage({
            provider: 'custom',
            model: 'stability-sd3-core',
            kind: 'image',
            inputTokens: 0,
            outputTokens: 0,
            imageCount: 1,
            imageSize: size,
            estimated: false
          })
          return {
            ok: true,
            type: req.type,
            output: `Image saved to ${saved.path} (Stable Diffusion).`,
            data: { path: saved.path, prompt, size, dataUrl: saved.dataUrl, provider: 'stability' }
          }
        }

        if (provider === 'gemini' || provider === 'imagen') {
          const key = getApiKey('gemini')
          if (!key) {
            return {
              ok: false,
              type: req.type,
              error: 'Gemini API key required. Settings → AI Provider → Gemini.'
            }
          }
          // Imagen 3 endpoint — `predict` returns base64 PNG bytes.
          // v2.0 round-4 security polish — send the API key in the
          // `x-goog-api-key` header instead of the URL query string.
          // Query-string keys leak into HTTP-debug captures, corporate
          // TLS-MITM proxy logs, and Electron crash reports that include
          // the failing request URL. The gemini provider in ai/gemini.ts
          // already uses the header form; this matches it.
          const res = await fetch(ENDPOINTS.geminiImagen, {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: JSON.stringify({
              instances: [{ prompt }],
              parameters: {
                sampleCount: 1,
                aspectRatio: size === '1792x1024' ? '16:9' : size === '1024x1792' ? '9:16' : '1:1'
              }
            })
          })
          if (!res.ok) {
            const text = await res.text()
            return {
              ok: false,
              type: req.type,
              error: `Gemini Imagen failed: ${res.status} ${text.slice(0, 200)}`
            }
          }
          const data = (await res.json()) as {
            predictions?: Array<{ bytesBase64Encoded?: string }>
          }
          const b64 = data.predictions?.[0]?.bytesBase64Encoded
          if (!b64) {
            return { ok: false, type: req.type, error: 'Gemini Imagen returned no image data.' }
          }
          const saved = await saveImage(b64, 'imagen')
          recordUsage({
            provider: 'gemini',
            model: 'imagen-3.0-generate-002',
            kind: 'image',
            inputTokens: 0,
            outputTokens: 0,
            imageCount: 1,
            imageSize: size,
            estimated: false
          })
          return {
            ok: true,
            type: req.type,
            output: `Image saved to ${saved.path} (Gemini Imagen).`,
            data: { path: saved.path, prompt, size, dataUrl: saved.dataUrl, provider: 'gemini' }
          }
        }

        if (provider === 'pollinations') {
          // Pollinations.ai — free, no key, no signup. URL-as-API: the prompt
          // goes in the path, dimensions in the query string, and the PNG
          // bytes come straight back. Lower quality than DALL-E / SD3 but
          // it means image gen "just works" out of the box.
          const [wStr, hStr] = size.split('x')
          const width = Math.max(64, Math.min(2048, Number(wStr) || 1024))
          const height = Math.max(64, Math.min(2048, Number(hStr) || 1024))
          const url =
            `${ENDPOINTS.pollinationsImage}${encodeURIComponent(prompt)}` +
            `?width=${width}&height=${height}&nologo=true&model=flux`
          const res = await fetch(url, { signal })
          if (!res.ok) {
            return {
              ok: false,
              type: req.type,
              error: `Pollinations image gen failed: ${res.status}`
            }
          }
          const bytes = Buffer.from(await res.arrayBuffer())
          const saved = await saveImage(bytes.toString('base64'), 'pollinations')
          recordUsage({
            provider: 'custom',
            model: 'pollinations-flux',
            kind: 'image',
            inputTokens: 0,
            outputTokens: 0,
            imageCount: 1,
            imageSize: size,
            estimated: false
          })
          return {
            ok: true,
            type: req.type,
            output: `Image saved to ${saved.path} (Pollinations).`,
            data: {
              path: saved.path,
              prompt,
              size,
              dataUrl: saved.dataUrl,
              provider: 'pollinations'
            }
          }
        }

        // Default: OpenAI DALL·E 3.
        const apiKey = getApiKey('openai')
        if (!apiKey) {
          return {
            ok: false,
            type: req.type,
            error: 'OpenAI API key required for image generation. Settings → AI Provider → OpenAI.'
          }
        }
        const base = resolveBaseUrl('openai')
        const res = await fetch(`${base}/v1/images/generations`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt,
            size,
            response_format: 'b64_json',
            n: 1
          })
        })
        if (!res.ok) {
          const text = await res.text()
          return {
            ok: false,
            type: req.type,
            error: `Image generation failed: ${res.status} ${text.slice(0, 200)}`
          }
        }
        const data = (await res.json()) as {
          data: Array<{ b64_json: string; revised_prompt?: string }>
        }
        const b64 = data.data[0]?.b64_json
        if (!b64) {
          return { ok: false, type: req.type, error: 'No image data returned.' }
        }
        const saved = await saveImage(b64, 'image')
        const revised = data.data[0]?.revised_prompt
        recordUsage({
          provider: 'openai',
          model: 'dall-e-3',
          kind: 'image',
          inputTokens: 0,
          outputTokens: 0,
          imageCount: 1,
          imageSize: size,
          estimated: false
        })
        return {
          ok: true,
          type: req.type,
          output: `Image saved to ${saved.path}${revised ? ` (revised prompt: ${revised})` : ''}.`,
          data: {
            path: saved.path,
            prompt,
            revised,
            size,
            dataUrl: saved.dataUrl,
            provider: 'openai'
          }
        }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : 'Image generation error.'
        }
      }
    }

    case 'edit-image-inpaint':
    case 'edit-image-upscale':
    case 'edit-image-bg-remove': {
      // v2.0 — Stability AI image-editing pipeline. All three share the
      // same key + multipart-form shape, only the endpoint URL and the
      // form fields vary. Routed through one handler with a small per-op
      // switch so the auth / error / save / record-usage scaffolding is
      // written once.
      const key = getSecret('stability')
      if (!key) {
        return {
          ok: false,
          type: req.type,
          error:
            'Stability AI key not configured. Settings → Integrations → paste a key from platform.stability.ai.'
        }
      }
      const imagePath = String(p.image_path ?? '').trim()
      if (!imagePath) {
        return { ok: false, type: req.type, error: 'No image_path supplied.' }
      }
      let imageBytes: Buffer
      try {
        imageBytes = await readFile(imagePath)
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: `Could not read image at "${imagePath}": ${err instanceof Error ? err.message : String(err)}`
        }
      }
      // Stability expects multipart/form-data with the image as a Blob.
      // Node's Blob accepts a Buffer directly — wrapping in a Uint8Array
      // first (the v2.0-RC1 shape) forced an extra full copy of the
      // image bytes, which for a 50 MB photo doubles peak memory use
      // for no benefit. Blob's [Buffer] form streams the same bytes
      // through fetch without the intermediate allocation.
      const imageBlob = new Blob([imageBytes], { type: 'image/png' })
      const form = new FormData()
      form.append('image', imageBlob, basename(imagePath))
      form.append('output_format', 'png')

      let endpoint: string
      let opLabel: string
      let savePrefix: string
      if (req.type === 'edit-image-inpaint') {
        const prompt = String(p.prompt ?? '').trim()
        if (!prompt) return { ok: false, type: req.type, error: 'No prompt supplied for inpaint.' }
        const maskPath = String(p.mask_path ?? '').trim()
        const maskPrompt = String(p.mask_prompt ?? '').trim()
        if (!maskPath && !maskPrompt) {
          return {
            ok: false,
            type: req.type,
            error:
              'Inpaint needs either mask_path (a PNG mask) or mask_prompt (text describing what to mask).'
          }
        }
        form.append('prompt', prompt)
        if (maskPath) {
          try {
            const maskBytes = await readFile(maskPath)
            form.append('mask', new Blob([maskBytes], { type: 'image/png' }), basename(maskPath))
          } catch (err) {
            return {
              ok: false,
              type: req.type,
              error: `Could not read mask at "${maskPath}": ${err instanceof Error ? err.message : String(err)}`
            }
          }
        } else {
          // Stability's inpaint endpoint auto-segments when `search_prompt`
          // is supplied without a binary mask — the API picks the matching
          // region via a built-in vision model. Cheaper than asking the
          // user (or another LLM) to hand-craft a mask.
          form.append('search_prompt', maskPrompt)
        }
        endpoint = ENDPOINTS.stabilityInpaint
        opLabel = 'inpaint'
        savePrefix = 'inpaint'
      } else if (req.type === 'edit-image-upscale') {
        const prompt = String(p.prompt ?? '').trim()
        if (prompt) form.append('prompt', prompt)
        endpoint = ENDPOINTS.stabilityUpscale
        opLabel = 'upscale'
        savePrefix = 'upscale'
      } else {
        // bg-remove takes no extra fields beyond the image.
        endpoint = ENDPOINTS.stabilityRemoveBackground
        opLabel = 'background-remove'
        savePrefix = 'cutout'
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          body: form
        })
        if (!res.ok) {
          const text = await res.text()
          return {
            ok: false,
            type: req.type,
            error: `Stability ${opLabel} failed: ${res.status} ${text.slice(0, 200)}`
          }
        }
        const data = (await res.json()) as { image?: string; finish_reason?: string }
        const b64 = data.image
        if (!b64) {
          return { ok: false, type: req.type, error: `No image data returned from ${opLabel}.` }
        }
        const saved = await saveImagePng(b64, savePrefix)
        recordUsage({
          provider: 'custom',
          model: `stability-${opLabel}`,
          kind: 'image',
          inputTokens: 0,
          outputTokens: 0,
          imageCount: 1,
          // The output dimensions vary per op — record a stable label
          // rather than trying to read the PNG header for an exact size.
          imageSize: opLabel === 'upscale' ? 'upscaled' : 'edited',
          estimated: false
        })
        return {
          ok: true,
          type: req.type,
          output: `Edited image saved to ${saved.path} (${opLabel}).`,
          data: {
            path: saved.path,
            sourcePath: imagePath,
            operation: opLabel,
            dataUrl: saved.dataUrl,
            provider: 'stability'
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { ok: false, type: req.type, error: 'Image edit aborted.' }
        }
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : 'Image edit failed.'
        }
      }
    }

    case 'run-python': {
      const code = String(p.code ?? '').trim()
      if (!code) return { ok: false, type: req.type, error: 'No code supplied.' }
      const timeoutMs = normalizePythonTimeoutMs(p.timeout_ms)

      // v2.0 — persistent path. When the caller threaded a threadId in
      // (the agent loop always does), run the code through the per-thread
      // Python kernel so variables / imports / generated files survive
      // across turns. The kernel's CWD is the thread's workspace dir, so
      // `open('out.csv', 'w')` lands somewhere the user can find later
      // and a follow-up `pandas.read_csv('out.csv')` just works.
      //
      // Callers without a threadId (one-off tray runs, smoke tests) fall
      // through to the ephemeral execAsync path below — same shape as v1.
      if (req.threadId) {
        // The kernel doesn't enforce a wall-clock timeout itself; we
        // wrap the promise with an AbortController-backed race so the
        // user-supplied `timeout_ms` still bounds runaway cells.
        const timeoutController = new AbortController()
        const userTimer = setTimeout(() => timeoutController.abort(), timeoutMs)
        // Caller's abort signal + our timeout are both abort sources.
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal
        try {
          const result = await runPersistentPython(req.threadId, code, combinedSignal)
          if (result.error) {
            const combined = [result.stdout, result.stderr, result.error]
              .filter(Boolean)
              .join('\n')
              .slice(0, 8000)
            // KeyboardInterrupt is the abort path (user clicked Stop or
            // we hit the timeout); surface it as the friendlier error
            // instead of dumping the bare traceback string.
            if (result.error === 'KeyboardInterrupt') {
              const reason = signal?.aborted
                ? 'Python execution aborted by user.'
                : `Python execution timed out after ${timeoutMs}ms.`
              return { ok: false, type: req.type, error: reason }
            }
            return {
              ok: false,
              type: req.type,
              error: combined || result.error
            }
          }
          const output = (result.stdout || result.stderr || '(no output)').slice(0, 8000)
          return {
            ok: true,
            type: req.type,
            output,
            data: {
              stdout: result.stdout,
              stderr: result.stderr,
              workspaceDir: result.workspaceDir,
              python: result.ready.python
            }
          }
        } catch (err) {
          if (timeoutController.signal.aborted && !signal?.aborted) {
            return {
              ok: false,
              type: req.type,
              error: `Python execution timed out after ${timeoutMs}ms.`
            }
          }
          if (signal?.aborted) {
            return { ok: false, type: req.type, error: 'Python execution aborted.' }
          }
          // The most likely failure here is "Python isn't installed" —
          // forward the kernel's friendly message verbatim.
          return {
            ok: false,
            type: req.type,
            error: err instanceof Error ? err.message : String(err)
          }
        } finally {
          clearTimeout(userTimer)
        }
      }

      // Legacy ephemeral path: tray quick-runs / smoke tests with no
      // threadId. Kept verbatim from v1.x so no caller's behaviour
      // changes silently.
      const tempDir = await mkdtemp(join(tmpdir(), 'voidsoul-py-'))
      const scriptPath = join(tempDir, 'script.py')
      try {
        await writeFile(scriptPath, code, 'utf-8')
        // PYTHON_CMD: 'python' on Windows, 'python3' elsewhere — shared
        // with the persistent kernel so a user with a working v1 setup
        // needs no extra config for the v2 path either.
        const { stdout, stderr } = await execAsync(`${PYTHON_CMD} "${scriptPath}"`, {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 4,
          // Threaded from the agent loop's requestId → child gets SIGTERM
          // when the user clicks Stop, so a long Python script doesn't
          // keep computing in the background after the chat moved on.
          signal
        })
        const output = (stdout || stderr || '(no output)').slice(0, 8000)
        return {
          ok: true,
          type: req.type,
          output,
          data: { stdout, stderr }
        }
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
        if (e.killed) {
          return {
            ok: false,
            type: req.type,
            error: `Python execution timed out after ${timeoutMs}ms.`
          }
        }
        const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 8000)
        return {
          ok: false,
          type: req.type,
          error: combined || 'Python execution failed (is `python` on your PATH?).'
        }
      } finally {
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }

    case 'save-document': {
      const content = String(p.content ?? '').trim()
      if (!content) {
        return { ok: false, type: req.type, error: 'No content supplied to save.' }
      }
      const allowedFormats: ThreadExportFormat[] = [
        'docx',
        'pdf',
        'xlsx',
        'markdown',
        'txt',
        'html'
      ]
      const rawFormat = String(p.format ?? 'markdown').toLowerCase()
      const format = allowedFormats.includes(rawFormat as ThreadExportFormat)
        ? (rawFormat as ThreadExportFormat)
        : 'markdown'
      const filename = String(p.filename ?? 'document').trim() || 'document'
      const title = typeof p.title === 'string' ? p.title : undefined

      let rendered
      try {
        rendered = await renderContent(content, format, filename, title)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, type: req.type, error: `Render failed: ${msg}` }
      }
      // promptSaveAndWrite anchors to the focused window itself when no
      // parent is passed, and handles the dialog + writeFile + error
      // returns. Same helper the per-thread export IPC uses, so the two
      // paths can't drift out of sync.
      const saved = await promptSaveAndWrite(rendered, format)
      if (!saved.ok) {
        if (saved.message === 'Export cancelled.') {
          return { ok: true, type: req.type, output: 'User cancelled the save dialog.' }
        }
        return { ok: false, type: req.type, error: saved.message }
      }
      return {
        ok: true,
        type: req.type,
        output: saved.message,
        data: { path: saved.path, format, bytes: rendered.bytes.length }
      }
    }

    /* ----------- v2.0 Home Assistant integration ------------ */
    case 'ha-list-entities': {
      // Disabled-but-permission-granted is a configuration error, not a
      // permission denial. Surface it explicitly so the agent's next turn
      // knows to ask the user to set HA up rather than retry.
      if (!getConfig().homeAssistant?.enabled) {
        return {
          ok: false,
          type: req.type,
          error: 'Home Assistant is not enabled in Settings → Tools → Home Assistant.'
        }
      }
      try {
        const states = await listHomeAssistantStates(
          { domain: typeof p.domain === 'string' && p.domain ? p.domain : undefined },
          signal
        )
        // Trim to a compact form — full attributes blow the agent's
        // context. Sample of 200 to cap the worst case (huge HA
        // instances can run 1000+ entities).
        const summary = states.slice(0, 200).map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name:
            typeof s.attributes?.friendly_name === 'string'
              ? (s.attributes.friendly_name as string)
              : null,
          domain: s.entity_id.split('.', 1)[0]
        }))
        const truncated = states.length > 200
        return {
          ok: true,
          type: req.type,
          output:
            `Found ${states.length} HA entit${states.length === 1 ? 'y' : 'ies'}` +
            (truncated ? ' (showing first 200)' : '') +
            '.',
          data: { entities: summary, total: states.length, truncated }
        }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    case 'ha-get-state': {
      if (!getConfig().homeAssistant?.enabled) {
        return {
          ok: false,
          type: req.type,
          error: 'Home Assistant is not enabled in Settings → Tools → Home Assistant.'
        }
      }
      const entityId = String(p.entity_id ?? '').trim()
      if (!entityId) {
        return { ok: false, type: req.type, error: 'entity_id is required.' }
      }
      try {
        const state = await getHomeAssistantState(entityId, signal)
        return {
          ok: true,
          type: req.type,
          output: `${entityId} is ${state.state}.`,
          data: state
        }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    case 'ha-call-service': {
      if (!getConfig().homeAssistant?.enabled) {
        return {
          ok: false,
          type: req.type,
          error: 'Home Assistant is not enabled in Settings → Tools → Home Assistant.'
        }
      }
      const domain = String(p.domain ?? '').trim()
      const service = String(p.service ?? '').trim()
      if (!domain || !service) {
        return { ok: false, type: req.type, error: 'domain and service are both required.' }
      }
      const entityId = typeof p.entity_id === 'string' ? p.entity_id.trim() : ''
      const data = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {}
      try {
        const changed = await callHomeAssistantService(
          {
            domain,
            service,
            target: entityId ? { entity_id: entityId } : undefined,
            data
          },
          signal
        )
        const summary =
          changed.length === 0
            ? `Called ${domain}.${service} — HA reported no state changes (this is normal for fire-and-forget services).`
            : `Called ${domain}.${service}. ${changed.length} entit${changed.length === 1 ? 'y' : 'ies'} updated: ${changed
                .slice(0, 5)
                .map((c) => `${c.entity_id} → ${c.state}`)
                .join(', ')}${changed.length > 5 ? '…' : ''}`
        return {
          ok: true,
          type: req.type,
          output: summary,
          data: { changed }
        }
      } catch (err) {
        return {
          ok: false,
          type: req.type,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    default:
      return { ok: false, type: req.type, error: `Unsupported action: ${req.type}` }
  }
}

/**
 * Public entry point — permission-checks, dispatches, logs and returns.
 *
 * Accepts an optional `AbortSignal`; abortable tool branches (web-fetch,
 * web-search, generate-image, run-python, shell) thread it into their
 * underlying fetch / spawn so the user clicking Stop actually halts the
 * subprocess / network call mid-flight rather than letting them run to
 * completion in the background.
 */
export async function executeAction(
  req: ActionRequest,
  signal?: AbortSignal
): Promise<ActionResult> {
  const descriptor = ACTION_DESCRIPTORS.find((d) => d.type === req.type)
  if (!descriptor) {
    return { ok: false, type: req.type, error: `Unknown action: ${req.type}` }
  }

  // v2.0 round-8 multi-platform — fail fast on platform-restricted
  // actions before the permission check + dispatch. Without this, an
  // agent on mac/linux calling type-text / mouse-click / hotkey /
  // visual-click would hit input.ts's `throw new Error('... Windows
  // only')` deeper in the stack and the chat surface would show a
  // confusing low-level error. Now the agent gets a one-line clear
  // "Not supported on darwin" up front so its retry loop can route
  // around the Win-only capability.
  if (descriptor.platforms && !descriptor.platforms.includes(process.platform)) {
    log(
      'info',
      'automation',
      `Refusing "${descriptor.label}" on ${process.platform} — supported only on ${descriptor.platforms.join(', ')}.`
    )
    return {
      ok: false,
      type: req.type,
      error: `"${descriptor.label}" is not supported on ${process.platform}. Supported platforms: ${descriptor.platforms.join(', ')}.`
    }
  }

  if (descriptor.requires) {
    try {
      assertGranted(descriptor.requires)
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        log(
          'warn',
          'automation',
          `Blocked "${descriptor.label}" — needs ${err.permission} permission.`
        )
        return {
          ok: false,
          type: req.type,
          needsPermission: err.permission,
          error: `This action needs the "${err.permission}" permission.`
        }
      }
      throw err
    }
  }

  const startedAt = Date.now()
  try {
    const result = await dispatch(req, signal)
    log(
      result.ok ? 'success' : 'error',
      'automation',
      `${descriptor.label}: ${result.output ?? result.error ?? 'done'}`
    )
    // v1.5.0 — emit a task-complete event for the proactive watch
    // subsystem. Watch tasks with type:'task-complete' subscribe via
    // onWatchEvent and decide whether the duration crossed their
    // threshold. Only fires on success — failed/cancelled work
    // shouldn't trigger a celebratory "alright, that's done."
    const durationSec = (Date.now() - startedAt) / 1000
    if (result.ok && durationSec >= 5) {
      // Lazy require to avoid renderer-side import cost. The watch
      // module is main-only and the proactive subsystem is opt-in.
      void import('../proactive/watchTasks').then(({ onWatchEvent }) => {
        onWatchEvent({
          type: 'task-complete',
          payload: { durationSec }
        })
      })
    }
    return result
  } catch (err) {
    // Surface aborts as a clean, non-error outcome so logs don't fill with
    // scary stack traces for what's really "user clicked Stop".
    if (signal?.aborted) {
      return { ok: false, type: req.type, error: 'aborted' }
    }
    const message = err instanceof Error ? err.message : String(err)
    log('error', 'automation', `${descriptor.label} failed`, message)
    return { ok: false, type: req.type, error: message }
  }
}
