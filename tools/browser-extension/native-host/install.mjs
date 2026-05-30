#!/usr/bin/env node
/**
 * Cross-platform installer for the Chrome native-messaging host manifest.
 *
 * Run from the project root:
 *
 *   node tools/browser-extension/native-host/install.mjs \
 *     --extension-id <chrome-extension-id> \
 *     [--browser chrome|edge|brave|arc]
 *
 * What it does:
 *   1. Resolves the absolute path to bridge.cjs (sibling file).
 *   2. Writes the per-OS native-host manifest pointing at bridge.cjs and
 *      whitelisting the given extension id.
 *   3. On Windows it ALSO writes the registry key Chrome reads
 *      (HKCU\Software\<Browser>\NativeMessagingHosts\dev.kyron.voidsoul).
 *
 * Why a Node script instead of OS-specific shell scripts: keeps the
 * install path identical on Mac/Linux/Windows and lets the desktop
 * Settings panel kick this off via `child_process.spawn` later if we
 * want a one-click install button — the script has no shell-isms a
 * Windows-only batch file would require.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* ----------------------------- argv parsing ---------------------------- */

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--extension-id' || flag === '--ext') {
      args.extensionId = argv[++i]
    } else if (flag === '--browser') {
      args.browser = argv[++i]
    } else if (flag === '--uninstall') {
      args.uninstall = true
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    } else if (!flag.startsWith('--')) {
      // Allow positional `--ext abc` shorthand: `install.mjs abc`
      if (!args.extensionId) args.extensionId = flag
    }
  }
  return args
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node install.mjs --extension-id <chrome-extension-id> [--browser chrome|edge|brave|arc]',
      '  node install.mjs --uninstall [--browser chrome|edge|brave|arc]',
      '',
      'The extension id appears in chrome://extensions when Developer mode is on,',
      'right under the extension name. Looks like: pjkljhegncpnkpknbcohdijeoejaedia',
      '',
      'Defaults to Chrome. Run once per Chromium-based browser the user wants',
      'to connect from — the manifest lives in a per-browser directory.'
    ].join('\n')
  )
}

/* ------------------------- per-OS manifest paths ----------------------- */

const HOST_NAME = 'dev.kyron.voidsoul'

/** Returns the file path where the JSON manifest needs to live for the
 *  given (platform, browser) pair. On Windows we return null — the
 *  manifest can live anywhere; the canonical record is the registry key. */
function manifestPath(browser) {
  const home = homedir()
  const plat = platform()
  if (plat === 'darwin') {
    const base = {
      chrome: 'Library/Application Support/Google/Chrome/NativeMessagingHosts',
      edge: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
      brave: 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      arc: 'Library/Application Support/Arc/User Data/NativeMessagingHosts'
    }[browser]
    if (!base) throw new Error(`Unknown browser: ${browser}`)
    return join(home, base, `${HOST_NAME}.json`)
  }
  if (plat === 'linux') {
    const base = {
      chrome: '.config/google-chrome/NativeMessagingHosts',
      edge: '.config/microsoft-edge/NativeMessagingHosts',
      brave: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      arc: '.config/arc/NativeMessagingHosts'
    }[browser]
    if (!base) throw new Error(`Unknown browser: ${browser}`)
    return join(home, base, `${HOST_NAME}.json`)
  }
  if (plat === 'win32') {
    // Put the manifest somewhere sensible alongside the script. The
    // registry key (written below) points Chrome at this file.
    return resolve(__dirname, `${HOST_NAME}.json`)
  }
  throw new Error(`Unsupported platform: ${plat}`)
}

/** Returns the registry key path (Windows-only). */
function windowsRegistryKey(browser) {
  const root = {
    chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    // Arc on Windows isn't shipped as of this writing; left here for
    // forward-compat with Arc Windows when it lands.
    arc: 'HKCU\\Software\\Arc\\NativeMessagingHosts'
  }[browser]
  if (!root) throw new Error(`Unknown browser: ${browser}`)
  return `${root}\\${HOST_NAME}`
}

/* ----------------------------- install flow ---------------------------- */

async function install(args) {
  const browser = args.browser || 'chrome'
  const extensionId = args.extensionId
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
    console.error(
      `Refusing to install: --extension-id is required and must be a 32-char a-p string ` +
        `(got ${JSON.stringify(extensionId)}). Find it in chrome://extensions with developer mode on.`
    )
    process.exit(1)
  }

  const bridgePath = resolve(__dirname, 'bridge.cjs')
  if (!existsSync(bridgePath)) {
    console.error(`Bridge script not found at ${bridgePath}. Reinstall VoidSoul and try again.`)
    process.exit(1)
  }

  // On Windows, Chrome doesn't execute .cjs directly; we need a small
  // batch shim that calls `node bridge.cjs`. Generate it next to the
  // bridge script if missing.
  //
  // The shim used to try a `%~dp0..\..\..\..\node.exe` path first to
  // pick up Electron's bundled Node, but that lands four levels OUTSIDE
  // the resources dir — Electron doesn't ship a standalone node.exe at
  // that location regardless of dev/prod, so the fallback to system
  // `node` was always doing the actual work. The bundled-exe attempt
  // also reliably triggered ERRORLEVEL 9009 noise that masked real
  // install failures. We just call system `node` directly — it has to
  // be on PATH for the install script to have run in the first place.
  let registeredScript = bridgePath
  if (platform() === 'win32') {
    const shim = resolve(__dirname, 'bridge.bat')
    if (!existsSync(shim)) {
      const shimBody = '@echo off\r\nnode "%~dp0bridge.cjs" %*\r\n'
      await writeFile(shim, shimBody, 'utf8')
    }
    registeredScript = shim
  } else {
    // Make sure the bridge is executable on Mac/Linux. The repo may
    // ship it without the bit set (Windows clones drop the +x).
    const { chmod } = await import('node:fs/promises')
    try {
      await chmod(bridgePath, 0o755)
    } catch {
      /* non-fatal */
    }
  }

  const templatePath = join(__dirname, 'host-manifest.template.json')
  const template = await readFile(templatePath, 'utf8')
  const manifest = template
    .replace('__BRIDGE_PATH__', registeredScript.replace(/\\/g, '\\\\'))
    .replace('__EXTENSION_ID__', extensionId)

  const outPath = manifestPath(browser)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, manifest, 'utf8')
  console.log(`Wrote native-host manifest → ${outPath}`)

  if (platform() === 'win32') {
    const key = windowsRegistryKey(browser)
    // `reg add` writes the manifest path as the default value of the
    // host key. Chrome reads this key on every native-messaging connect.
    const result = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', outPath, '/f'], {
      stdio: 'inherit'
    })
    if (result.status !== 0) {
      console.error(`reg add failed (${result.status}). Check Windows permissions.`)
      process.exit(result.status || 1)
    }
    console.log(`Registered ${key} → ${outPath}`)
  }

  console.log('\nInstalled. Restart your browser to pick up the new host.')
}

async function uninstall(args) {
  const browser = args.browser || 'chrome'
  const outPath = manifestPath(browser)
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(outPath)
    console.log(`Removed manifest → ${outPath}`)
  } catch {
    console.log(`No manifest at ${outPath} — already gone.`)
  }
  if (platform() === 'win32') {
    const key = windowsRegistryKey(browser)
    const result = spawnSync('reg', ['delete', key, '/f'], { stdio: 'inherit' })
    if (result.status === 0) console.log(`Deleted ${key}`)
  }
}

/* -------------------------------- main --------------------------------- */

const args = parseArgs(process.argv)
if (args.help) {
  printUsage()
  process.exit(0)
}
if (args.uninstall) {
  await uninstall(args)
} else {
  await install(args)
}
