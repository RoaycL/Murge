// Generate the original brand application icon (PNG + multi-size ICO) with no
// image libraries. Pure Node: rasterize an abstract "routing M" mark with
// analytic anti-aliasing, encode PNG via node:zlib, and wrap multiple PNG sizes
// into an ICO container (Windows supports PNG-compressed 256px entries).
//
// The mark is deliberately original and abstract (rounded square + network-route
// "M" + accent node) so it never copies a vendor-owned logo. It is regenerable:
// run `node scripts/generate-icon.mjs` to recreate resources/icon.{png,ico}.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'resources')
mkdirSync(outDir, { recursive: true })

// ---- drawing -------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

const BG_TOP = [27, 37, 64] // #1b2540
const BG_BOTTOM = [51, 81, 127] // #33517f
const MARK = [232, 240, 255] // #e8f0ff
const ACCENT = [63, 214, 176] // #3fd6b0

// Distance from p to segment ab (for round-capped strokes).
function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const denom = abx * abx + aby * aby || 1
  let t = ((px - ax) * abx + (py - ay) * aby) / denom
  t = clamp(t, 0, 1)
  const x = ax + t * abx
  const y = ay + t * aby
  return Math.hypot(px - x, py - y)
}

/**
 * Composite the icon at `size`. Draws into an [r,g,b,a] buffer with a vertical
 * gradient background, a rounded-square mask, a round-cap "M" route in light,
 * and a small filled accent node at the vertex.
 */
function render(size) {
  const px = new Uint8ClampedArray(size * size * 4)
  const radius = size * 0.22
  const s = size // shorthand
  const inset = 0

  const M = [
    [0.30, 0.74],
    [0.30, 0.38],
    [0.50, 0.66],
    [0.70, 0.38],
    [0.70, 0.74]
  ].map(([x, y]) => [x * s, y * s])

  const strokeW = s * 0.085
  const aa = 1.25 // anti-alias band width in px, scaled by size is fine (analytic)
  const nodeR = s * 0.07
  const nodeCy = M[2][1]
  const nodeCx = M[2][0]

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4

      // Rounded-square signed distance (negative inside).
      const cx = x + 0.5 - s / 2
      const cy = y + 0.5 - s / 2
      const qx = Math.abs(cx) - (s / 2 - radius)
      const qy = Math.abs(cy) - (s / 2 - radius)
      const distOutside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      const boxA = smoothstep(-aa, aa, -distOutside)
      if (boxA <= 0) {
        px[i] = 0
        px[i + 1] = 0
        px[i + 2] = 0
        px[i + 3] = 0
        continue
      }

      // Vertical gradient background.
      const t = y / (s - 1)
      let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t
      let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t
      let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t

      // "M" route: light round-cap strokes.
      let mDist = Infinity
      for (let k = 0; k < M.length - 1; k++) {
        const d = distSeg(x + 0.5, y + 0.5, M[k][0], M[k][1], M[k + 1][0], M[k + 1][1])
        if (d < mDist) mDist = d
      }
      const mAlpha = 1 - smoothstep(strokeW - aa, strokeW + aa, mDist)
      r = r + (MARK[0] - r) * mAlpha
      g = g + (MARK[1] - g) * mAlpha
      b = b + (MARK[2] - b) * mAlpha

      // Accent node at the vertex (soft edge).
      const nd = Math.hypot(x + 0.5 - nodeCx, y + 0.5 - nodeCy)
      const nAlpha = 1 - smoothstep(nodeR - aa, nodeR + aa, nd)
      r = r + (ACCENT[0] - r) * nAlpha
      g = g + (ACCENT[1] - g) * nAlpha
      b = b + (ACCENT[2] - b) * nAlpha

      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = Math.round(255 * boxA)
    }
  }
  return px
}

// ---- PNG encoding --------------------------------------------------------

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (~c) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- PNG downscale (box filter) ------------------------------------------

function downscale(src, srcSize, dstSize) {
  const out = new Uint8ClampedArray(dstSize * dstSize * 4)
  const scale = srcSize / dstSize
  for (let y = 0; y < dstSize; y++) {
    const y0 = y * scale
    const y1 = (y + 1) * scale
    for (let x = 0; x < dstSize; x++) {
      const x0 = x * scale
      const x1 = (x + 1) * scale
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      const ys = Math.floor(y0)
      const ye = Math.max(ys + 1, Math.ceil(y1))
      const xs = Math.floor(x0)
      const xe = Math.max(xs + 1, Math.ceil(x1))
      for (let yy = ys; yy < ye && yy < srcSize; yy++) {
        for (let xx = xs; xx < xe && xx < srcSize; xx++) {
          const i = (yy * srcSize + xx) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          a += src[i + 3]
          count++
        }
      }
      const o = (y * dstSize + x) * 4
      out[o] = r / count
      out[o + 1] = g / count
      out[o + 2] = b / count
      out[o + 3] = a / count
    }
  }
  return out
}

// ---- ICO container -------------------------------------------------------

const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

function encodeICO(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  const blobs = []
  let offset = 6 + dir.length
  entries.forEach((entry, idx) => {
    const { size, png } = entry
    const base = idx * 16
    dir[base] = size >= 256 ? 0 : size // 0 means 256
    dir[base + 1] = size >= 256 ? 0 : size
    dir[base + 2] = 0 // color count
    dir[base + 3] = 0 // reserved
    dir.writeUInt16LE(1, base + 4) // planes
    dir.writeUInt16LE(32, base + 6) // bpp
    dir.writeUInt32LE(png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    blobs.push(png)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...blobs])
}

// ---- build ---------------------------------------------------------------

const master = render(512)
const masterPNG = encodePNG(master, 512)
writeFileSync(join(outDir, 'icon.png'), masterPNG)

const icoEntries = []
for (const size of ICO_SIZES) {
  let rgba = size === 512 ? master : downscale(master, 512, size)
  icoEntries.push({ size, png: encodePNG(rgba, size) })
}
writeFileSync(join(outDir, 'icon.ico'), encodeICO(icoEntries))

console.log(`wrote ${join(outDir, 'icon.png')} (512px) and ${join(outDir, 'icon.ico')} (${ICO_SIZES.join(',')})`)
