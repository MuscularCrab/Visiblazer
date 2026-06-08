import { hexToRgb, lerp3, hsl } from '../color.js'

// Minimalist dot ring: one dot per band on a circle, pushed outward and grown by
// its level. Sparse and calm — let glow soften the dots and the space breathe.
export function build({ bands, W, H, time, v }) {
  const n = bands.length
  const cx = W / 2, cy = H / 2, minDim = Math.min(W, H)
  const baseR = v.radius * minDim
  const push = v.barLen * minDim * 0.3
  const rot = time * v.rotationSpeed * Math.PI * 2 + v.rotationOffset
  const slots = v.mirror ? n * 2 : n
  const dot = minDim * 0.012 * (0.5 + v.barWidth)
  const prim = hexToRgb(v.primary), sec = hexToRgb(v.secondary)
  const data = new Float32Array(slots * 36)
  let o = 0
  for (let i = 0; i < slots; i++) {
    const bi = v.mirror ? (i < n ? i : slots - 1 - i) : i
    const amp = bands[bi]
    const a = (i / slots) * Math.PI * 2 + rot
    const r = baseR + amp * push
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
    const s = dot * (0.35 + amp)
    let col
    if (v.colorMode === 'hue') col = hsl(((bi / n) * v.hueSpread + v.hueBase) % 1, 0.9, 0.6)
    else if (v.colorMode === 'solid') col = prim
    else col = lerp3(prim, sec, bi / (n - 1 || 1))
    const br = 0.5 + 0.5 * amp
    o = quad(data, o, x - s, y - s, x + s, y + s, col[0] * br, col[1] * br, col[2] * br)
  }
  return { data, count: slots * 6, mode: 'TRIANGLES' }
}

function quad(d, o, x0, y0, x1, y1, r, g, b) {
  const p = [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]
  for (let i = 0; i < 6; i++) { d[o++] = p[i * 2]; d[o++] = p[i * 2 + 1]; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = 1 }
  return o
}
