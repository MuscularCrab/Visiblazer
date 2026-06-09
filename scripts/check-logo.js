'use strict'

// Regression guard for the "works in preview, missing in full render" class of
// bug: render a known logo through the multi-process (parallel) path and assert
// the logo actually appears in the encoded output. A white logo at frame centre
// should push the centre brightness far above the dark background.
//
//   npm run test:logo
//
// Exits non-zero (failing CI / a release gate) if the logo is missing.

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const electronPath = require('electron')          // path to the electron binary
const { detect } = require(path.join(ROOT, 'electron', 'ffmpeg'))

const THRESHOLD = 150   // centre YAVG: white logo ~235, dark background ~25

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1) }

function run(file, args, opts) {
  return spawnSync(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26, ...opts })
}

const enc = detect()
if (!enc.ok) fail('no ffmpeg: ' + enc.message)
const ffmpeg = enc.ffmpegPath

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbz-logotest-'))
const wav = path.join(dir, 'a.wav')
const logo = path.join(dir, 'logo.png')

// Synthetic inputs: 4s of tone + an opaque white logo.
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-ac', '1', '-ar', '48000', wav])
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=white:s=400x400', '-frames:v', '1', logo])
if (!fs.existsSync(wav) || !fs.existsSync(logo)) fail('could not create test inputs')

// Render via the parallel path (K=2) with the logo set. The self-test writes to
// <temp>/visiblazer/selftest.mp4; we check that file rather than parsing stdout,
// because the GUI electron binary's stdout isn't reliably captured on Windows.
const outFile = path.join(os.tmpdir(), 'visiblazer', 'selftest.mp4')
try { fs.unlinkSync(outFile) } catch {}
const env = {
  ...process.env,
  VISIBLAZER_SELFTEST: wav,
  VISIBLAZER_HW: '1',
  VISIBLAZER_SELFTEST_DUR: '4',
  VISIBLAZER_SELFTEST_STYLE: 'radial',
  VISIBLAZER_SELFTEST_LOGO: logo,
  VISIBLAZER_PARALLEL: '2'
}
const startT = Date.now()
const r = run(electronPath, ['.'], { cwd: ROOT, env, timeout: 180000 })
if (!fs.existsSync(outFile) || fs.statSync(outFile).mtimeMs < startT - 1000) {
  const tail = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter((l) => !/Security Warning|electronjs\.org|severe security/.test(l)).slice(-15).join('\n')
  fail('render produced no output file:\n' + tail)
}

// Measure centre-of-frame brightness on the first frame.
const probe = run(ffmpeg, ['-hide_banner', '-i', outFile,
  '-vf', 'crop=200:200:(iw-200)/2:(ih-200)/2,signalstats,metadata=print:file=-',
  '-frames:v', '1', '-an', '-f', 'null', '-'])
const ym = ((probe.stdout || '') + (probe.stderr || '')).match(/YAVG=([\d.]+)/)
if (!ym) fail('could not measure output brightness')
const yavg = parseFloat(ym[1])

try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}

if (yavg < THRESHOLD) {
  fail(`logo missing from parallel render — centre brightness ${yavg.toFixed(1)} < ${THRESHOLD}. ` +
    `The logo loads in preview but not the full render.`)
}
console.log(`PASS: logo present in parallel render — centre brightness ${yavg.toFixed(1)} (>= ${THRESHOLD})`)
