'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { fft } = require('./fft')
const Bands = require('../src/shared/bands.js')

const SR = 48000          // fixed analysis rate -> exactly 800 samples/frame at 60fps
const SPF = SR / 60       // 800
const WAVE_N = 2048       // window used for the oscilloscope trace

function tail(s, n = 12) { return (s || '').trim().split(/\r?\n/).slice(-n).join('\n') }

function runProbeDuration(ffprobePath, input) {
  if (!ffprobePath) return null
  const { spawnSync } = require('child_process')
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input], { encoding: 'utf8', windowsHide: true })
  const d = parseFloat((r.stdout || '').trim())
  return isFinite(d) ? d : null
}

// Decode any supported input to mono s16le @ 48k. One pass, then we index into
// the temp file per frame (bounded memory even for a 2.5hr set).
function decode(ffmpegPath, input, outPcm, totalDur, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-ac', '1', '-ar', String(SR), '-f', 's16le', outPcm]
    const p = spawn(ffmpegPath, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => {
      const s = d.toString()
      err = (err + s).slice(-4000)
      const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (m && totalDur && onProgress) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
        onProgress(Math.min(1, t / totalDur))
      }
    })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('Audio decode failed:\n' + tail(err))))
  })
}

class Analysis {
  constructor(fd, pcmPath, sampleCount) {
    this.fd = fd
    this.pcmPath = pcmPath
    this.sampleCount = sampleCount
    this.sampleRate = SR
    this.duration = sampleCount / SR
    this.totalFrames = Math.max(1, Math.round(this.duration * 60))
    this._N = 0
  }

  _ensure(N) {
    if (this._N === N) return
    this._N = N
    this.re = new Float64Array(N)
    this.im = new Float64Array(N)
    this.db = new Float32Array(N >> 1)
    this.raw = new Float32Array(N)
    this.hann = new Float32Array(N)
    for (let i = 0; i < N; i++) this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)))
    this._buf = Buffer.allocUnsafe(Math.max(N, WAVE_N) * 2)
    this.wave = new Float32Array(WAVE_N)
  }

  // Fill dst[0..N) with raw float samples starting at sample `start`, zero-padded.
  _read(start, N, dst) {
    const buf = this._buf
    buf.fill(0, 0, N * 2)
    const vf = Math.max(0, start), vt = Math.min(this.sampleCount, start + N)
    if (vt > vf) fs.readSync(this.fd, buf, (vf - start) * 2, (vt - vf) * 2, vf * 2)
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, N)
    for (let i = 0; i < N; i++) dst[i] = i16[i] / 32768
  }

  // Frame n -> smoothed bands (0..1), bass, optional waveform. `prev` carries
  // temporal smoothing across frames; pass the returned bands back in next call.
  frame(n, ap, prev, wantWave) {
    const N = ap.fftSize
    this._ensure(N)
    const center = n * SPF + (SPF >> 1)
    this._read(center - (N >> 1), N, this.raw)
    const re = this.re, im = this.im, hann = this.hann
    for (let i = 0; i < N; i++) { re[i] = this.raw[i] * hann[i]; im[i] = 0 }
    fft(re, im, N)
    const half = N >> 1, db = this.db
    for (let k = 0; k < half; k++) {
      const m = Math.hypot(re[k], im[k]) / N
      db[k] = 20 * Math.log10(m + 1e-9)
    }
    const cur = Bands.reduce((k) => db[k], half, SR / 2, ap)
    let bands
    if (prev && prev.length === cur.length) bands = Bands.smooth(cur, prev, ap.smoothing)
    else bands = cur
    let waveform = null
    if (wantWave) {
      this._read(center - (WAVE_N >> 1), WAVE_N, this.wave)
      waveform = this.wave
    }
    return { bands, bass: Bands.bass(bands), waveform }
  }

  close() {
    try { fs.closeSync(this.fd) } catch {}
    try { fs.unlinkSync(this.pcmPath) } catch {}
  }
}

async function open(ffmpegPath, ffprobePath, input, tmpDir, onProgress) {
  fs.mkdirSync(tmpDir, { recursive: true })
  const outPcm = path.join(tmpDir, 'analysis.pcm')
  const dur = runProbeDuration(ffprobePath, input)
  await decode(ffmpegPath, input, outPcm, dur, onProgress)
  const sampleCount = Math.floor(fs.statSync(outPcm).size / 2)
  if (sampleCount < SPF) throw new Error('Decoded audio is empty or too short.')
  const fd = fs.openSync(outPcm, 'r')
  return new Analysis(fd, outPcm, sampleCount)
}

module.exports = { open, SR, SPF }
