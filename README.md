# Visiblazer

 > ⚡ **Vibe-coded.** This app was built collaboratively with AI (Claude Code) — designed, written, and tested
    through natural-language iteration.
    ![Vibe-coded](https://img.shields.io/badge/vibe--coded-%E2%9A%A1-blueviolet)
	
Offline, GPU-accelerated audio visualizer for DJ sets. Renders a `.wav` (or `.flac`/`.mp3`) into a **1920×1080 / 60fps** H.264 MP4 with the original audio muxed in. Built for long-form sets (2.5hr+) — every frame is rendered deterministically from the audio's FFT and piped straight into `h264_nvenc`, so the output is locked at exactly 60fps no matter how heavy the scene is.

- Frame-by-frame offline render (not screen capture) → perfect 60fps
- **NVENC** on NVIDIA GPUs, automatic **libx264** fallback
- WebGL2 visuals: radial bars + center logo (NCS), minimal **ring** & **dots**, linear spectrum, oscilloscope — with glow/bloom
- Backgrounds: solid, gradient, image, or **video** (visualizer screened over it as additive light)
- Quick test-render (5–10s) before committing to a full set
- Presets, custom colors/glow, logo with bass-pulse, fully offline, no watermark

![screenshot](assets/screenshot.png)
<!-- drop a screenshot at assets/screenshot.png -->

## Requirements

- **Node.js 18+** and npm
- **ffmpeg** — a *full* build with `h264_nvenc` and `libx264`. An audio-only ffmpeg will not work.
  - Windows: `winget install Gyan.FFmpeg`
  - Linux (Debian/Ubuntu): `sudo apt install ffmpeg`
- NVIDIA GPU + current driver for NVENC (the app falls back to CPU libx264 otherwise)

> **NVENC / PATH gotcha (important):** On Windows, a stub `ffmpeg.exe` in `…\WindowsApps\` (often an audio-only build) can shadow the real one on PATH — this is the usual cause of "NVENC failed, fell back to x264". Visiblazer looks **past PATH** and finds the winget-installed full build directly, so it just works. Run `npm run probe` to see which binary it picked and whether NVENC is live.

## Install & run

```bash
npm install
npm start
```

Check your encoder at any time:

```bash
npm run probe
```

Run the built-in end-to-end smoke test (decodes a clip, renders 1s, exits):

```powershell
$env:VISIBLAZER_SELFTEST="C:\path\to\clip.wav"; npm start   # writes %TEMP%\visiblazer\selftest.mp4
```

## Workflow

1. **Import audio** — pick a `.wav`/`.flac`/`.mp3`. It's decoded once to a frame-locked analysis track.
2. **Pick a style + tune** — colors, bars, glow, background, logo (PNG, optional bass-pulse).
3. **⚡ Quick Test Render** — renders a short clip (default 8s) at your exact settings. Iterate here; it's near-instant.
4. **Render Full Set** — choose an output path; watch frames/fps/ETA; play or reveal the result when done.

Settings persist as **presets** (saved JSON under your user data dir).

## Building distributables

```bash
npm run dist:win     # NSIS installer + portable .exe
npm run dist:linux   # AppImage + .deb
```

ffmpeg is detected at runtime (system/winget install). To bundle a static ffmpeg instead, drop binaries in `ffmpeg/win32/ffmpeg.exe` / `ffmpeg/linux/ffmpeg` — they're picked up automatically and shipped via `extraResources`.

## How it works

- **Analysis** (`electron/audio.js`) — ffmpeg decodes to mono s16 @ 48kHz (exactly 800 samples/frame at 60fps). Each frame index does a Hann-windowed FFT (`electron/fft.js`) reduced to log-spaced bands. Deterministic and frame-locked — frame *N* always reflects audio at *N/60s*.
- **Rendering** (`src/renderer/`) — raw WebGL2 draws the scene + separable bloom into an offscreen framebuffer.
- **Pipe** (`electron/render.js`) — frames are read back and transferred zero-copy over a `MessagePort` to the main process, written to ffmpeg stdin with backpressure, and muxed with the original audio. Memory stays bounded across ~540k frames.

## License

MIT — see [LICENSE](LICENSE).
