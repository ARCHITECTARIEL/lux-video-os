# Luxify local assets

`tools/luxify-local.mjs` reads fonts, LUTs, music and overlays from one folder
on the render PC. Default: `C:\Users\ariel\lux-assets` (override with `--assets <dir>`).
None of these files are committed to this public repo.

```
C:\Users\ariel\lux-assets\
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
prints the plan and estimated cost (dry run, default). `--live` is the explicit opt-in (it enables the
Runway adapter for this process only), needs `RUNWAYML_API_SECRET` in the
process environment, and refuses any plan above $1 per clip or $10 per video.
The output folder gets `final.mp4` and `receipt.json` (task ids, credits,
asset hashes; no secrets, no signed URLs). Each Runway task id is written to
the receipt before polling, so an interrupted run can be checked instead of
resubmitted.
