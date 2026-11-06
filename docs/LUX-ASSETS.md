# Luxify local assets

`tools/luxify-local.mjs` reads fonts, LUTs, music and overlays from one folder
on the render PC. Default: `%USERPROFILE%\lux-assets` on Windows (`~/lux-assets`
elsewhere). Override with the `LUX_ASSETS_DIR` env var or `--assets <dir>`.
None of these files are committed to this public repo.

```
%USERPROFILE%\lux-assets\
  fonts\      lux-sans.ttf, lux-sans-bold.ttf, lux-serif.ttf   (brief "fontPreset")
  luts\       <name>.cube   3D LUT, referenced by brief "lut"
  music\      <name>.mp3 | .wav | .m4a   licensed bed, brief "music.track"
  overlays\   <name>.png   transparent logo/bug, brief "logoOverlay"
```

Brief paths for `lut`, `music.track` and `logoOverlay` are bare file names
inside those folders (no `..`, no URLs). The voice track is a HeyGen audio file
you have already downloaded (`voice.path`, relative to the brief folder); the
tool never calls HeyGen. Shot reference images (`promptImage`) must be local
png/jpeg/webp files of 5 MB or less inside the brief folder or this assets folder.

Requirements: an ffmpeg build with `drawtext, xfade, sidechaincompress,
loudnorm, lut3d, overlay` (the Gyan "full" build qualifies). Resolution order:
`--ffmpeg`, then `LUX_FFMPEG_PATH`, then `ffmpeg` on PATH. The bundled
`ffmpeg-static` lacks drawtext and is not used.

Run: `node tools/luxify-local.mjs --brief video_productions/<slug>/brief.json`
prints the plan and estimated cost (dry run, default).

Live mode needs all three: `--live`, `VIDEO_OS_RUNWAY_ENABLED=true` (exact
string) and `RUNWAYML_API_SECRET` in the process environment. It refuses any
plan above $1 per clip or $10 per video before submitting anything.

Receipt and resume:
- `<out>/receipt.json` records every Runway attempt (task id, status, credits).
  Each task id is saved before polling. Writes are atomic (temp file, fsync,
  rename).
- If a run stops with submitted/unresolved tasks, a rerun on the same `--out`
  refuses to start. Add `--resume` to reconcile those task ids with Runway
  (poll only, no resubmit), reuse stored clips, and continue.
- The $10 cap is cumulative across runs: stored, submitted, unresolved and
  non-refunded (SAFETY.INPUT) credits all count.
- The previous receipt is copied to `<out>/receipt-history/` before each resumed
  run. Outputs are never overwritten: run N writes `final.mp4` (first run) or
  `final-runN.mp4`, with intermediates under `work/runN/`.
