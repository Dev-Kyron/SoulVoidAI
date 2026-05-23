/**
 * Fetches the Piper TTS binary for the current platform and unpacks it
 * into `resources/piper/<platform>/`. Run via `npm run piper`.
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
 */
const PLATFORMS = {
  'win32-x64': { file: 'piper_windows_amd64.zip', exe: 'piper.exe', archive: 'zip' },
  'darwin-x64': { file: 'piper_macos_x64.tar.gz', exe: 'piper', archive: 'tar' },
  'darwin-arm64': { file: 'piper_macos_aarch64.tar.gz', exe: 'piper', archive: 'tar' },
  'linux-x64': { file: 'piper_linux_x86_64.tar.gz', exe: 'piper', archive: 'tar' },
  'linux-arm64': { file: 'piper_linux_aarch64.tar.gz', exe: 'piper', archive: 'tar' }
}

const key = `${process.platform}-${process.arch}`
const spec = PLATFORMS[key]
if (!spec) {
  console.error(`✗ No Piper binary published for ${key}.`)
  console.error('  Supported: ' + Object.keys(PLATFORMS).join(', '))
  process.exit(1)
}

const targetDir = resolve(root, 'resources', 'piper', process.platform)
mkdirSync(targetDir, { recursive: true })

const binaryDir = join(targetDir, 'piper')
const binaryPath = join(binaryDir, spec.exe)

// Idempotent — skip the network round-trip if we already have a binary
// from a previous run. Re-fetch by deleting resources/piper first.
if (existsSync(binaryPath)) {
  const size = statSync(binaryPath).size
  console.log(`✓ Piper already installed at ${binaryPath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  process.exit(0)
}

const url = `${RELEASE_BASE}/${spec.file}`
const archivePath = join(targetDir, spec.file)

console.log(`Downloading ${url}…`)
const response = await fetch(url)
if (!response.ok) {
  console.error(`✗ Download failed: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const buffer = Buffer.from(await response.arrayBuffer())
await writeFile(archivePath, buffer)
console.log(`  ✓ Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)

// Extract. Shell out to native tools — no third-party deps, and the
// archive formats are platform-specific anyway. PowerShell ships on
// every Windows 10/11; tar ships everywhere else (including modern
// Windows since the WSL/Cygwin merger).
console.log(`Extracting…`)
if (spec.archive === 'zip') {
  // -Force overwrites if the target dir exists from a partial prior run.
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${targetDir}' -Force"`,
    { stdio: 'inherit' }
  )
} else {
  execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' })
}

// Tidy up: drop the archive once unpacked.
try {
  unlinkSync(archivePath)
} catch {
  /* not fatal — `npm run piper` is dev-only, a stray .zip won't break anything */
}

if (!existsSync(binaryPath)) {
  console.error(`✗ Extraction succeeded but binary missing at ${binaryPath}.`)
  console.error('  Archive layout may have changed — inspect:')
  console.error('  ' + readdirSync(targetDir).join('  '))
  process.exit(1)
}

// chmod +x on unix-y systems — the tar.gz preserves permissions but
// belt-and-suspenders never hurts.
if (process.platform !== 'win32') {
  execSync(`chmod +x "${binaryPath}"`)
}

const finalSize = statSync(binaryPath).size
console.log(`✓ Piper ready at ${binaryPath} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`)
console.log(`  Bundle layout: ${readdirSync(binaryDir).length} files in resources/piper/${process.platform}/piper/`)
