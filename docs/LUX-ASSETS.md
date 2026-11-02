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

## Avatar shots, themes, captions and the AI label (luxify-local, Nov 2026)

New optional brief fields (the brief stays `luxify-local/v1`):

| Field | Default | Notes |
| --- | --- | --- |
| shot `model: "heygen_avatar"` | n/a | `clip` (a local mp4/mov in the brief folder or assets root), `duration` 1-15 s, optional `clipStart`. No Runway call; the plan estimates HeyGen digital-twin seconds at $0.0667/s and holds them to the $1/clip cap. Clip audio is dropped: the single master `voice` track is the only voice. |
| shot `model: "local_clip"` | n/a | Same as above, for reusing an already-paid clip at $0. |
| `theme` | `dark` | `dark` or `light` (text, plates, end-card background). |
| `captionStyle` | `none` | `kinetic`, `subtitle`, `both` or `none`. |
| `captions[]` | `[]` | Kinetic beats `{text, start, end}` in absolute seconds, at most 4 s each, in order, within the content. More than 3 words per beat gives a warning. |
| `subtitles` | `{sidecar: true}` | `final.vtt` and `final.srt` are always written next to `final.mp4`; `burnIn: true` also burns them in. |
| `bug` | `{enabled: true, opacity: 0.85}` | Corner logo at top-right, using `logoOverlay`. |
| `endCard` | `{enabled: false, duration: 3}` | Appended after the content with an optional `cta` and display `url`. |

The **"AI-generated video and voice"** label is always burned in at bottom-left on its own plate for the full duration, end card included. It can't be turned off: there is no brief field for it, and unknown fields are rejected.

A missing logo PNG is now only a warning. The bug is skipped and the end card renders text-only; the receipt records `overlays.bug: "skipped-logo-missing"`.

A brief made only of local clips has no Runway shots and can't reach Runway, so it renders with `--live` alone, without the Runway flag or secret.

Defaults for the spec's open decisions:

- **D1:** label text "AI-generated video and voice", mandatory.
- **D2:** the end card is appended (not overlaid), 3 s by default (2-6), with a CTA pill and display URL. If there is no logo it is text-only.
- **D3:** 16:9 and 9:16 only (no 1:1). Output stays 1280x720 / 720x1280. Avatar clips are cover-cropped.
- **D4:** no face detection. The caption zones are fixed (kinetic 0.66H, subtitles 0.82H, label bottom-left), so frame the avatar to leave them clear.
- **D5:** no word timings. Kinetic beats come from `captions[]`. Sidecar cues are the verbatim script, split by sentence and timed in proportion to character count over the voice duration (marked approximate in the receipt).
- **D6:** drawtext for everything (no libass/ASS dependency).
- **D7:** no soft-subtitle track in the mp4; sidecars only.
- **D8:** a real person is named only by brief text (lower third). Consent is recorded outside this tool.
- **D9:** no new brand palette. Accent #1A2B9E is never used as text on dark. There is one logo PNG (`logoOverlay`) with no onDark/onLight variants yet. Note that the current LUX logo has dark lettering, which is low-contrast on the navy end card.
- **D10:** `captionStyle` defaults to `none`, so existing briefs render as before plus the label and sidecars.
- **D11:** no brief version bump; every new field is optional.
