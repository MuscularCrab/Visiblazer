import { Engine } from './renderer/engine.js'

const $ = (id) => document.getElementById(id)
const api = window.api
const num = (id) => parseFloat($(id).value)
const baseName = (p) => p.replace(/\\/g, '/').split('/').pop()
const fmt = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0; const r = s % 60; return m + ':' + String(r).padStart(2, '0') }

let engine, audioEl = null, durationSec = 0, totalFrames = 0
let inputPath = null, bgPath = null, logoPath = null, videoPath = null
let encoderOk = false, rendering = false, seeking = false

function readControls() {
  return {
    style: $('style').value,
    bitrateK: Math.round(num('bitrate') * 1000),
    ap: {
      fftSize: parseInt($('fftSize').value, 10),
      barCount: parseInt($('barCount').value, 10),
      gain: num('gain'), smoothing: num('smoothing'), minDb: -70, maxDb: -12
    },
    visual: {
      primary: $('primary').value, secondary: $('secondary').value, colorMode: $('colorMode').value,
      hueBase: num('hueBase'), hueSpread: num('hueSpread'),
      background: { type: $('bgType').value, color: $('bgColor').value, color2: $('bgColor2').value, image: bgPath, video: videoPath, videoOpacity: num('videoOpacity') },
      logo: { path: logoPath, size: num('logoSize'), pulse: num('logoPulse'), opacity: num('logoOpacity') },
      glow: num('glow'), barWidth: num('barWidth'), barLen: num('barLen'),
      radius: num('radius'), rotationSpeed: num('rot'), rotationOffset: 0, mirror: $('mirror').checked,
      waveAmp: num('waveAmp'), thickness: num('thickness')
    }
  }
}

function updateVisibility() {
  const style = $('style').value
  const active = new Set([style, 'bg-' + $('bgType').value])
  if ($('colorMode').value === 'hue') active.add('hue')
  document.querySelectorAll('[data-show]').forEach((el) => {
    const tokens = el.getAttribute('data-show').split(' ')
    el.classList.toggle('hidden', !tokens.some((t) => active.has(t)))
  })
}

function apply() {
  const c = readControls()
  engine.setParams({ ap: c.ap, visual: c.visual, style: c.style })
  $('bitrateVal').textContent = num('bitrate')
  updateVisibility()
  refreshSummary()
}

async function refreshSummary() {
  if (!durationSec) { $('summary').textContent = ''; return }
  const c = readControls()
  try {
    const e = await api.estimate({ bitrateK: c.bitrateK })
    const gb = (e.estBytes / 1e9)
    $('summary').textContent =
      `Full set: ${fmt(e.durationSec)} · ${e.totalFrames.toLocaleString()} frames @60fps\n` +
      `${e.encoder} · ${(e.bitrateK / 1000)} Mbps + 320k aac · ~${gb.toFixed(2)} GB`
  } catch {}
}

// ---- audio import ----
$('import').onclick = async () => {
  const p = await api.chooseAudio()
  if (p) await loadAudioFile(p)
}

async function loadAudioFile(p) {
  inputPath = p
  if (!audioEl) {
    audioEl = new Audio(); audioEl.preload = 'auto'
    engine.setAudio(audioEl)
    audioEl.addEventListener('play', () => { $('playPause').textContent = '❚❚' })
    audioEl.addEventListener('pause', () => { $('playPause').textContent = '▶' })
  }
  audioEl.src = 'file://' + p.replace(/\\/g, '/')
  $('decodeOverlay').classList.remove('hidden'); $('decodeFill').style.width = '0%'
  const off = api.onDecodeProgress((f) => { $('decodeFill').style.width = (f * 100).toFixed(1) + '%' })
  try {
    const info = await api.loadAudio(p)
    durationSec = info.duration; totalFrames = info.totalFrames
    engine.setAudioLoaded(true)
    $('filename').textContent = baseName(p)
    $('duration').textContent = fmt(durationSec)
    $('playPause').disabled = false; $('seek').disabled = false
    if (encoderOk) { $('testRender').disabled = false; $('fullRender').disabled = false }
    refreshSummary()
  } catch (e) {
    alert('Failed to load audio:\n' + e.message)
  } finally {
    off(); $('decodeOverlay').classList.add('hidden')
  }
}

// ---- transport ----
$('playPause').onclick = () => { if (!audioEl) return; audioEl.paused ? audioEl.play() : audioEl.pause() }
$('seek').addEventListener('input', () => { seeking = true; if (durationSec) audioEl.currentTime = $('seek').value * durationSec; updateTime() })
$('seek').addEventListener('change', () => { seeking = false })
function updateTime() { $('time').textContent = fmt(audioEl ? audioEl.currentTime : 0) + ' / ' + fmt(durationSec) }
function tick() {
  if (audioEl && durationSec) { if (!seeking) $('seek').value = (audioEl.currentTime / durationSec) || 0; updateTime() }
  requestAnimationFrame(tick)
}

// ---- textures ----
$('bgImageBtn').onclick = async () => {
  const p = await api.chooseImage('bg'); if (!p) return
  bgPath = p; $('bgImageLabel').textContent = baseName(p); $('bgType').value = 'image'
  await engine.setTexture('bg', p); apply()
}
$('bgImageClear').onclick = async () => { bgPath = null; $('bgImageLabel').textContent = 'none'; await engine.setTexture('bg', null); apply() }
$('bgVideoBtn').onclick = async () => {
  const p = await api.chooseVideo(); if (!p) return
  videoPath = p; $('bgVideoLabel').textContent = baseName(p); $('bgType').value = 'video'
  engine.setVideoBackground(p); apply()
}
$('bgVideoClear').onclick = () => { videoPath = null; $('bgVideoLabel').textContent = 'none'; engine.setVideoBackground(null); apply() }
$('logoBtn').onclick = async () => {
  const p = await api.chooseImage('logo'); if (!p) return
  logoPath = p; $('logoLabel').textContent = baseName(p)
  await engine.setTexture('logo', p); apply()
}
$('logoClear').onclick = async () => { logoPath = null; $('logoLabel').textContent = 'none'; await engine.setTexture('logo', null); apply() }

// ---- render ----
function setRenderingUI(on) {
  rendering = on
  $('import').disabled = on; $('testRender').disabled = on || !encoderOk || !durationSec
  $('fullRender').disabled = on || !encoderOk || !durationSec
}
function showOverlay(title) {
  $('renderOverlay').classList.remove('hidden')
  $('renderTitle').textContent = title
  $('renderFill').style.width = '0%'; $('renderStats').textContent = ''
  $('cancelRender').classList.remove('hidden')
  for (const id of ['playResult', 'revealResult', 'closeOverlay']) $(id).classList.add('hidden')
}
function onProgress(p) {
  if (p.phase === 'finalize') {
    // Frames are done; bar stays full while we stitch/mux + flush the encoder.
    $('renderTitle').textContent = 'Finalizing'
    $('renderFill').style.width = '100%'
    $('renderStats').textContent = p.frac != null
      ? `Stitching & muxing… ${(p.frac * 100).toFixed(0)}%${p.eta ? ` · ETA ${fmt(p.eta)}` : ''}`
      : 'Finishing up…'
    return
  }
  $('renderFill').style.width = (p.done / p.total * 100).toFixed(1) + '%'
  $('renderStats').textContent =
    `${p.done.toLocaleString()} / ${p.total.toLocaleString()} frames · ${p.fps.toFixed(0)} fps · ETA ${fmt(p.eta)}`
}
function finishOverlay(res) {
  if (res.cancelled) { $('renderTitle').textContent = 'Cancelled'; $('renderStats').textContent = '' }
  else {
    $('renderFill').style.width = '100%'
    $('renderTitle').textContent = 'Done'
    const mb = res.bytes / 1e6
    $('renderStats').textContent =
      `${baseName(res.outPath)} · ${(mb).toFixed(1)} MB · ${res.frames.toLocaleString()} frames in ${fmt(res.elapsed)} · ${res.encoder}`
    $('playResult').classList.remove('hidden'); $('revealResult').classList.remove('hidden')
    $('playResult').onclick = () => api.openPath(res.outPath)
    $('revealResult').onclick = () => api.reveal(res.outPath)
  }
  $('cancelRender').classList.add('hidden'); $('closeOverlay').classList.remove('hidden')
}

async function runRender(opts, title) {
  if (rendering) return
  if (audioEl) audioEl.pause()
  setRenderingUI(true); showOverlay(title)
  const off = api.onRenderProgress(onProgress)
  try {
    const res = await api.startRender(opts)
    finishOverlay(res)
  } catch (e) {
    $('renderTitle').textContent = 'Render error'
    $('renderStats').textContent = e.message
    $('cancelRender').classList.add('hidden'); $('closeOverlay').classList.remove('hidden')
  } finally {
    off(); setRenderingUI(false)
  }
}

$('testRender').onclick = () => {
  const c = readControls()
  runRender({ test: true, startSec: num('testStart'), durSec: num('testDur'), style: c.style, ap: c.ap, visual: c.visual, bitrateK: c.bitrateK }, 'Test render')
}
$('fullRender').onclick = async () => {
  const out = await api.chooseOutput()
  if (!out) return
  const c = readControls()
  runRender({ outPath: out, startSec: 0, durSec: null, style: c.style, ap: c.ap, visual: c.visual, bitrateK: c.bitrateK, concurrency: parseInt($('concurrency').value, 10) }, 'Rendering full set')
}
$('cancelRender').onclick = () => api.cancelRender()
$('closeOverlay').onclick = () => $('renderOverlay').classList.add('hidden')

// ---- presets ----
async function refreshPresets() {
  const list = await api.listPresets()
  const sel = $('presetList')
  sel.innerHTML = '<option value="">— load preset —</option>' + list.map((n) => `<option value="${n}">${n}</option>`).join('')
}
$('savePreset').onclick = async () => {
  const name = ($('presetName').value || 'preset').trim()
  const c = readControls()
  await api.savePreset(name, { ...c, bgPath, logoPath, videoPath })
  await refreshPresets(); $('presetList').value = name
}
$('presetList').onchange = async () => {
  const name = $('presetList').value; if (!name) return
  const d = await api.loadPreset(name); if (d) await applyPreset(d)
}
$('deletePreset').onclick = async () => {
  const name = $('presetList').value; if (!name) return
  await api.deletePreset(name); await refreshPresets()
}

async function applyPreset(d) {
  const v = d.visual || {}, ap = d.ap || {}, bg = v.background || {}, lg = v.logo || {}
  const set = (id, val) => { if (val != null) $(id).value = val }
  set('style', d.style); set('bitrate', d.bitrateK ? d.bitrateK / 1000 : 12)
  set('fftSize', ap.fftSize); set('barCount', ap.barCount); set('gain', ap.gain); set('smoothing', ap.smoothing)
  set('primary', v.primary); set('secondary', v.secondary); set('colorMode', v.colorMode)
  set('hueBase', v.hueBase); set('hueSpread', v.hueSpread); set('glow', v.glow)
  set('barWidth', v.barWidth); set('barLen', v.barLen); set('radius', v.radius); set('rot', v.rotationSpeed)
  set('waveAmp', v.waveAmp); set('thickness', v.thickness)
  if (v.mirror != null) $('mirror').checked = v.mirror
  set('bgType', bg.type); set('bgColor', bg.color); set('bgColor2', bg.color2); set('videoOpacity', bg.videoOpacity)
  set('logoSize', lg.size); set('logoPulse', lg.pulse); set('logoOpacity', lg.opacity)
  bgPath = d.bgPath || null; logoPath = d.logoPath || null; videoPath = d.videoPath || null
  $('bgImageLabel').textContent = bgPath ? baseName(bgPath) : 'none'
  $('logoLabel').textContent = logoPath ? baseName(logoPath) : 'none'
  $('bgVideoLabel').textContent = videoPath ? baseName(videoPath) : 'none'
  await engine.setTexture('bg', bgPath); await engine.setTexture('logo', logoPath)
  engine.setVideoBackground(videoPath)
  apply()
}

// ---- init ----
async function init() {
  try { engine = new Engine($('view')) }
  catch (e) {
    $('encoderBadge').textContent = 'WebGL2 ✗'; $('encoderBadge').className = 'badge err'
    $('encoderMsg').textContent = 'WebGL2 is required but unavailable: ' + e.message
    return
  }
  document.querySelectorAll('#panel input, #panel select').forEach((el) => {
    el.addEventListener('input', apply); el.addEventListener('change', apply)
  })
  apply(); engine.start(); tick()
  await refreshPresets()

  const enc = await api.detectEncoder()
  const badge = $('encoderBadge')
  if (!enc.ok) { badge.textContent = 'ffmpeg ✗'; badge.className = 'badge err' }
  else if (enc.nvencWorks) { badge.textContent = 'NVENC'; badge.className = 'badge' }
  else { badge.textContent = 'libx264'; badge.className = 'badge warn' }
  $('encoderMsg').textContent = enc.message
  encoderOk = enc.ok
  if (encoderOk && durationSec) { $('testRender').disabled = false; $('fullRender').disabled = false }
}

init()
