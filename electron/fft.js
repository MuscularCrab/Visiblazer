'use strict'

// Iterative radix-2 Cooley-Tukey FFT (real input -> complex spectrum).
// Tables (bit-reversal + twiddles) are cached per size because a single render
// runs one fftSize across hundreds of thousands of frames.
const cache = new Map()

function tables(n) {
  let t = cache.get(n)
  if (t) return t
  const rev = new Uint32Array(n)
  for (let i = 0, j = 0; i < n; i++) {
    rev[i] = j
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
  }
  const cos = new Float64Array(n >> 1)
  const sin = new Float64Array(n >> 1)
  for (let i = 0; i < (n >> 1); i++) {
    const a = (-2 * Math.PI * i) / n
    cos[i] = Math.cos(a)
    sin[i] = Math.sin(a)
  }
  t = { rev, cos, sin }
  cache.set(n, t)
  return t
}

// In-place transform. re/im are Float64Array(n); n must be a power of two.
function fft(re, im, n) {
  const { rev, cos, sin } = tables(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0, idx = 0; k < half; k++, idx += step) {
        const wr = cos[idx], wi = sin[idx]
        const a = i + k, b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
      }
    }
  }
}

module.exports = { fft }
