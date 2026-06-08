// Shared band reduction + temporal smoothing. Loaded by the renderer (preview,
// via AnalyserNode dB data) and by the main process (offline render, via FFT).
// UMD so the exact same look applies on both sides. Keep dependency-free.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory()
  else root.Bands = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // Reduce a per-bin magnitude-in-dB array to `barCount` log-spaced bands in 0..1.
  // dbAt(k) returns the dB value for bin k (0..binCount-1). nyquist in Hz.
  function reduce(dbAt, binCount, nyquist, p) {
    const barCount = p.barCount
    const fmin = 30
    const fmax = Math.min(16000, nyquist)
    const minDb = p.minDb, maxDb = p.maxDb, range = maxDb - minDb
    const out = new Float32Array(barCount)
    for (let b = 0; b < barCount; b++) {
      const f0 = fmin * Math.pow(fmax / fmin, b / barCount)
      const f1 = fmin * Math.pow(fmax / fmin, (b + 1) / barCount)
      let k0 = Math.max(1, Math.floor((f0 / nyquist) * binCount))
      let k1 = Math.min(binCount, Math.max(k0 + 1, Math.ceil((f1 / nyquist) * binCount)))
      let peak = -Infinity
      for (let k = k0; k < k1; k++) { const d = dbAt(k); if (d > peak) peak = d }
      let v = (peak - minDb) / range
      if (v < 0) v = 0; else if (v > 1) v = 1
      out[b] = Math.pow(v, 1.0) * p.gain
      if (out[b] > 1) out[b] = 1
    }
    return out
  }

  // Asymmetric smoothing: quick attack, slower release (release grows with the
  // `smoothing` control). prev is mutated and returned.
  function smooth(cur, prev, smoothing) {
    const attack = 0.6
    const release = 0.04 + 0.30 * (1 - smoothing)
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i], p = prev[i]
      prev[i] = c > p ? p + (c - p) * attack : p + (c - p) * release
    }
    return prev
  }

  function bass(bands) {
    const n = Math.max(1, Math.min(4, bands.length))
    let s = 0
    for (let i = 0; i < n; i++) s += bands[i]
    return s / n
  }

  return { reduce, smooth, bass }
})
