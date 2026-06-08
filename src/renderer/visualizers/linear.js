import { hexToRgb, lerp3, hsl } from '../color.js'

// Classic bottom-anchored spectrum bars. Mirror -> centered vertical symmetry.
export function build({ bands, W, H, v }) {
  const n = bands.length
  const slotW = W / n
  const bw = slotW * v.barWidth
  const frac = v.barLen
  const prim = hexToRgb(v.primary), sec = hexToRgb(v.secondary)
  const data = new Float32Array(n * 36)
  let o = 0
  for (let i = 0; i < n; i++) {
    const amp = bands[i]
    const x0 = i * slotW + (slotW - bw) / 2, x1 = x0 + bw
    let col
    if (v.colorMode === 'hue') col = hsl(((i / n) * v.hueSpread + v.hueBase) % 1, 0.9, 0.55)
    else if (v.colorMode === 'solid') col = prim
    else col = lerp3(prim, sec, i / (n - 1 || 1))
    const br = 0.55 + 0.45 * amp
    const r = col[0] * br, g = col[1] * br, b = col[2] * br
    let yTop, yBot
    if (v.mirror) { const h = amp * H * frac * 0.5; yTop = H / 2 - h; yBot = H / 2 + h }
    else { const h = amp * H * frac; yTop = H - h; yBot = H }
    o = quad(data, o, x0, yTop, x1, yBot, r, g, b)
  }
  return { data, count: n * 6, mode: 'TRIANGLES' }
}

function quad(d, o, x0, y0, x1, y1, r, g, b) {
  const p = [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]
  for (let i = 0; i < 6; i++) { d[o++] = p[i * 2]; d[o++] = p[i * 2 + 1]; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = 1 }
  return o
}
