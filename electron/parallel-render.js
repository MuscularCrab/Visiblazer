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
const { buildAudioArgs, buildConcatArgs, spawnRender } = require('./ffmpeg')

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
    try { this._audioProc && this._audioProc.kill() } catch {}
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

    // Encode the audio concurrently with the segment renders so the final concat
    // is a pure remux with no audio pass on the tail. Resolve to the error (not
    // reject) so an early cancel can't leave an unhandled rejection.
    const audioFile = path.join(this.tmpDir, 'audio.m4a')
    const audioP = this._encodeAudio(o.ffmpegPath, buildAudioArgs({
      audioPath: o.audioPath, startSec, durSec, audioBitrateK: o.audioBitrateK, outPath: audioFile
    })).then(() => null, (e) => e)

    // Copy user image assets (logo, bg image) into the local temp dir and point
    // the workers at the copies. The picked path may be on a mapped/network drive
    // the spawned workers can't reach even though the main process can — the
    // "logo shows in preview but not the full render" cause.
    const localVisual = this._localizeAssets(o.visual)

    // In dev (`electron .`) the app path must be passed as argv; a packaged exe
    // loads its own app, so argv stays empty.
    const electronExe = process.execPath
    const appArgs = app.isPackaged ? [] : [app.getAppPath()]

    const runChild = (s, i) => new Promise((resolve, reject) => {
      const segOpts = {
        ...o,
        visual: localVisual,
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
      this._cleanup(segPaths, null, audioFile); return { cancelled: true }
    }

    // Audio finished encoding during the renders, so concat is a pure remux —
    // the only finalize cost is sequential I/O, reported as a 'finalize' phase.
    const audioErr = await audioP
    if (audioErr) { this._cleanup(segPaths, null, audioFile); throw audioErr }
    const listFile = path.join(this.tmpDir, 'concat.txt')
    fs.writeFileSync(listFile, segPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
    await this._concat(o.ffmpegPath, buildConcatArgs({ listFile, audioFile, outPath: o.outPath }), durSec)

    this._cleanup(segPaths, listFile, audioFile)
    const size = (() => { try { return fs.statSync(o.outPath).size } catch { return 0 } })()
    return { cancelled: false, outPath: o.outPath, bytes: size, frames: totalFrames, elapsed: (Date.now() - t0) / 1000, encoder: o.encoder, workers: K }
  }

  _concat(ffmpegPath, args, totalSec) {
    const finStart = Date.now()
    return new Promise((resolve, reject) => {
      const ff = spawnRender(ffmpegPath, args)
      let err = ''
      ff.stderr.on('data', (d) => {
        const s = d.toString(); err = (err + s).slice(-6000)
        // Remux is fast but not instant on a long set; surface it as a finalize
        // phase so the UI shows progress instead of a frozen ETA 0:00.
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s)
        if (m && totalSec > 0 && this.hooks.onProgress) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
          const frac = Math.min(1, t / totalSec)
          const el = (Date.now() - finStart) / 1000
          const rate = frac > 0 ? frac / el : 0
          this.hooks.onProgress({ phase: 'finalize', frac, eta: rate > 0 ? (1 - frac) / rate : 0 })
        }
      })
      ff.on('error', reject)
      ff.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error('concat/mux ffmpeg exited ' + code + '\n' + err.split(/\r?\n/).slice(-12).join('\n'))))
      try { ff.stdin.end() } catch {}   // concat reads files, not stdin
    })
  }

  _encodeAudio(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
      const ff = spawnRender(ffmpegPath, args)
      this._audioProc = ff
      let err = ''
      ff.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000) })
      ff.on('error', reject)
      ff.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error('audio encode exited ' + code + '\n' + err.split(/\r?\n/).slice(-8).join('\n'))))
      try { ff.stdin.end() } catch {}
    })
  }

  // Copy logo/bg-image to local temp so workers never depend on the source drive
  // (mapped/network/removable). Falls back to the original path if a copy fails
  // (e.g. the main process can't read it either) so nothing regresses.
  _localizeAssets(visual) {
    this._assetFiles = []
    const v = JSON.parse(JSON.stringify(visual || {}))
    const localize = (src, name) => {
      if (!src) return src
      try {
        const dst = path.join(this.tmpDir, name + (path.extname(src) || '.png'))
        fs.copyFileSync(src, dst)
        this._assetFiles.push(dst)
        return dst
      } catch (e) {
        console.error(`Visiblazer: could not stage asset "${src}" locally (${e && e.message || e}); workers will use the original path`)
        return src
      }
    }
    if (v.logo) v.logo.path = localize(v.logo.path, 'asset_logo')
    if (v.background && v.background.type === 'image') v.background.image = localize(v.background.image, 'asset_bg')
    return v
  }

  _cleanup(segPaths, listFile, audioFile) {
    for (const p of segPaths || []) { try { fs.unlinkSync(p) } catch {} }
    if (listFile) { try { fs.unlinkSync(listFile) } catch {} }
    if (audioFile) { try { fs.unlinkSync(audioFile) } catch {} }
    for (const p of this._assetFiles || []) { try { fs.unlinkSync(p) } catch {} }
  }
}

module.exports = { ParallelRender }
