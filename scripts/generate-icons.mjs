/**
 * Generates the VoidSoul Assistant orb icons (app icon + tray icon) as PNG
 * files plus a multi-resolution Windows ICO using a minimal,
 * dependency-free encoder pair. Run via `npm run icons`.
 *
 * Output:
 *   build/icon.ico      multi-res (16,24,32,48,64,128,256) — installer + EXE
 *   build/icon.png      512x512  - packaging icon (mac/linux + fallback)
 *   resources/icon.png  256x256  - runtime window icon
 *   resources/tray.png   32x32   - system tray icon
 *
 * Why ICO matters: electron-builder embeds the Windows EXE icon and Start
 * Menu / Desktop shortcut icons from a .ico file. Pointing it at a .png
 * leaves those shortcuts showing the generic Electron logo — which is
 * exactly what beta testers reported on installed builds.
 */
import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---- minimal PNG encoder (RGBA, 8-bit) ---- */
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour + alpha
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/* ---- orb rasteriser ---- */
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
const lerp = (a, b, t) => a + (b - a) * t

function drawOrb(size) {
  const buf = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const core = size * 0.40
  const glow = size * 0.49
  const inner = [150, 235, 255] // luminous cyan
  const mid = [124, 58, 237] // violet
  const edge = [217, 70, 239] // magenta

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      const i = (y * size + x) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      if (d <= core) {
        const t = d / core
        if (t < 0.55) {
          const u = t / 0.55
          r = lerp(inner[0], mid[0], u)
          g = lerp(inner[1], mid[1], u)
          b = lerp(inner[2], mid[2], u)
        } else {
          const u = (t - 0.55) / 0.45
          r = lerp(mid[0], edge[0], u)
          g = lerp(mid[1], edge[1], u)
          b = lerp(mid[2], edge[2], u)
        }
        // soft specular highlight, upper-left
        const hx = (x - size * 0.38) / (size * 0.22)
        const hy = (y - size * 0.36) / (size * 0.22)
        const h = Math.max(0, 1 - (hx * hx + hy * hy))
        r += h * 90
        g += h * 90
        b += h * 90
        a = t > 0.93 ? 255 * (1 - (t - 0.93) / 0.07) : 255
      } else if (d <= glow) {
        const t = (d - core) / (glow - core)
        r = edge[0]
        g = edge[1]
        b = edge[2]
        a = 150 * (1 - t)
      }

      buf[i] = clamp(r)
      buf[i + 1] = clamp(g)
      buf[i + 2] = clamp(b)
      buf[i + 3] = clamp(a)
    }
  }
  return buf
}

function write(relPath, size) {
  const full = resolve(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, encodePNG(size, drawOrb(size)))
  console.log(`  ✓ ${relPath} (${size}x${size})`)
}

/* ---- minimal ICO encoder ------------------------------------------------
 * ICO is a tiny directory that points to one image payload per entry. Each
 * payload can be a BMP or — since Vista — a PNG, which is what we use so
 * the 256×256 entry doesn't bloat the file. Windows reads the directory
 * and picks whichever size best matches the surface it's painting (taskbar,
 * Start Menu, Alt-Tab, file-Explorer thumbnail).
 *
 * Layout: ICONDIR(6) | ICONDIRENTRY*N(16 each) | imageData*N
 * For 256×256 the width/height bytes are stored as 0 (per spec).
 */
function encodeICO(sizes) {
  const images = sizes.map((size) => encodePNG(size, drawOrb(size)))
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // image type: 1 = icon
  dir.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  images.forEach((png, i) => {
    const size = sizes[i]
    const e = i * 16
    entries[e + 0] = size >= 256 ? 0 : size // width
    entries[e + 1] = size >= 256 ? 0 : size // height
    entries[e + 2] = 0 // no colour palette
    entries[e + 3] = 0 // reserved
    entries.writeUInt16LE(1, e + 4) // colour planes
    entries.writeUInt16LE(32, e + 6) // bits per pixel
    entries.writeUInt32LE(png.length, e + 8) // image data size
    entries.writeUInt32LE(offset, e + 12) // image data offset
    offset += png.length
  })

  return Buffer.concat([dir, entries, ...images])
}

function writeICO(relPath, sizes) {
  const full = resolve(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, encodeICO(sizes))
  console.log(`  ✓ ${relPath} (${sizes.join(',')})`)
}

console.log('Generating VoidSoul orb icons…')
writeICO('build/icon.ico', [16, 24, 32, 48, 64, 128, 256])
write('build/icon.png', 512)
write('resources/icon.png', 256)
write('resources/tray.png', 32)
console.log('Done.')
