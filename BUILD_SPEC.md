# DJ Set Audio Visualizer — Build Spec

This document is a handoff spec for Claude Code. Read it fully, then build the app described below. The user is a DJ (DJ Windy) who needs to render long-form (up to 2.5hr) audio sets into 1080p60 visualizer videos, locally, GPU-accelerated, on an RTX 4070.

## Hard requirements

- **Input:** a single `.wav` audio file (also accept `.flac`, `.mp3` if cheap to add)
- **Output:** `.mp4`, **1920x1080, 60fps**, H.264, AAC audio muxed in
- **Render method:** offline **frame-by-frame** rendering, NOT real-time screen capture. A 2.5hr set = ~540,000 frames. Each frame is rendered deterministically from the audio's FFT data at that timestamp, written/piped to ffmpeg. This guarantees a perfect 60fps regardless of per-frame render cost.
- **GPU:** use the RTX 4070 for BOTH stages — WebGL/GPU for visual rendering, and **`h264_nvenc`** for encoding. Provide automatic fallback to `libx264` if NVENC is unavailable, but detect and prefer NVENC.
  - NOTE: the user previously hit an NVENC failure that forced a libx264 fallback — it was a **driver/ffmpeg version mismatch**, not a hardware issue. Early in the build, run a tiny NVENC capability probe (`ffmpeg -hide_banner -encoders | grep nvenc` and a 1-second test encode) and surface a clear message if NVENC isn't working, with the fix (update GPU driver / use an ffmpeg build with `--enable-nvenc`).
- **Cross-platform:** must run on **Windows and Linux**. No platform-specific hacks; ffmpeg invoked via bundled or system binary detected at runtime.
- **Zero ongoing cost, no watermark, fully offline.**

## Workflow (exact UX the user wants)

1. Import audio file (`.wav`)
2. Choose a visualizer style + customize options
3. (Optional) drop in a logo PNG (transparent) for the center
4. Click **Render** → progress bar → `output.mp4` at 1080p60
5. **Quick test render** button: renders a short clip (e.g. 5–10s) at the chosen settings before committing to the full 2.5hr encode. The user works iteratively and always test-renders before full encodes — make this prominent.

## Visualizer styles (build ALL, each with customization)

1. **Radial bars + center logo (NCS style)** — circular spectrum bars radiating outward around a center logo. The flagship look.
2. **Linear spectrum bars** — classic bottom-anchored frequency bars.
3. **Waveform / oscilloscope** — time-domain waveform line.

### Per-style customization (expose in UI)
- Color: primary/secondary, gradient option, or react-to-frequency hue
- Bar count / smoothing / sensitivity (FFT gain)
- Background: solid color, gradient, or static image upload
- Logo: upload PNG, size, optional pulse-with-bass
- Glow/bloom intensity
- Bar width/spacing, rotation speed (radial)
- Mirror / symmetry toggle

Persist presets to a local JSON file so the user can save/load their look.

## Recommended architecture (Option A — confirmed with user)

**Electron app** (gives a real cross-platform desktop app + easy GitHub distribution).

- **Frontend (renderer process):** HTML/CSS/JS UI + a **WebGL2 canvas** (use raw WebGL2 or a thin lib like `regl`/`twgl`; avoid heavy frameworks). The canvas draws one frame given an FFT frame.
- **Audio analysis:** decode the wav, compute FFT per video frame offline. At 60fps each frame corresponds to `sampleRate/60` samples advance. Use a windowed FFT (Hann), configurable size (e.g. 2048). Do this in JS (`fft.js`) or via a small Web Audio OfflineAudioContext pass — but it must be deterministic and frame-locked, NOT live AnalyserNode timing.
- **Frame extraction:** render canvas → read pixels (`gl.readPixels` / `canvas.toDataURL`/`toBlob` is too slow; prefer `readPixels` into a raw RGBA buffer).
- **Encoding:** spawn `ffmpeg` from the main process, **pipe raw RGBA frames over stdin** (`-f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i -`) and mux the original audio. Use `h264_nvenc`. This avoids writing 540k PNGs to disk.
  - Example ffmpeg invocation (tune):
    ```
    ffmpeg -y \
      -f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i pipe:0 \
      -i input.wav \
      -c:v h264_nvenc -preset p5 -b:v 12M -pix_fmt yuv420p \
      -c:a aac -b:a 320k \
      -shortest output.mp4
    ```
- **Sync:** the Nth frame piped MUST correspond to FFT computed at time `N/60`. Drive the loop by frame index, not wall clock.
- **Progress:** report `framesDone / totalFrames` to the UI.

### Why frame-by-frame + pipe
Real-time capture drops frames on a 2.5hr set and can't guarantee 60fps. Piping raw frames lets each frame take as long as it needs while the output stays locked at exactly 60fps. NVENC on the 4070 will keep the encode well ahead of WebGL frame production.

## Performance targets / notes
- A 2.5hr render should complete in well under real-time (target: minutes-to-tens-of-minutes, not 2.5hr) — NVENC + offline render makes this achievable.
- Free the framebuffer per frame; avoid memory growth across 540k frames.
- Provide a render settings summary (bitrate, encoder used NVENC/x264, est. file size) before full render.

## Project structure (suggested)
```
dj-visualizer/
  package.json
  electron/
    main.js            # main process: file dialogs, ffmpeg spawn, render orchestration
    preload.js
  src/
    index.html
    ui.js              # controls, preset save/load
    audio.js           # offline FFT, frame-locked analysis
    visualizers/
      radial.js
      linear.js
      waveform.js
    renderer.js        # webgl setup, draw frame, readPixels
  ffmpeg/              # optional bundled static ffmpeg per platform (or detect system)
  presets/             # saved JSON presets
  assets/
  README.md
  LICENSE
  .gitignore
```

## GitHub-ready (prep, do NOT publish until user confirms)
Set up but leave for the user to push:
- `README.md` — what it is, screenshots placeholder, install/run instructions for Windows + Linux, build instructions, NVENC/driver note, requirements (Node version, ffmpeg).
- `LICENSE` — MIT (confirm with user before finalizing).
- `.gitignore` — `node_modules/`, build output, `dist/`, large test media, `*.mp4`, `output*`.
- `package.json` with `electron-builder` configured for **Windows (nsis/portable) and Linux (AppImage/deb)** targets so the user can build distributables later.
- Do NOT bundle copyrighted music or the user's logo in the repo.
- Keep code clean and minimal-comment (user dislikes over-commented code and AI filler). Comment only non-obvious logic (FFT windowing, frame-sync math, ffmpeg pipe).

## Build order (suggested for Claude Code)
1. Scaffold Electron app, get a window with file picker working.
2. Decode wav + offline frame-locked FFT; log FFT frames for a short clip to verify.
3. WebGL2 canvas + the **radial** visualizer first; preview live in-window against the loaded audio.
4. Wire the **quick test render** (5–10s) → pipe raw frames → ffmpeg NVENC → play result. Get this fully working before scaling up.
5. Add linear + waveform visualizers.
6. Add all customization controls + preset save/load.
7. Full-length render path with progress + cancel.
8. NVENC capability probe + libx264 fallback + clear messaging.
9. GitHub prep (README, LICENSE, gitignore, electron-builder config).

## User context / preferences
- Communicates concisely; dislikes verbose output, over-commented code, AI-style filler.
- Iterates with short low-cost test renders before full encodes — bake this into the UX.
- Prefers seeing clear options and making the call themselves.
- Environment: Windows primary (also wants Linux support), RTX 4070, has ffmpeg already (resolve the NVENC driver mismatch).
- This is for DJ Windy (djwindy.com) — NCS-radial-around-logo is the priority aesthetic.

---
When you start, confirm Node + ffmpeg are present, run the NVENC probe, then proceed in the build order above. Test-render early and often.
