# LUX brand assets (tracked)

The local Luxify renderer (`tools/luxify-local.mjs`) reads assets from this
folder first when `--assets` is not given. Anything missing here falls back to
`LUX_ASSETS_DIR`, or `%USERPROFILE%\lux-assets` (Windows) / `~/lux-assets`. With
`--assets <dir>`, that folder is used first and this one is the fallback.

| Path | Source | License |
|---|---|---|
| `luts/lux-cinematic.cube`, `luts/lux-clean.cube`, `luts/lux-warm.cube` | Generated in-house by OSO Consulting / LUX Video OS (33^3 3D LUTs). Copied from `C:\Users\ariel\lux-assets\luts` on 2026-11-04; SHA-256 verified against the PC. | Owned by OSO Consulting; no third-party rights. |
| `overlays/lux-logo.png` | LUX Digital Marketing logo supplied by Ariel (OSO Consulting), 797x313 RGBA, 2026-11-04. | Owned by OSO Consulting / LUX Digital Marketing. All rights reserved; not covered by any open-source license in this repo. |
| `overlays/lux-logo-dark.png` | Derived from `lux-logo.png` for dark backgrounds: black bar turned white with navy (#09113E) lettering, blue kept, light outline so the blue LUX reads on navy. | Same as `lux-logo.png`. |

## Not tracked (repository is public)

The repo `ARCHITECTARIEL/lux-video-os` was **public** on 2026-11-04, so these
stay in `%USERPROFILE%\lux-assets` and are git-ignored here
(`brand-assets/fonts/`, `brand-assets/music/`):

| File | Source | License |
|---|---|---|
| `fonts/lux-sans.ttf`, `fonts/lux-sans-bold.ttf` | Static instances (wght 500 / 700) of Montserrat, https://github.com/google/fonts/tree/main/ofl/montserrat | SIL Open Font License 1.1. Note: the files are internally named "Montserrat Thin"; the renderer renames a private copy for libass. |
| `fonts/lux-serif.ttf` | Static instance (wght 600) of Playfair Display, https://github.com/google/fonts/tree/main/ofl/playfairdisplay | SIL OFL 1.1 |
| `music/lux-cinematic-below.mp3` | https://archive.org/details/StemCombi1 (mix.mp3) | CC0 1.0 — **owner-asserted** (uploader-declared on Internet Archive, not independently verified). |
| `music/lux-ambient-synthsea.mp3` | "Synth Sea" by Jaros, https://archive.org/details/SynthSea (sea.mp3) | CC0 1.0 — **owner-asserted** (uploader-declared). |

`luts/found/` on the PC is **not** copied: license unknown.

## Never commit

Consent records, receipts, voice/avatar media, HeyGen state and anything with
secrets or personal data. See `.gitignore` (`video_productions/**`).
