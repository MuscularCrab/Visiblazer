import { hexToRgb, lerp3, hsl } from '../color.js'

// Bars radiate from a center ring. With mirror on, the spectrum is duplicated
// to a symmetric ring (NCS-style). Geometry is rebuilt each frame on the CPU —
// ~a few hundred verts, negligible next to readPixels/encode.
export function build({ bands, W, H, time, v }) {
  const n = bands.length
  const slots = v.mirror ? n * 2 : n
  const cx = W / 2, cy = H / 2, minDim = Math.min(W, H)
  const innerR = v.radius * minDim
  const maxLen = v.barLen * minDim * 0.35   // keep bars inside the frame at full amplitude
  const step = (2 * Math.PI) / slots
  const halfW = step * 0.5 * v.barWidth
  const rot = time * v.rotationSpeed * Math.PI * 2 + v.rotationOffset
  const prim = hexToRgb(v.primary), sec = hexToRgb(v.secondary)
  const data = new Float32Array(slots * 36)
  let o = 0
  for (let i = 0; i < slots; i++) {
    const bi = v.mirror ? (i < n ? i : slots - 1 - i) : i
    const amp = bands[bi]
    const a = i * step + rot
    const r0 = innerR, r1 = innerR + amp * maxLen
    let col
    if (v.colorMode === 'hue') col = hsl(((bi / n) * v.hueSpread + v.hueBase) % 1, 0.9, 0.55)
    else if (v.colorMode === 'solid') col = prim
    else col = lerp3(prim, sec, bi / (n - 1 || 1))
    const br = 0.5 + 0.5 * amp
    const cr = col[0] * br, cg = col[1] * br, cb = col[2] * br
    const a0 = a - halfW, a1 = a + halfW
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
    const x00 = cx + c0 * r0, y00 = cy + s0 * r0
    const x10 = cx + c1 * r0, y10 = cy + s1 * r0
    const x11 = cx + c1 * r1, y11 = cy + s1 * r1
    const x01 = cx + c0 * r1, y01 = cy + s0 * r1
    o = tri(data, o, x00, y00, x10, y10, x11, y11, cr, cg, cb)
    o = tri(data, o, x00, y00, x11, y11, x01, y01, cr, cg, cb)
  }
  return { data, count: slots * 6, mode: 'TRIANGLES' }
}

function tri(d, o, ax, ay, bx, by, cx, cy, r, g, b) {
  d[o++] = ax; d[o++] = ay; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = 1
  d[o++] = bx; d[o++] = by; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = 1
  d[o++] = cx; d[o++] = cy; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = 1
  return o
}
