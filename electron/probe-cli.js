'use strict'

// Headless encoder probe: `npm run probe`. Prints the detected ffmpeg + NVENC
// status without launching the UI.
const { app } = require('electron')
const { detect } = require('./ffmpeg')

app.whenReady().then(() => {
  const r = detect()
  process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  app.exit(r.ok ? 0 : 1)
})
