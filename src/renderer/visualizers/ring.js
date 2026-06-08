import { hexToRgb, lerp3, hsl } from '../color.js'

// Minimalist polar oscilloscope: the time-domain waveform wrapped into a closed
// ring around the center. A single breathing line — pairs with a center logo.
export function build({ waveform, W, H, time, v }) {
  const wave = waveform && waveform.length > 1 ? waveform : new Float32Array([0, 0])
  const n = wave.length
  const cx = W / 2, cy = H / 2, minDim = Math.min(W, H)
  const baseR = v.radius * minDim
  const amp = v.waveAmp * minDim * 0.5
  const half = v.thickness
  const rot = time * v.rotationSpeed * Math.PI * 2 + v.rotationOffset
  const prim = hexToRgb(v.primary), sec = hexToRgb(v.secondary)
  const N = n + 1                               // repeat first point to close the loop
  const data = new Float32Array(N * 2 * 6)
  let o = 0
  for (let i = 0; i < N; i++) {
    const idx = i % n
    const a = (idx / n) * Math.PI * 2 + rot
    const r = baseR + wave[idx] * amp
    const ca = Math.cos(a), sa = Math.sin(a)
    let col
    if (v.colorMode === 'hue') col = hsl(((idx / n) * v.hueSpread + v.hueBase) % 1, 0.9, 0.6)
    else if (v.colorMode === 'solid') col = prim
    else col = lerp3(prim, sec, idx / (n - 1))
    data[o++] = cx + ca * (r + half); data[o++] = cy + sa * (r + half); data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = 1
    data[o++] = cx + ca * (r - half); data[o++] = cy + sa * (r - half); data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = 1
  }
  return { data, count: N * 2, mode: 'TRIANGLE_STRIP' }
}
