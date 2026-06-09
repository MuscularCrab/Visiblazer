'use strict'

const fs = require('fs')
const { MessageChannelMain } = require('electron')
const { buildArgs, spawnRender } = require('./ffmpeg')

function estimate(opts) {
  const dur = opts.durSec || opts.fullDuration
  const totalFrames = Math.round(dur * opts.fps)
  const estBytes = ((opts.bitrateK * 1000 + (opts.audioBitrateK || 320) * 1000) / 8) * dur
  return { encoder: opts.encoder, bitrateK: opts.bitrateK, durationSec: dur, totalFrames, estBytes }
}

const DEPTH = 4          // frames in flight — overlaps GPU render with NVENC encode + IPC
const STALL_MS = 60000   // watchdog: no frame for this long => the renderer stalled

class RenderJob {
  constructor(win, analysis, opts, hooks) {
    this.win = win
    this.analysis = analysis
    this.opts = opts          // {width,height,fps,encoder,ffmpegPath,bitrateK,audioBitrateK,audioPath,startSec,durSec,outPath,style,ap,visual}
    this.hooks = hooks || {}
    this.cancelled = false
    this._stalled = null
    this._finish = null
    this._watchdog = null
    this._ff = null
    this.port = null
  }

  cancel() {
    this.cancelled = true
    clearTimeout(this._watchdog)
    this._end()
    if (this._ff) { try { this._ff.stdin.end() } catch {} }
  }

  _end() { if (this._finish) { const f = this._finish; this._finish = null; f() } }

  async run() {
    const o = this.opts
    const startFrame = Math.round((o.startSec || 0) * o.fps)
    const total = Math.round((o.durSec || (this.analysis.duration - (o.startSec || 0))) * o.fps)
    const ap = o.ap
    const wantWave = o.style === 'waveform' || o.style === 'ring'
    let prev = new Float32Array(ap.barCount)

    // Parallel segments start mid-stream, so prime the band smoothing with a few
    // frames before the segment's first frame — the initial-state error decays as
    // smoothing^n, so the seam matches a continuous pass. Segment 0 starts cold.
    for (let w = o.warmupFrames || 0; w > 0; w--) {
      prev = this.analysis.frame(startFrame - w, ap, prev, wantWave).bands
    }

    const bgVideo = (o.visual && o.visual.background && o.visual.background.type === 'video') ? o.visual.background.video : null
    // NV12 readback (3MB vs 8MB RGBA) feeds NVENC its native format. Video
    // backgrounds stay RGBA — ffmpeg screen-blends them, which must be in RGB.
    const pixfmt = (bgVideo || process.env.VISIBLAZER_FORCE_RGBA) ? 'rgba' : 'nv12'

    const args = buildArgs({
      width: o.width, height: o.height, fps: o.fps, encoder: o.encoder,
      bitrateK: o.bitrateK, audioBitrateK: o.audioBitrateK,
      audioPath: o.audioPath, startSec: o.startSec || 0, durSec: o.durSec, outPath: o.outPath,
      videoOnly: o.videoOnly, totalFrames: total, pixfmt,
      bgVideo,
      bgVideoOpacity: o.visual && o.visual.background ? o.visual.background.videoOpacity : 1
    })
    const ff = spawnRender(o.ffmpegPath, args)
    this._ff = ff
    let ffErr = ''
    ff.stderr.on('data', (d) => { ffErr = (ffErr + d.toString()).slice(-6000) })
    const ffDone = new Promise((resolve, reject) => {
      ff.on('error', reject)
      ff.on('close', (code) => code === 0 || this.cancelled ? resolve() : reject(new Error('ffmpeg exited ' + code + '\n' + ffErr.split(/\r?\n/).slice(-12).join('\n'))))
    })

    const { port1, port2 } = new MessageChannelMain()
    this.port = port1
    const meta = { width: o.width, height: o.height, style: o.style, visual: o.visual, total, pixfmt }

    const t0 = Date.now()
    let nextToSend = 0, nextToWrite = 0, paused = false
    const received = new Map()
    const finished = new Promise((resolve) => { this._finish = resolve })
    const arm = () => { clearTimeout(this._watchdog); this._watchdog = setTimeout(() => { this._stalled = nextToWrite; this._end() }, STALL_MS) }

    const sendOne = () => {
      const n = nextToSend++
      const fd = this.analysis.frame(startFrame + n, ap, prev, wantWave)   // sequential -> smoothing stays correct
      const time = (startFrame + n) / o.fps
      prev = fd.bands
      port1.postMessage({ type: 'produce', frame: n, bands: fd.bands, bass: fd.bass, time, waveform: fd.waveform || null })
    }
    const fill = () => {
      while (!this.cancelled && !paused && nextToSend < total && (nextToSend - nextToWrite) < DEPTH) sendOne()
    }
    const writeReady = () => {
      while (received.has(nextToWrite)) {
        const buf = received.get(nextToWrite); received.delete(nextToWrite)
        const ok = ff.stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
        nextToWrite++
        if (nextToWrite % 30 === 0 || nextToWrite === total) {
          const el = (Date.now() - t0) / 1000, fps = el > 0 ? nextToWrite / el : 0
          this.hooks.onProgress && this.hooks.onProgress({ done: nextToWrite, total, fps, eta: fps > 0 ? (total - nextToWrite) / fps : 0, elapsed: el })
        }
        if (nextToWrite >= total) { this._end(); return }
        if (!ok) { paused = true; ff.stdin.once('drain', () => { paused = false; writeReady() }); return }
      }
      fill()
    }

    let resolveReady
    const readyP = new Promise((resolve, reject) => {
      resolveReady = resolve
      this._readyTimer = setTimeout(() => reject(new Error('Renderer did not attach (no GL frame source).')), 15000)
    })
    port1.on('message', (e) => {
      const m = e.data
      if (m.type === 'ready') { clearTimeout(this._readyTimer); resolveReady() }
      else if (m.type === 'frame') {
        if (this.cancelled || this._finish === null) return
        received.set(m.frame, m.data); arm(); writeReady()
      }
    })
    port1.start()
    this.win.webContents.postMessage('render-port', meta, [port2])
    await readyP

    arm(); fill()
    await finished
    clearTimeout(this._watchdog)

    try { port1.postMessage({ type: 'end' }) } catch {}
    try { port1.close() } catch {}
    try { ff.stdin.end() } catch {}
    await ffDone

    if (this._stalled != null) throw new Error('Renderer returned no frame near frame ' + this._stalled + ' (WebGL stall or error).')
    if (this.cancelled) { try { fs.unlinkSync(o.outPath) } catch {}; return { cancelled: true } }
    const size = (() => { try { return fs.statSync(o.outPath).size } catch { return 0 } })()
    return { cancelled: false, outPath: o.outPath, bytes: size, frames: total, elapsed: (Date.now() - t0) / 1000, encoder: o.encoder }
  }
}

module.exports = { RenderJob, estimate }
