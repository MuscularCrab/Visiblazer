# Optional bundled ffmpeg

Visiblazer detects ffmpeg at runtime and prefers a full build with `h264_nvenc`
+ `libx264`. To **bundle** a static ffmpeg with the packaged app instead of
relying on a system/winget install, place binaries here:

```
ffmpeg/win32/ffmpeg.exe   ffmpeg/win32/ffprobe.exe
ffmpeg/linux/ffmpeg       ffmpeg/linux/ffprobe
```

They take detection priority and are shipped via `extraResources` in
`electron-builder`. These binaries are **not** committed to git (see
`.gitignore`) — download them per platform from https://www.gyan.dev/ffmpeg/
(Windows) or your distro / https://johnvansickle.com/ffmpeg/ (Linux).
