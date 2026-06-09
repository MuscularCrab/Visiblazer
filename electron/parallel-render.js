'use strict'

// Segment-parallel renderer. Splits the timeline into K contiguous chunks and
// renders each in its own child *process* — a separate Electron instance with
// its own main thread, its own Chromium GPU process, and its own ffmpeg/NVENC.
// That's the key: in-process windows all funnel back through one shared main
// thread and one shared GPU process, so they don't scale. Separate processes do.
// The parent decodes the audio once; children reuse that PCM (no re-decode),
// stream progress over stdout, and the parent stitches the segments losslessly
// and muxes the audio at the end.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { spawn } = require('child_process')
const { buildConcatArgs, spawnRender } = require('./ffmpeg')

const WARMUP = 20   // smoothing frames primed before each segment (seam continuity)

class ParallelRender {
  constructor(analysis, opts, hooks, cfg) {
    this.analysis = analysis
    this.opts = opts
    this.hooks = hooks || {}
    this.concurrency = Math.max(1, cfg.concurrency | 0)
    this.tmpDir = cfg.tmpDir
    this.cancelled = false
    this.children = []
  }

  cancel() {
    this.cancelled = true
    for (const c of this.children) { try { c && c.kill() } catch {} }
  }

  async run() {
    const o = this.opts, fps = o.fps
    const startSec = o.startSec || 0
    const durSec = o.durSec || (this.analysis.duration - startSec)
    const totalFrames = Math.round(durSec * fps)
    const startFrame = Math.round(startSec * fps)
    // Never make a segment shorter than ~1s; clamp K accordingly.
    const K = Math.max(1, Math.min(this.concurrency, Math.floor(totalFrames / fps) || 1))
    const t0 = Date.now()

    // Contiguous frame ranges; spread the remainder over the first segments.
    const base = Math.floor(totalFrames / K), rem = totalFrames % K
    const segs = []
    for (let i = 0, f = 0; i < K; i++) {
      const len = base + (i < rem ? 1 : 0)
      segs.push({ idx: i, startFrame: startFrame + f, frames: len })
      f += len
    }
    const tag = (i) => String(i).padStart(3, '0')
    const segPaths = segs.map((s) => path.join(this.tmpDir, `seg_${tag(s.idx)}.mp4`))

    // Aggregate per-segment progress into one fps/ETA across all workers.
    const done = new Array(K).fill(0)
    const report = () => {
      const d = done.reduce((a, b) => a + b, 0)
      const el = (Date.now() - t0) / 1000
      const f = el > 0 ? d / el : 0
      this.hooks.onProgress && this.hooks.onProgress({
        done: d, total: totalFrames, fps: f, eta: f > 0 ? (totalFrames - d) / f : 0, elapsed: el, workers: K
      })
    }

    fs.mkdirSync(this.tmpDir, { recursive: true })

    // In dev (`electron .`) the app path must be passed as argv; a packaged exe
    // loads its own app, so argv stays empty.
    const electronExe = process.execPath
    const appArgs = app.isPackaged ? [] : [app.getAppPath()]

    const runChild = (s, i) => new Promise((resolve, reject) => {
      const segOpts = {
        ...o,
        startSec: s.startFrame / fps,
        durSec: s.frames / fps,
        outPath: segPaths[i],
        videoOnly: true,
        warmupFrames: s.idx === 0 ? 0 : WARMUP
      }
      const cfgPath = path.join(this.tmpDir, `seg_${tag(s.idx)}.json`)
      fs.writeFileSync(cfgPath, JSON.stringify({
        pcmPath: this.analysis.pcmPath, sampleCount: this.analysis.sampleCount, opts: segOpts
      }))
      const child = spawn(electronExe, appArgs, {
        env: { ...process.env, VISIBLAZER_SEG: cfgPath, VISIBLAZER_HW: '1', VISIBLAZER_PARALLEL: '' },
        windowsHide: true
      })
      this.children[i] = child
      let out = '', err = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
        let nl
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl); out = out.slice(nl + 1)
          if (line.startsWith('PROGRESS ')) { done[i] = Number(line.slice(9)) || done[i]; report() }
        }
      })
      child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000) })
      child.on('error', reject)
      child.on('close', (code) => {
        try { fs.unlinkSync(cfgPath) } catch {}
        if (this.cancelled) return resolve({ cancelled: true })
        if (code === 0) { done[i] = s.frames; report(); return resolve({ ok: true }) }
        reject(new Error(`segment ${i} exited ${code}\n` + err.split(/\r?\n/).slice(-12).join('\n')))
      })
    })

    let results
    try {
      results = await Promise.all(segs.map(runChild))
    } catch (e) {
      this.cancel(); this._cleanup(segPaths); throw e
    }
    if (this.cancelled || results.some((r) => r && r.cancelled)) {
      this._cleanup(segPaths); return { cancelled: true }
    }

    // Lossless concat + audio mux.
    const listFile = path.join(this.tmpDir, 'concat.txt')
    fs.writeFileSync(listFile, segPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
    await this._concat(o.ffmpegPath, buildConcatArgs({
      listFile, audioPath: o.audioPath, startSec, durSec, audioBitrateK: o.audioBitrateK, outPath: o.outPath
    }))

    this._cleanup(segPaths, listFile)
    const size = (() => { try { return fs.statSync(o.outPath).size } catch { return 0 } })()
    return { cancelled: false, outPath: o.outPath, bytes: size, frames: totalFrames, elapsed: (Date.now() - t0) / 1000, encoder: o.encoder, workers: K }
  }

  _concat(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
      const ff = spawnRender(ffmpegPath, args)
      let err = ''
      ff.stderr.on('data', (d) => { err = (err + d.toString()).slice(-6000) })
      ff.on('error', reject)
      ff.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error('concat/mux ffmpeg exited ' + code + '\n' + err.split(/\r?\n/).slice(-12).join('\n'))))
      try { ff.stdin.end() } catch {}   // concat reads files, not stdin
    })
  }

  _cleanup(segPaths, listFile) {
    for (const p of segPaths || []) { try { fs.unlinkSync(p) } catch {} }
    if (listFile) { try { fs.unlinkSync(listFile) } catch {} }
  }
}

module.exports = { ParallelRender }
