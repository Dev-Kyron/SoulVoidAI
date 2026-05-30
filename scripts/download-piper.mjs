/**
 * Fetches the Piper TTS binary and unpacks it into
 * `resources/piper/<platform>/`. Run via `npm run piper`.
 *
 * Default behaviour: downloads only the binary for the HOST machine's
 * platform/arch. This is what a developer wants for `npm run dev`.
 *
 * `--all-platforms`: fetches every supported (platform, arch) pair so
 * `electron-builder` can include cross-platform binaries in the
 * relevant per-target installers. Wired into `predist` in package.json
 * so `npm run dist` always produces installers with the right Piper
 * for the target OS.
 *
 * The binary set is the canonical 2023.11.14-2 release from rhasspy/piper —
 * subsequent piper releases moved to Python-only packaging, so this is
 * the most recent set of pre-built native binaries we can ship. Plenty
 * fast enough for sentence-by-sentence TTS and works fully offline.
 *
 * Output layout (Windows example):
 *   resources/piper/win32/piper/piper.exe
 *   resources/piper/win32/piper/*.dll            (espeak-ng, onnxruntime…)
 *   resources/piper/win32/piper/espeak-ng-data/  (phoneme tables)
 *
 * The whole `piper/` folder is what we ship — piper.exe links to the
 * adjacent DLLs and reads espeak-ng-data at startup.
 *
 * Re-run after a clean checkout (the resources/piper directory is in
 * .gitignore; we never commit the 30 MB binary blob).
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PIPER_VERSION = '2023.11.14-2'
const RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`

/**
 * Per-platform: which release asset to download, how to extract it, what
 * the resulting binary is called, and whether we need to chmod it +x.
 * The expectation is the archive contains a top-level `piper/` directory
 * with `piper(.exe)` + its dependencies inside — every official release
 * artefact for this version follows that convention.
 *
 * Keys are `${platform}-${arch}` strings. `platform` matches the values
 * `process.platform` returns at runtime ('win32', 'darwin', 'linux'), so
 * `resources/piper/<platform>/` lines up with what piper.ts reads.
 */
const PLATFORMS = {
  'win32-x64': { file: 'piper_windows_amd64.zip', exe: 'piper.exe', archive: 'zip' },
  'darwin-x64': { file: 'piper_macos_x64.tar.gz', exe: 'piper', archive: 'tar' },
  'darwin-arm64': { file: 'piper_macos_aarch64.tar.gz', exe: 'piper', archive: 'tar' },
  'linux-x64': { file: 'piper_linux_x86_64.tar.gz', exe: 'piper', archive: 'tar' },
  'linux-arm64': { file: 'piper_linux_aarch64.tar.gz', exe: 'piper', archive: 'tar' }
}

/**
 * Extract `archivePath` into `targetDir`. Uses native tools available on
 * the host machine — no third-party deps. We support cross-platform
 * downloads (a Windows dev machine fetching the mac tar.gz, etc.) so
 * both branches must work on every host.
 */
function extract(archivePath, targetDir, archiveKind) {
  if (archiveKind === 'tar') {
    // tar ships on every modern Windows (10+), every mac, every linux.
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' })
    return
  }
  // zip — prefer host-native tools. PowerShell on Windows, `unzip` elsewhere.
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${targetDir}' -Force"`,
      { stdio: 'inherit' }
    )
    return
  }
  // mac/linux extracting a Windows zip — `unzip` is on macOS by default
  // and on every linux distro that ships an installer.
  execSync(`unzip -o "${archivePath}" -d "${targetDir}"`, { stdio: 'inherit' })
}

/**
 * Fetch + unpack one platform spec. Idempotent on re-run (skips when
 * the binary already exists). Returns true on success, throws on
 * unrecoverable failure.
 */
async function fetchOne(key, spec) {
  // Strip the arch from the key for the output dir: resources/piper/win32/
  // (NOT resources/piper/win32-x64/) since piper.ts reads by platform.
  const [platform] = key.split('-')
  const targetDir = resolve(root, 'resources', 'piper', platform)
  mkdirSync(targetDir, { recursive: true })

  const binaryDir = join(targetDir, 'piper')
  const binaryPath = join(binaryDir, spec.exe)

  if (existsSync(binaryPath)) {
    const size = statSync(binaryPath).size
    console.log(
      `✓ ${key}: already installed at ${binaryPath} (${(size / 1024 / 1024).toFixed(1)} MB)`
    )
    return true
  }

  const url = `${RELEASE_BASE}/${spec.file}`
  const archivePath = join(targetDir, spec.file)

  console.log(`↓ ${key}: ${url}…`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download failed for ${key}: ${response.status} ${response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(archivePath, buffer)
  console.log(`  ✓ Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)

  console.log(`  Extracting…`)
  extract(archivePath, targetDir, spec.archive)

  // Tidy up: drop the archive once unpacked.
  try {
    unlinkSync(archivePath)
  } catch {
    /* not fatal — stray archives don't break anything */
  }

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Extraction succeeded for ${key} but binary missing at ${binaryPath}. Archive layout may have changed — files in target: ${readdirSync(targetDir).join(', ')}`
    )
  }

  // chmod +x on unix-y binaries — the tar.gz preserves permissions but
  // belt-and-suspenders never hurts, especially when the host doing the
  // extraction is Windows and might strip the executable bit.
  if (spec.exe === 'piper') {
    try {
      execSync(`chmod +x "${binaryPath}"`)
    } catch {
      // chmod doesn't exist on Windows — fine, the user's mac/linux
      // electron-builder run will set it when packaging.
    }
  }

  const finalSize = statSync(binaryPath).size
  console.log(`  ✓ ${key} ready (${(finalSize / 1024 / 1024).toFixed(1)} MB)`)
  return true
}

const allPlatforms = process.argv.includes('--all-platforms')

if (allPlatforms) {
  // Build-pipeline mode: fetch every platform so electron-builder has
  // binaries for every target installer. Errors on a single platform
  // are logged but don't fail the whole run — a developer building
  // only Windows installers shouldn't block on a flaky linux mirror.
  console.log(`Fetching Piper ${PIPER_VERSION} for all platforms…`)
  let failed = 0
  for (const [key, spec] of Object.entries(PLATFORMS)) {
    try {
      await fetchOne(key, spec)
    } catch (err) {
      console.warn(`⚠ ${key}: ${err instanceof Error ? err.message : String(err)}`)
      failed++
    }
  }
  if (failed > 0) {
    console.warn(
      `\n${failed} platform${failed === 1 ? '' : 's'} failed — the matching installers will ship without Piper.`
    )
    // Don't exit non-zero — the calling build pipeline can still produce
    // some platform installers. piper.ts surfaces "binary missing" as a
    // friendly Settings banner at runtime.
  } else {
    console.log(`\n✓ All ${Object.keys(PLATFORMS).length} platforms ready.`)
  }
} else {
  // Single-platform mode: fetch only the host's binary. This is the
  // default for `npm run piper` during dev — fast + no wasted bytes.
  const key = `${process.platform}-${process.arch}`
  const spec = PLATFORMS[key]
  if (!spec) {
    console.error(`✗ No Piper binary published for ${key}.`)
    console.error('  Supported: ' + Object.keys(PLATFORMS).join(', '))
    process.exit(1)
  }
  try {
    await fetchOne(key, spec)
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
