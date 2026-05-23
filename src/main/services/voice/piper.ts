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
import { copyFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { ensureDataPath } from '../storage/store'
import type { ToneTag } from '@shared/voiceMarkers'

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

/**
 * Per-tone Piper parameter presets. The voice pipeline emits segments
 * tagged with a ToneTag (from the model's <voice tone="..."> markup);
 * each tone maps to a (length_scale, noise_scale, noise_w) triple that
 * Piper interprets as:
 *   · length_scale — phoneme duration multiplier. Higher = slower.
 *   · noise_scale  — variability of synthesised audio. Higher = more
 *                    expressive but less predictable.
 *   · noise_w      — phoneme duration variability. Higher = more
 *                    natural rhythm at the cost of consistency.
 *
 * The user's `rate` setting in voice config stacks UNDER the tone preset:
 * tone gives the personality, rate gives the user's preferred speed.
 *
 * Baselines match piper's documented defaults (0.667 / 0.8) for `casual`
 * so the existing rate-only path keeps sounding identical.
 */
export const TONE_PRESETS: Record<ToneTag, {
  length_scale: number
  noise_scale: number
  noise_w: number
}> = {
  casual: { length_scale: 1.0, noise_scale: 0.667, noise_w: 0.8 },
  focused: { length_scale: 0.92, noise_scale: 0.5, noise_w: 0.7 },
  excited: { length_scale: 0.85, noise_scale: 0.8, noise_w: 0.95 },
  serious: { length_scale: 1.15, noise_scale: 0.4, noise_w: 0.65 },
  dry: { length_scale: 1.05, noise_scale: 0.45, noise_w: 0.7 }
}

/**
 * Per-persona noise_scale offset added on top of whatever the tone preset
 * picks. Gives each persona a consistent character baseline so Soul sounds
 * more expressive than Void in every tone window, without having to clone
 * the whole TONE_PRESETS table per persona.
 *
 *   Soul:  +0.05 — slightly more variability, expressive
 *   Void:  -0.10 — steadier, more controlled, deadpan-friendly
 *
 * The result is clamped to [0.1, 1.0] so an extreme combination (e.g.
 * Void + serious which is already 0.4) can't dip into negative territory
 * Piper would reject.
 */
const PERSONA_NOISE_OFFSET: Record<VoicePersona, number> = {
  soul: 0.05,
  void: -0.1
}

export interface SynthesiseOptions {
  text: string
  persona: VoicePersona
  /**
   * Speech rate (0.5 – 1.6). Maps inversely to piper's `--length_scale`
   * (higher = slower), so we invert + clamp. 1.0 = normal speed.
   * Stacks on top of any tone preset: final length_scale =
   * preset.length_scale / rate.
   */
  rate?: number
  /**
   * Tone preset selected by the model (or by the caller for direct
   * speak() invocations). Defaults to 'casual' which matches the
   * pre-v1.3.0 default sound.
   */
  tone?: ToneTag
}

/**
 * Run piper on a single sentence (or short paragraph) and return the
 * resulting WAV bytes. Throws if piper isn't installed, the voice file
 * isn't present, synthesis exits non-zero, or the output isn't a valid
 * WAV stream.
 *
 * Implementation note: we write to a real temp file rather than piping
 * via `--output_file -` to stdout. The Windows piper 2023.11.14-2 build
 * has a long-standing quirk where stdout redirection produces truncated
 * or malformed WAV — the WAV header writes correctly but PCM sample
 * flushing relies on libc stdout buffering that piper doesn't always
 * close cleanly, leaving Chromium's `<audio>` decoder with a header-only
 * stream that plays as a brief buzz before failing with "no supported
 * source." Writing to a temp file uses piper's well-tested file path,
 * costs us one fs round-trip per sentence (~1 ms for ~30 KB WAVs), and
 * lets us validate the WAV header before handing bytes to the renderer.
 *
 * Caller (renderer via IPC) plays the WAV by wrapping it in a Blob URL
 * and feeding it to an `<audio>` element — the standard browser path.
 *
 * Cost: one spawn + one fs write/read per call. Piper cold-start is
 * ~300 ms (loading the .onnx model into memory), subsequent synthesis
 * is ~70 ms per second of audio at "medium" quality. For sentence-level
 * streaming TTS, the first sentence is the only one with the model-load
 * tax — every later sentence reuses the warm OS file cache.
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

    // Tone preset gives the personality (length_scale baseline + noise
    // variability); user's rate stacks on top as a multiplicative speed
    // override. Defaults to 'casual' which matches the pre-v1.3.0 sound,
    // so existing callers that don't pass tone keep their behaviour.
    const tone = opts.tone ?? 'casual'
    const preset = TONE_PRESETS[tone]
    const rateInput = Math.min(1.6, Math.max(0.5, opts.rate ?? 1))
    const lengthScale = preset.length_scale / rateInput
    // Persona character offset on top of the tone preset's noise_scale.
    // Clamped to [0.1, 1.0] so an extreme combination can't dip into a
    // value Piper rejects.
    const noiseScale = Math.min(
      1.0,
      Math.max(0.1, preset.noise_scale + PERSONA_NOISE_OFFSET[opts.persona])
    )

    // Temp file in the OS temp dir — gets unlinked after we read it back.
    // UUID suffix so concurrent synth calls (rare but possible during
    // streaming TTS) don't collide.
    const outPath = join(tmpdir(), `piper-${randomUUID()}.wav`)

    // CLI flag naming: Piper 2023.11.14-2 canonical form is HYPHENS,
    // not underscores. v1.3.0-v1.3.1 used underscores which Piper
    // silently rejected for --noise_scale + --noise_w (added in v1.3.0)
    // and the binary then exited non-zero with "unrecognized option",
    // killing playback. --length-scale happened to be tolerated as
    // --length_scale by the argparse but the others weren't. Stick to
    // hyphens for all three to match the documented CLI exactly.
    const args = [
      '--model', voice.modelPath,
      '--output_file', outPath,
      '--length-scale', lengthScale.toFixed(3),
      '--noise-scale', noiseScale.toFixed(3),
      '--noise-w', preset.noise_w.toFixed(3)
    ]
    // Diagnostic: full piper command so failures past this point are
    // reproducible by hand from a terminal. Skipped at log level 'info'
    // by default (most users don't care) but visible when filtering for
    // 'system' in the Logs tab.
    log(
      'info',
      'system',
      `Piper synth (${opts.persona}${opts.tone ? `/${opts.tone}` : ''}): length=${lengthScale.toFixed(3)} noise=${noiseScale.toFixed(3)} w=${preset.noise_w.toFixed(3)}`
    )

    const proc = spawn(binary, args, {
      // Run from the binary directory so piper finds its espeak-ng-data
      // sibling folder regardless of where the user launched the app from.
      cwd: piperBinaryDir(),
      // Suppress the Windows console flash a `spawn()` can otherwise pop
      // up on packaged builds — purely cosmetic.
      windowsHide: true
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    proc.on('error', (err) => {
      // Cleanup best-effort — if piper never started, the file likely
      // doesn't exist, but unlink errors are non-fatal either way.
      void unlink(outPath).catch(() => {})
      reject(new Error(`Piper failed to start: ${err.message}`))
    })
    proc.on('exit', (code) => {
      void (async () => {
        try {
          if (code !== 0) {
            throw new Error(
              `Piper exited with code ${code}. ${stderr.trim().slice(0, 240) || '(no stderr)'}`
            )
          }
          let wav: Buffer
          try {
            wav = await readFile(outPath)
          } catch (readErr) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr)
            throw new Error(
              `Piper reported success but produced no output file (${msg}). ` +
                `Stderr: ${stderr.trim().slice(0, 240) || '(empty)'}`
            )
          }
          if (wav.length < 44) {
            // RIFF header is 12 bytes + fmt chunk is 24 bytes minimum +
            // data chunk header is 8 bytes = 44 bytes for the smallest
            // valid WAV. Anything shorter is a guaranteed broken stream.
            throw new Error(
              `Piper produced a truncated WAV (${wav.length} bytes). ` +
                `Stderr: ${stderr.trim().slice(0, 240) || '(empty)'}`
            )
          }
          // Validate the magic bytes — Chromium's <audio> decoder rejects
          // anything that isn't "RIFF....WAVE", and we'd rather see a
          // clear error here than a useless "no supported source" in the
          // renderer.
          const riff = wav.subarray(0, 4).toString('ascii')
          const wave = wav.subarray(8, 12).toString('ascii')
          if (riff !== 'RIFF' || wave !== 'WAVE') {
            throw new Error(
              `Piper output isn't a valid WAV (magic: "${riff}"/"${wave}"). ` +
                `Stderr: ${stderr.trim().slice(0, 240) || '(empty)'}`
            )
          }
          // Surface any piper warnings even on success — historically the
          // "buzz of death" bugs leave a trail in stderr that's easy to
          // miss when synthesis returns bytes the renderer can't play.
          if (stderr.trim()) {
            log('info', 'system', `Piper stderr (success): ${stderr.trim().slice(0, 400)}`)
          }
          resolve(wav)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        } finally {
          // Always clean up the temp file — leaving them around would
          // accumulate fast with streaming TTS (one per sentence).
          void unlink(outPath).catch(() => {})
        }
      })()
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
