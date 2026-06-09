'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const ffmpeg = require('./ffmpeg')
const audio = require('./audio')
const { RenderJob, estimate } = require('./render')
const { ParallelRender } = require('./parallel-render')

const PRELOAD = path.join(__dirname, 'preload.js')
const INDEX_HTML = path.join(__dirname, '..', 'src', 'index.html')

const TMP = path.join(app.getPath('temp'), 'visiblazer')
const PRESETS = path.join(app.getPath('userData'), 'presets')
fs.mkdirSync(PRESETS, { recursive: true })

const state = { win: null, enc: null, analysis: null, inputPath: null, job: null, previewPrev: null, previewLast: -99 }

// Headless end-to-end smoke test: VISIBLAZER_SELFTEST=<audiofile> npm start
// Renders 2s of the radial style and exits. Software GL so it runs anywhere.
if (process.env.VISIBLAZER_SELFTEST && !process.env.VISIBLAZER_HW && !process.env.VISIBLAZER_SEG) {
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: '#0b0d12',
    title: 'Visiblazer',
    show: !process.env.VISIBLAZER_SELFTEST,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,   // keep WebGL running while occluded during long renders
      webSecurity: false             // local-only app: load file:// audio + image assets directly
    }
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  state.win = win
  win.on('closed', () => { state.win = null })
  if (process.env.VISIBLAZER_SELFTEST) {
    win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.error('RENDERER: ' + msg) })
    win.webContents.once('did-finish-load', () => setTimeout(() => runSelfTest(win), 1200))
  }
}

app.whenReady().then(() => {
  // Segment-render child process (spawned by ParallelRender): render one chunk
  // headlessly to a file and exit — its own main thread + GPU process is the
  // whole point, so it must not boot the normal UI.
  if (process.env.VISIBLAZER_SEG) { runSegmentChild(process.env.VISIBLAZER_SEG); return }
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { cleanup(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', cleanup)

function cleanup() {
  if (state.job) { state.job.cancel(); state.job = null }
  if (state.analysis) { state.analysis.close(); state.analysis = null }
}

function getEncoder() {
  if (!state.enc) state.enc = ffmpeg.detect()
  return state.enc
}

ipcMain.handle('detect-encoder', () => getEncoder())

ipcMain.handle('choose-audio', async () => {
  const r = await dialog.showOpenDialog(state.win, {
    title: 'Import audio',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'aac', 'm4a', 'ogg', 'aiff'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('choose-image', async (_e, kind) => {
  const r = await dialog.showOpenDialog(state.win, {
    title: kind === 'logo' ? 'Choose logo PNG' : 'Choose background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('choose-video', async () => {
  const r = await dialog.showOpenDialog(state.win, {
    title: 'Choose background video',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('choose-output', async (_e, def) => {
  const r = await dialog.showSaveDialog(state.win, {
    title: 'Save video as',
    defaultPath: def || path.join(app.getPath('desktop'), 'visiblazer-output.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('load-audio', async (_e, p) => {
  const enc = getEncoder()
  if (!enc.ok) throw new Error(enc.message)
  if (state.analysis) { state.analysis.close(); state.analysis = null }
  state.inputPath = p
  const a = await audio.open(enc.ffmpegPath, enc.ffprobePath, p, TMP, (f) => {
    if (state.win) state.win.webContents.send('decode-progress', f)
  })
  state.analysis = a
  state.previewPrev = null
  state.previewLast = -99
  return { path: p, duration: a.duration, totalFrames: a.totalFrames, sampleRate: a.sampleRate }
})

ipcMain.handle('preview-bands', (_e, n, ap, wantWave) => {
  const a = state.analysis
  if (!a) return null
  if (!state.previewPrev || state.previewPrev.length !== ap.barCount || Math.abs(n - state.previewLast) > 2) {
    state.previewPrev = new Float32Array(ap.barCount)
  }
  const fd = a.frame(n, ap, state.previewPrev, wantWave)
  state.previewPrev = fd.bands
  state.previewLast = n
  return { bands: fd.bands, bass: fd.bass, waveform: fd.waveform || null }
})

ipcMain.handle('estimate', (_e, o) => {
  const enc = getEncoder()
  const a = state.analysis
  return estimate({
    ...o, encoder: enc.encoder, fps: 60,
    fullDuration: a ? a.duration : 0
  })
})

ipcMain.handle('start-render', async (_e, o) => {
  if (state.job) throw new Error('A render is already running.')
  const enc = getEncoder()
  const a = state.analysis
  if (!a) throw new Error('No audio loaded.')

  let outPath = o.outPath
  if (o.test) outPath = path.join(TMP, 'test.mp4')
  if (!outPath) throw new Error('No output path.')

  const opts = {
    width: 1920, height: 1080, fps: 60,
    encoder: enc.encoder, ffmpegPath: enc.ffmpegPath,
    bitrateK: o.bitrateK || 12000, audioBitrateK: 320,
    audioPath: state.inputPath,
    startSec: o.startSec || 0,
    durSec: o.test ? (o.durSec || 8) : (o.durSec || undefined),
    outPath,
    style: o.style, ap: o.ap, visual: o.visual
  }

  const onProgress = (p) => { if (state.win) state.win.webContents.send('render-progress', p) }
  // Segment-parallel for full renders. With NV12 readback a single pipeline
  // nearly saturates the GPU (~169fps), so parallel only adds ~20% (K=2 sweet
  // spot); it matters more for the rgba video-bg path. Test renders stay single.
  const concurrency = o.test ? 1 : (o.concurrency || Number(process.env.VISIBLAZER_PARALLEL) || 2)
  const job = concurrency > 1
    ? new ParallelRender(a, opts, { onProgress }, { concurrency, preload: PRELOAD, indexHtml: INDEX_HTML, tmpDir: TMP })
    : new RenderJob(state.win, a, opts, { onProgress })
  state.job = job
  try {
    const res = await job.run()
    return res
  } finally {
    state.job = null
  }
})

ipcMain.handle('cancel-render', () => { if (state.job) state.job.cancel(); return true })

ipcMain.handle('save-preset', (_e, name, data) => {
  const safe = name.replace(/[^\w\-. ]+/g, '_').trim() || 'preset'
  fs.writeFileSync(path.join(PRESETS, safe + '.json'), JSON.stringify(data, null, 2))
  return safe
})
ipcMain.handle('load-preset', (_e, name) => {
  const f = path.join(PRESETS, name + '.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
})
ipcMain.handle('list-presets', () => {
  try { return fs.readdirSync(PRESETS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) } catch { return [] }
})
ipcMain.handle('delete-preset', (_e, name) => {
  try { fs.unlinkSync(path.join(PRESETS, name + '.json')) } catch {}
  return true
})

ipcMain.handle('open-path', (_e, p) => shell.openPath(p))
ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); return true })

async function runSelfTest(win) {
  const V = {
    primary: '#00e5ff', secondary: '#ff00d4', colorMode: 'gradient', hueBase: 0.55, hueSpread: 0.7,
    background: { type: 'gradient', color: '#0a0f1c', color2: '#05060a', image: null, video: null, videoOpacity: 0.6 },
    logo: { path: null, size: 0.22, pulse: 0.4, opacity: 1 },
    glow: 0.8, barWidth: 0.6, barLen: 0.6, radius: 0.16, rotationSpeed: 0.03, rotationOffset: 0, mirror: true,
    waveAmp: 0.35, thickness: 3
  }
  const AP = { fftSize: 2048, barCount: 96, gain: 1.2, smoothing: 0.6, minDb: -70, maxDb: -12 }
  if (process.env.VISIBLAZER_SELFTEST_BGVIDEO) { V.background.type = 'video'; V.background.video = process.env.VISIBLAZER_SELFTEST_BGVIDEO }
  try {
    const enc = getEncoder()
    if (!enc.ok) throw new Error(enc.message)
    const input = process.env.VISIBLAZER_SELFTEST
    const a = await audio.open(enc.ffmpegPath, enc.ffprobePath, input, TMP, () => {})
    state.analysis = a; state.inputPath = input
    const opts = {
      width: 1920, height: 1080, fps: 60, encoder: enc.encoder, ffmpegPath: enc.ffmpegPath,
      bitrateK: 12000, audioBitrateK: 320, audioPath: input, startSec: 0, durSec: Number(process.env.VISIBLAZER_SELFTEST_DUR) || 1,
      outPath: path.join(TMP, 'selftest.mp4'), style: process.env.VISIBLAZER_SELFTEST_STYLE || 'radial', ap: AP, visual: V
    }
    const K = Number(process.env.VISIBLAZER_PARALLEL) || 1
    const onProgress = (p) => process.stdout.write(`\r${p.done}/${p.total} ${p.fps.toFixed(0)}fps${p.workers ? ' x' + p.workers : ''}`)
    const job = K > 1
      ? new ParallelRender(a, opts, { onProgress }, { concurrency: K, preload: PRELOAD, indexHtml: INDEX_HTML, tmpDir: TMP })
      : new RenderJob(win, a, opts, { onProgress })
    const res = await job.run()
    process.stdout.write('\n' + 'SELFTEST_RESULT ' + JSON.stringify(res) + '\n')
    app.exit(res.cancelled ? 1 : 0)
  } catch (e) {
    console.error('SELFTEST_FAIL ' + (e && e.stack || e))
    app.exit(2)
  }
}

// One segment of a parallel render, in its own process. Reads {pcmPath,
// sampleCount, opts} from a temp JSON, renders the chunk to opts.outPath, and
// streams "PROGRESS <done>" lines so the parent can aggregate fps/ETA.
async function runSegmentChild(cfgPath) {
  let a
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    a = audio.openExisting(cfg.pcmPath, cfg.sampleCount)
    const win = new BrowserWindow({
      show: false, width: 480, height: 270,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: false, backgroundThrottling: false, webSecurity: false
      }
    })
    win.removeMenu()
    await win.loadFile(INDEX_HTML)
    await new Promise((r) => setTimeout(r, 250))   // let the page's Engine register its port listener
    const job = new RenderJob(win, a, cfg.opts, {
      // Only the parent reports the finalize phase; a child emits frame counts.
      onProgress: (p) => { if (p.done != null) process.stdout.write('PROGRESS ' + p.done + '\n') }
    })
    const res = await job.run()
    a.close()
    process.stdout.write('SEG_DONE ' + JSON.stringify(res) + '\n')
    app.exit(res.cancelled ? 1 : 0)
  } catch (e) {
    if (a) try { a.close() } catch {}
    process.stderr.write('SEG_FAIL ' + (e && e.stack || e) + '\n')
    app.exit(2)
  }
}
