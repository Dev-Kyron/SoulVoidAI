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
import { rememberProject } from '../storage/memory'
import { getApiKey, getSecret } from '../storage/keys'
import { resolveBaseUrl } from '../storage/config'
import { dataPath } from '../storage/store'
import { renderContent, promptSaveAndWrite, type ThreadExportFormat } from '../export/thread'
import { recordUsage } from '../usage'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extractFromHtml } from './readability'
import { runWebSearch } from './search'
import { checkUrlSafe } from './urlSafety'
import { ENDPOINTS } from './endpoints'
import type { ActionDescriptor, ActionRequest, ActionResult } from '@shared/types'

const execAsync = promisify(exec)
const MAX_READ_CHARS = 200_000

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
  {
    type: 'type-text',
    label: 'Type Text',
    description: 'Send keystrokes to the focused window.',
    requires: 'inputAccess',
    reversible: false
  },
  {
    type: 'hotkey',
    label: 'Send Hotkey',
    description: 'Send a keyboard shortcut (e.g. ctrl+s) to the focused window.',
    requires: 'inputAccess',
    reversible: false
  },
  {
    type: 'move-mouse',
    label: 'Move Cursor',
    description: 'Move the mouse cursor to screen coordinates.',
    requires: 'inputAccess',
    reversible: false
  },
  {
    type: 'mouse-click',
    label: 'Mouse Click',
    description: 'Perform a left or right mouse click.',
    requires: 'inputAccess',
    reversible: false
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
    type: 'generate-image',
    label: 'Generate Image',
    description: 'Generate an image from a text prompt (OpenAI DALL·E 3).',
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
  }
]

/* ------------------------------ undo registry --------------------------- */

interface UndoEntry {
  label: string
  run: () => Promise<void>
}

const undoRegistry = new Map<string, UndoEntry>()

function registerUndo(label: string, run: () => Promise<void>): {
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
  switch (key.toLowerCase()) {
    case 'vscode':
    case 'code':
      return { target: 'code' }
    case 'terminal':
      return { target: 'wt' }
    case 'obs':
      return { target: 'obs64.exe', cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit' }
    case 'discord':
      return {
        target: expandEnv('%LOCALAPPDATA%\\Discord\\Update.exe'),
        args: '--processStart Discord.exe'
      }
    default:
      return { target: key }
  }
}

async function launchApp(key: string): Promise<string> {
  const spec = resolveApp(key)

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

async function typeText(text: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Keystroke automation is currently implemented for Windows only.')
  }
  const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''")
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'Start-Sleep -Milliseconds 400; ' +
    `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`
  await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(script)}`, {
    windowsHide: true
  })
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
    return { ok: true, type: 'organize-folder', output: 'Nothing to organise — no loose files found.' }
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
    'Mozilla/5.0 (VoidSoul Assistant) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
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
  while (next && hops < 5) {
    const nextUrl = new URL(next, current.url || originalUrl)
    const safety = checkUrlSafe(nextUrl)
    if (!safety.ok) {
      return { blocked: `Redirect blocked: ${safety.reason}` }
    }
    const hopCtrl = new AbortController()
    const hopTimer = setTimeout(() => hopCtrl.abort(), 15_000)
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
      return { ok: true, type: req.type, output: `Moved cursor to ${Math.round(x)}, ${Math.round(y)}.` }
    }

    case 'mouse-click': {
      const button = optParam(p, 'button') === 'right' ? 'right' : 'left'
      await mouseClick(button)
      return { ok: true, type: req.type, output: `${button === 'right' ? 'Right' : 'Left'} mouse click.` }
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

      const saveImage = async (
        b64: string,
        prefix: string
      ): Promise<{ path: string; dataUrl: string }> => {
        const dir = dataPath('generated-images')
        await mkdir(dir, { recursive: true })
        const filename = `${prefix}-${Date.now()}.png`
        const filepath = join(dir, filename)
        await writeFile(filepath, Buffer.from(b64, 'base64'))
        return { path: filepath, dataUrl: `data:image/png;base64,${b64}` }
      }

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
          const aspect =
            size === '1792x1024'
              ? '16:9'
              : size === '1024x1792'
                ? '9:16'
                : '1:1'
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
          const res = await fetch(
            `${ENDPOINTS.geminiImagen}?key=${key}`,
            {
              method: 'POST',
              signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                instances: [{ prompt }],
                parameters: {
                  sampleCount: 1,
                  aspectRatio:
                    size === '1792x1024'
                      ? '16:9'
                      : size === '1024x1792'
                        ? '9:16'
                        : '1:1'
                }
              })
            }
          )
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

    case 'run-python': {
      const code = String(p.code ?? '').trim()
      if (!code) return { ok: false, type: req.type, error: 'No code supplied.' }
      const timeoutMs = Math.min(Number(p.timeout_ms ?? 30000), 120000)
      const tempDir = await mkdtemp(join(tmpdir(), 'voidsoul-py-'))
      const scriptPath = join(tempDir, 'script.py')
      try {
        await writeFile(scriptPath, code, 'utf-8')
        // Try python3 first (mac/linux), fall back to python (windows).
        const cmd = process.platform === 'win32' ? 'python' : 'python3'
        const { stdout, stderr } = await execAsync(`${cmd} "${scriptPath}"`, {
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

  if (descriptor.requires) {
    try {
      assertGranted(descriptor.requires)
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        log('warn', 'automation', `Blocked "${descriptor.label}" — needs ${err.permission} permission.`)
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
