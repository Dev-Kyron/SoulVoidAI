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

/* ---- BMP DIB encoder (for ICO small-size entries) -----------------------
 *
 * Earlier versions of this script packed PNG payloads for EVERY ICO entry
 * including 16/24/32. That works in Explorer / modern shells but the NSIS
 * installer's icon compiler + some shortcut-icon paths on Windows 10/11
 * still bail on PNG-in-ICO for small sizes — and silently fall back to
 * the generic Electron icon. v1.1.1 shipped with that ICO and beta testers
 * reported the icon STILL wasn't right after a fresh install.
 *
 * Fix: encode sizes ≤128 as BMP DIB (the format every Windows ICO loader
 * has supported since Win 3.0) and keep PNG only for 256×256 where BMP
 * would balloon to ~263 KB per entry. The directory entry doesn't need a
 * format flag — Windows sniffs it from the payload's magic bytes.
 *
 * BMP DIB inside ICO has two quirks vs a standalone .bmp:
 *  1. No file header (BITMAPFILEHEADER) — directly starts with DIB header
 *  2. biHeight is DOUBLED (XOR pixel mask + AND transparency mask stacked)
 * The AND mask is unused at 32 bpp (alpha channel handles transparency)
 * but Windows insists on its presence, all-zero is the right default.
 */
function encodeBMP(size, rgba) {
  // BITMAPINFOHEADER — 40 bytes, all little-endian
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)        // biSize
  header.writeInt32LE(size, 4)        // biWidth
  header.writeInt32LE(size * 2, 8)    // biHeight (doubled for ICO)
  header.writeUInt16LE(1, 12)         // biPlanes
  header.writeUInt16LE(32, 14)        // biBitCount (BGRA)
  header.writeUInt32LE(0, 16)         // biCompression = BI_RGB

  // XOR pixel data — BGRA, bottom-up rows. Source rgba is top-down,
  // so source row (size-1-y) lands at destination row y.
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4
      const d = (y * size + x) * 4
      xor[d]     = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s]     // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  // AND mask — 1 bit per pixel, row padded to 4 bytes. All-zero = opaque.
  // Required by the ICO spec even though the 32 bpp BGRA already carries
  // alpha; Windows reads the alpha channel and ignores the mask.
  const andStride = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(andStride * size)

  return Buffer.concat([header, xor, andMask])
}

/* ---- ICO container ------------------------------------------------------
 * Layout: ICONDIR(6) | ICONDIRENTRY*N(16 each) | imageData*N.
 * For 256×256 the width/height bytes are stored as 0 (per spec).
 */
function encodeICO(sizes) {
  const images = sizes.map((size) => {
    const rgba = drawOrb(size)
    // PNG only for 256 (BMP would be ~263 KB). BMP for everything smaller
    // because NSIS + older shell paths choke on PNG-in-ICO for small sizes.
    return size >= 256 ? encodePNG(size, rgba) : encodeBMP(size, rgba)
  })
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // image type: 1 = icon
  dir.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  images.forEach((payload, i) => {
    const size = sizes[i]
    const e = i * 16
    entries[e + 0] = size >= 256 ? 0 : size // width
    entries[e + 1] = size >= 256 ? 0 : size // height
    entries[e + 2] = 0 // no colour palette
    entries[e + 3] = 0 // reserved
    entries.writeUInt16LE(1, e + 4) // colour planes
    entries.writeUInt16LE(32, e + 6) // bits per pixel
    entries.writeUInt32LE(payload.length, e + 8) // image data size
    entries.writeUInt32LE(offset, e + 12) // image data offset
    offset += payload.length
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
