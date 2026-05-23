/**
 * Piper TTS bridge — replaces the Web Speech / SAPI path with the
 * open-source Piper neural TTS engine (rhasspy/piper, MIT-licensed).
 *
 * Why we swapped: SAPI on Windows ships robotic David/Mark/Zira by
 * default, the modern "Natural HD" voices (Andrew, Ava) are gated
 * behind a private API, and the Microsoft Edge TTS cloud endpoint
 * has gotten too aggressive about anti-scraping for a third-party app
 * to depend on. Piper runs locally with no network, no API key, no
 * gating — and the per-voice .onnx files give us actual character
 * voices for Void and Soul instead of generic system voices.
 *
 * Binary layout (bundled via electron-builder asarUnpack):
 *   resources/piper/<platform>/piper/piper(.exe)
 *   resources/piper/<platform>/piper/*.dll | *.so
 *   resources/piper/<platform>/piper/espeak-ng-data/  (phoneme tables)
 *
 * Voice file layout (per-user data):
 *   <userData>/voices/void/*.onnx           (+ matching .onnx.json)
 *   <userData>/voices/soul/*.onnx
 *
 * Synthesis flow: spawn piper, pipe the text in on stdin, collect the
 * WAV bytes from stdout, return Buffer. Real-time factor on a typical
 * machine is ~0.07× (Amy medium, M2 / mid-range PC) — so a 5-second
 * sentence renders in ~350 ms. Way under what streaming TTS needs to
 * sound fluid.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'
import { ensureDataPath } from '../storage/store'

/* ------------------------------ paths --------------------------------- */

/**
 * Absolute path to the bundled Piper executable for the current platform.
 *
 * In dev mode (`electron-vite dev`): `app.getAppPath()` points at the
 * project root, so the binary lives under `resources/piper/...` next to
 * the source tree.
 *
 * In a packaged build: `app.getAppPath()` returns `<install>/resources/
 * app.asar`. Because `resources/**` is listed under `asarUnpack` in
 * electron-builder.yml, the real files live at
 * `<install>/resources/app.asar.unpacked/resources/piper/...`. We rewrite
 * the path so spawn() can actually find the binary.
 */
function piperBinaryPath(): string {
  const root = app.getAppPath().replace('app.asar', 'app.asar.unpacked')
  const exe = process.platform === 'win32' ? 'piper.exe' : 'piper'
  return join(root, 'resources', 'piper', process.platform, 'piper', exe)
}

/** Folder containing the piper binary + its DLLs / espeak-ng-data. We
 *  spawn with this as CWD so piper finds its phoneme tables. */
function piperBinaryDir(): string {
  const root = app.getAppPath().replace('app.asar', 'app.asar.unpacked')
  return join(root, 'resources', 'piper', process.platform, 'piper')
}

/** Per-user voices directory. Created on first access. */
export function voicesDir(): string {
  return ensureDataPath('voices')
}

function personaDir(persona: VoicePersona): string {
  return ensureDataPath('voices', persona)
}

/* ---------------------------- voice discovery ------------------------- */

export type VoicePersona = 'void' | 'soul'

export interface InstalledVoice {
  /** Absolute path to the .onnx model file — what piper consumes. */
  modelPath: string
  /** Display name pulled from the model filename (e.g., "en_US-amy-medium"). */
  id: string
  /** Friendly name extracted from the .onnx.json metadata, or the id. */
  name: string
  /** File size in bytes — surfaced in the settings card so the user knows. */
  sizeBytes: number
  /** Optional language tag from metadata (e.g., "en_US"). */
  language?: string
  /** Quality tier — "x_low", "low", "medium", "high" — read from the path. */
  quality?: string
}

/**
 * Walk a persona's voice folder and return the model files we find. Each
 * voice = one `.onnx` file paired with an `.onnx.json` config — we surface
 * only the .onnx ones (the JSON is metadata piper auto-loads).
 *
 * Returns the first voice as the "active" one in the settings UI — we
 * don't currently expose a picker, so dropping a single .onnx into the
 * folder is the natural way to switch a persona's voice.
 */
export function listInstalledVoices(persona: VoicePersona): InstalledVoice[] {
  const dir = personaDir(persona)
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.onnx'))
  } catch (err) {
    log(
      'warn',
      'system',
      `Piper: couldn't read voices/${persona}`,
      err instanceof Error ? err.message : String(err)
    )
    return []
  }

  const voices: InstalledVoice[] = []
  for (const name of names) {
    const modelPath = join(dir, name)
    let sizeBytes = 0
    try {
      sizeBytes = statSync(modelPath).size
    } catch {
      continue
    }
    const id = name.replace(/\.onnx$/i, '')
    // Try to pull a human-readable name + language out of the .onnx.json
    // metadata file. Each Piper voice ships one — usually a few KB. Missing
    // or malformed is a soft failure; we fall back to the filename.
    let friendlyName = id
    let language: string | undefined
    let quality: string | undefined
    try {
      const cfg = JSON.parse(readFileSync(`${modelPath}.json`, 'utf-8')) as {
        language?: { name_native?: string; code?: string }
        dataset?: string
        audio?: { quality?: string }
      }
      if (cfg.dataset) friendlyName = cfg.dataset
      language = cfg.language?.code
      quality = cfg.audio?.quality
    } catch {
      /* metadata missing — keep filename-derived defaults */
    }
    voices.push({ modelPath, id, name: friendlyName, sizeBytes, language, quality })
  }
  return voices
}

/**
 * Returns the FIRST installed voice for a persona, or null if none.
 * Settings UI uses this to populate the current-voice card; synthesis
 * uses it to resolve which .onnx file to pass to piper.
 */
export function activeVoice(persona: VoicePersona): InstalledVoice | null {
  return listInstalledVoices(persona)[0] ?? null
}

/* ----------------------------- migration ------------------------------ */

/**
 * One-time copy from the developer-only `Voices/` folder at the repo root
 * (where users initially dropped their Piper downloads) into the canonical
 * userData voices folder. Runs once on first launch when:
 *   · userData/voices/void or .../soul is empty, AND
 *   · the legacy Voices/ folder exists and has matching subfolders
 *
 * Subfolder names are matched loosely — "Void (Arctic)" → void, "Soul
 * (Amy)" → soul — so the user's organic naming during exploration still
 * lands in the right place. After the copy the original files are left
 * intact (non-destructive). Logged so a future debug session has the
 * audit trail.
 */
export async function migrateLegacyVoices(): Promise<{ copied: number }> {
  const legacyRoot = join(app.getAppPath(), 'Voices')
  if (!existsSync(legacyRoot)) return { copied: 0 }

  let copied = 0
  let legacySubdirs: string[]
  try {
    legacySubdirs = readdirSync(legacyRoot).filter((name) => {
      try {
        return statSync(join(legacyRoot, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { copied: 0 }
  }

  for (const persona of ['void', 'soul'] as const) {
    // Skip the persona entirely if it already has voices installed —
    // migration is idempotent / no-ops on subsequent launches.
    if (listInstalledVoices(persona).length > 0) continue

    const match = legacySubdirs.find((name) => name.toLowerCase().startsWith(persona))
    if (!match) continue

    const sourceDir = join(legacyRoot, match)
    const targetDir = personaDir(persona)

    let files: string[] = []
    try {
      files = readdirSync(sourceDir)
    } catch {
      continue
    }
    for (const file of files) {
      // Copy .onnx, .onnx.json, plus the MODEL_CARD for traceability.
      if (!/\.(onnx|json)$/i.test(file) && file !== 'MODEL_CARD') continue
      const src = join(sourceDir, file)
      const dst = join(targetDir, file)
      try {
        await copyFile(src, dst)
        copied++
      } catch (err) {
        log(
          'warn',
          'system',
          `Piper migration: couldn't copy ${file}`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    log('info', 'system', `Piper migration: ${match} → voices/${persona}`)
  }
  return { copied }
}

/* ----------------------------- synthesis ------------------------------ */

export interface SynthesiseOptions {
  text: string
  persona: VoicePersona
  /**
   * Speech rate (0.5 – 1.6). Maps inversely to piper's `--length_scale`
   * (higher = slower), so we invert + clamp. 1.0 = normal speed.
   */
  rate?: number
}

/**
 * Run piper on a single sentence (or short paragraph) and return the
 * resulting WAV bytes. Throws if piper isn't installed, the voice file
 * isn't present, or synthesis exits non-zero.
 *
 * Caller (renderer via IPC) plays the WAV by wrapping it in a Blob URL
 * and feeding it to an `<audio>` element — the standard browser path.
 *
 * Cost: one spawn per call. Piper cold-start is ~300 ms (loading the
 * .onnx model into memory), subsequent synthesis is ~70 ms per second
 * of audio at "medium" quality. For sentence-level streaming TTS, the
 * first sentence is the only one with the model-load tax — every later
 * sentence reuses the warm OS file cache.
 */
export function synthesise(opts: SynthesiseOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const text = opts.text.trim()
    if (!text) {
      resolve(Buffer.alloc(0))
      return
    }

    const voice = activeVoice(opts.persona)
    if (!voice) {
      reject(new Error(`No voice installed for the ${opts.persona} persona.`))
      return
    }

    const binary = piperBinaryPath()
    if (!existsSync(binary)) {
      reject(
        new Error(
          `Piper binary missing at ${binary}. Run \`npm run piper\` in dev, or reinstall the app.`
        )
      )
      return
    }

    // Invert + clamp the rate. Piper's length_scale is the inverse of
    // perceived speed: 0.8 length_scale ≈ 1.25× speed. 0.5-1.6 input
    // range maps to 2.0-0.625 length_scale.
    const rateInput = Math.min(1.6, Math.max(0.5, opts.rate ?? 1))
    const lengthScale = 1 / rateInput

    const args = [
      '--model', voice.modelPath,
      '--output_file', '-', // stdout
      '--length_scale', lengthScale.toFixed(3)
    ]

    const proc = spawn(binary, args, {
      // Run from the binary directory so piper finds its espeak-ng-data
      // sibling folder regardless of where the user launched the app from.
      cwd: piperBinaryDir(),
      // Suppress the Windows console flash a `spawn()` can otherwise pop
      // up on packaged builds — purely cosmetic.
      windowsHide: true
    })

    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    proc.on('error', (err) => {
      reject(new Error(`Piper failed to start: ${err.message}`))
    })
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Piper exited with code ${code}. ${stderr.trim().slice(0, 240) || '(no stderr)'}`
          )
        )
        return
      }
      const wav = Buffer.concat(chunks)
      if (wav.length === 0) {
        reject(new Error('Piper produced no audio.'))
        return
      }
      resolve(wav)
    })

    // Feed the prompt + close stdin so piper knows we're done.
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

/* ------------------------- summary for renderer ----------------------- */

export interface VoiceSetupStatus {
  /** Whether the piper binary is bundled + reachable from this process. */
  binaryAvailable: boolean
  /** First installed voice per persona, or null if none. */
  void: InstalledVoice | null
  soul: InstalledVoice | null
}

/**
 * One-call summary the settings UI renders. Cheaper than three separate
 * IPCs (binary check + two listings) and atomically reflects the same
 * disk state across all three values.
 */
export function getVoiceSetupStatus(): VoiceSetupStatus {
  return {
    binaryAvailable: existsSync(piperBinaryPath()),
    void: activeVoice('void'),
    soul: activeVoice('soul')
  }
}

/** Opens the user-data voices folder in the OS file explorer. Wired to
 *  the "Open voices folder" button in settings. */
export function voicesDirectoryPath(): string {
  return voicesDir()
}
