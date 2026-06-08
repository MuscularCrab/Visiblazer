import { hexToRgb, lerp3 } from '../color.js'

// Time-domain oscilloscope trace, built as a thick triangle-strip ribbon so the
// line has real width (GL line width is unreliable in core profiles).
export function build({ waveform, W, H, v }) {
  const wave = waveform && waveform.length > 1 ? waveform : new Float32Array([0, 0])
  const n = wave.length
  const amp = v.waveAmp
  const half = v.thickness
  const prim = hexToRgb(v.primary), sec = hexToRgb(v.secondary)
  const yAt = (i) => H / 2 - wave[Math.max(0, Math.min(n - 1, i))] * H * amp
  const data = new Float32Array(n * 12)
  let o = 0
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W
    const y = yAt(i)
    const xp = (Math.max(0, i - 1) / (n - 1)) * W, yp = yAt(i - 1)
    const xn = (Math.min(n - 1, i + 1) / (n - 1)) * W, yn = yAt(i + 1)
    let tx = xn - xp, ty = yn - yp
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L
    const nx = -ty, ny = tx
    const col = v.colorMode === 'solid' ? prim : lerp3(prim, sec, i / (n - 1))
    data[o++] = x + nx * half; data[o++] = y + ny * half; data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = 1
    data[o++] = x - nx * half; data[o++] = y - ny * half; data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = 1
  }
  return { data, count: n * 2, mode: 'TRIANGLE_STRIP' }
}
