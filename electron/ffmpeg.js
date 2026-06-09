'use strict'

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function exists(p) { try { return !!p && fs.existsSync(p) } catch { return false } }
function tail(s, n = 12) { return (s || '').trim().split(/\r?\n/).slice(-n).join('\n') }

function runSync(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error }
}

// The real NVENC-capable ffmpeg is often installed by winget but shadowed on
// PATH by a Microsoft Store / WindowsApps stub. Find it directly under the
// winget package store so PATH ordering can't hide it.
function findWingetFfmpeg() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
  if (!exists(base)) return null
  let pkg
  try { pkg = fs.readdirSync(base).find((d) => d.toLowerCase().startsWith('gyan.ffmpeg')) } catch { return null }
  if (!pkg) return null
  const pkgDir = path.join(base, pkg)
  let sub
  try { sub = fs.readdirSync(pkgDir).find((d) => d.toLowerCase().startsWith('ffmpeg')) } catch { return null }
  const cand = sub && path.join(pkgDir, sub, 'bin', 'ffmpeg.exe')
  return exists(cand) ? cand : null
}

function candidates() {
  const c = []
  const win = process.platform === 'win32'
  const bin = win ? 'ffmpeg.exe' : 'ffmpeg'
  if (process.env.VISIBLAZER_FFMPEG) c.push(process.env.VISIBLAZER_FFMPEG)
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'ffmpeg', process.platform, bin))
  c.push(path.join(__dirname, '..', 'ffmpeg', process.platform, bin))
  if (win) {
    const w = findWingetFfmpeg()
    if (w) c.push(w)
    c.push('ffmpeg')
  } else {
    c.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg', 'ffmpeg')
  }
  return c
}

function validate(p) {
  const isBare = p === 'ffmpeg'
  if (!isBare && !exists(p)) return null
  const enc = runSync(p, ['-hide_banner', '-encoders'])
  if (enc.err || (!enc.out)) return null
  const hasNvenc = /h264_nvenc/.test(enc.out)
  const hasX264 = /libx264/.test(enc.out)
  if (!hasNvenc && !hasX264) return null // audio-only / video-incapable build
  const v = runSync(p, ['-hide_banner', '-version'])
  const version = (v.out.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown'
  return { path: p, hasNvenc, hasX264, version }
}

// One-frame hardware encode from a synthetic source — exercises the full NVENC
// init path, which is where driver/runtime mismatches actually surface.
function probeNvenc(p) {
  const r = runSync(p, [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'
  ])
  return { works: r.code === 0, log: r.out }
}

function ffprobeFor(ffmpegPath) {
  if (ffmpegPath === 'ffmpeg') return 'ffprobe'
  const p = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => (/\.exe$/i.test(m) ? 'ffprobe.exe' : 'ffprobe'))
  return exists(p) ? p : null
}

function detect() {
  let chosen = null
  for (const c of candidates()) {
    const v = validate(c)
    if (!v) continue
    if (!chosen) chosen = v
    if (v.hasNvenc) { chosen = v; break }
  }
  if (!chosen) {
    return {
      ok: false,
      message:
        'No ffmpeg with H.264 video encoding was found.\n' +
        'Install a full build: winget install Gyan.FFmpeg (Windows) or apt/dnf install ffmpeg (Linux).\n' +
        'Note: a system "ffmpeg" on PATH may be an audio-only build — this app looks past it.'
    }
  }
  let nvencWorks = false, nvencLog = ''
  if (chosen.hasNvenc) { const pr = probeNvenc(chosen.path); nvencWorks = pr.works; nvencLog = pr.log }
  const encoder = nvencWorks ? 'h264_nvenc' : 'libx264'
  let message
  if (nvencWorks) message = `NVENC ready — h264_nvenc (ffmpeg ${chosen.version}).`
  else if (chosen.hasNvenc) message =
    `ffmpeg has NVENC but a test encode failed — update your GPU driver or use an ffmpeg built --enable-nvenc. Using libx264 for now.\n${tail(nvencLog)}`
  else message = `This ffmpeg has no NVENC; using libx264 (CPU). ffmpeg ${chosen.version}.`
  return {
    ok: true,
    ffmpegPath: chosen.path,
    ffprobePath: ffprobeFor(chosen.path),
    hasNvenc: chosen.hasNvenc,
    hasX264: chosen.hasX264,
    nvencWorks,
    version: chosen.version,
    encoder,
    message
  }
}

// width/height/fps fixed; encoder is 'h264_nvenc' or 'libx264'. When startSec/
// durSec are set (test render) only that audio span is muxed.
function buildArgs(o) {
  const a = ['-y', '-f', 'rawvideo', '-pix_fmt', (o.pixfmt || 'rgba'), '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0']
  if (o.bgVideo) {
    // input 1: looped background video; input 2: audio span.
    a.push('-stream_loop', '-1', '-i', o.bgVideo)
    if (!o.videoOnly) {
      if (o.startSec > 0) a.push('-ss', String(o.startSec))
      if (o.durSec) a.push('-t', String(o.durSec))
      a.push('-i', o.audioPath)
    }
    // The visualizer (rendered on black, vflipped upright) is screened over the
    // frame-rate-matched, cover-scaled bg video — additive light, no alpha needed.
    const op = (o.bgVideoOpacity == null ? 1 : o.bgVideoOpacity)
    const bg = `[1:v]fps=${o.fps},scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height},setsar=1,format=rgba,colorchannelmixer=rr=${op}:gg=${op}:bb=${op}[bg]`
    const fg = `[0:v]vflip,format=rgba[fg]`
    a.push('-filter_complex', `${bg};${fg};[bg][fg]blend=all_mode=screen[v]`, '-map', '[v]')
    if (!o.videoOnly) a.push('-map', '2:a:0')
  } else {
    if (!o.videoOnly) {
      if (o.startSec > 0) a.push('-ss', String(o.startSec))
      if (o.durSec) a.push('-t', String(o.durSec))
      a.push('-i', o.audioPath, '-map', '0:v:0', '-map', '1:a:0')
    } else {
      a.push('-map', '0:v:0')
    }
    // gl.readPixels returns rows bottom-to-top; vflip makes the encoded frame upright.
    a.push('-vf', 'vflip')
  }
  if (o.encoder === 'h264_nvenc') {
    // Targeted-quality VBR on Ada NVENC: -cq holds a constant visual quality and
    // the bitrate cap bounds peaks, so simple/dark frames spend fewer bits and
    // bursts get the full budget. Spatial/temporal AQ + lookahead are the big
    // anti-banding wins for this content (dark gradients, bloom). B-frames with
    // a middle ref pyramid raise efficiency at no meaningful speed cost on Ada.
    // p7 + fullres: highest-quality preset with full-resolution rate-control
    // analysis. On Ada this still encodes well above realtime, so for an offline
    // master there's no reason to trade quality for speed. (Overridable via env.)
    const preset = process.env.VISIBLAZER_NVENC_PRESET || 'p7'
    const multipass = process.env.VISIBLAZER_NVENC_MULTIPASS || 'fullres'
    a.push('-c:v', 'h264_nvenc', '-preset', preset, '-tune', 'hq',
      '-rc', 'vbr', '-cq', '19', '-b:v', `${o.bitrateK}k`,
      '-maxrate', `${Math.round(o.bitrateK * 1.5)}k`, '-bufsize', `${o.bitrateK * 2}k`,
      '-multipass', multipass, '-rc-lookahead', '20',
      '-spatial-aq', '1', '-aq-strength', '8', '-temporal-aq', '1',
      '-bf', '3', '-b_ref_mode', 'middle', '-profile:v', 'high', '-pix_fmt', 'yuv420p')
  } else {
    a.push('-c:v', 'libx264', '-preset', 'medium', '-b:v', `${o.bitrateK}k`, '-pix_fmt', 'yuv420p')
  }
  if (o.videoOnly) {
    // Parallel-segment render: no audio, and a hard frame cap so a looped bg
    // video can't run past the segment (the rawvideo input alone would bound
    // it, but the cap is required once an infinite [bg] is in the graph).
    // Audio is muxed once at the concat step.
    if (o.totalFrames) a.push('-frames:v', String(o.totalFrames))
  } else {
    a.push('-c:a', 'aac', '-b:a', `${o.audioBitrateK || 320}k`, '-shortest')
  }
  a.push(o.outPath)
  return a
}

// Encode just the audio span to AAC. Run this concurrently with the segment
// renders so the final concat is a pure copy/remux with no audio encode on the
// tail (which otherwise serializes a full-length AAC pass after the last frame).
function buildAudioArgs(o) {
  const a = ['-y']
  if (o.startSec > 0) a.push('-ss', String(o.startSec))
  if (o.durSec) a.push('-t', String(o.durSec))
  a.push('-i', o.audioPath, '-vn', '-c:a', 'aac', '-b:a', `${o.audioBitrateK || 320}k`, o.outPath)
  return a
}

// Losslessly stitch the parallel segment files (same encoder params, each starts
// on a keyframe) and mux the pre-encoded audio — a pure -c copy remux, so the
// only cost is sequential I/O, not re-encoding.
function buildConcatArgs(o) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', o.listFile,
    '-i', o.audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', o.outPath]
}

function spawnRender(ffmpegPath, args) {
  return spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
}

module.exports = { detect, buildArgs, buildAudioArgs, buildConcatArgs, spawnRender, runSync }
