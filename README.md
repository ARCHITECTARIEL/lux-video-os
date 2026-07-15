# Video OS Lite

Consumer-ready MVP for creating a short AI presenter video from a guided brief.

The root app (`/`) is Video OS Lite: a simple create-video wizard for goal, script, avatar, voice, brand, preview, and export. The existing advanced LUX Video OS cockpit remains available at `/dashboard` for local operator workflows.

## Current Production State - 2026-07-10

- Live public MVP: https://lux-video-os.vercel.app.
- Consumer app stays at / with Create, Preview, Credits, Account, and top-right sign-in.
- Advanced LUX Video OS cockpit remains at /dashboard for operator and future advanced workflows.
- Demo/admin access is configured through environment variables; do not commit passwords or provider keys.
- CEO/product brief: [Video OS Lite CEO Brief](docs/video-os-lite-ceo-brief-2026-07-10.md).
- Next product focus: account-owned latest 30 render history, stronger result gallery, and full live HeyGen end-to-end QA.
## Local

```powershell
cd C:\Users\ariel\lux-video-os
python .\server.py
```

Open:

```text
http://127.0.0.1:8789/
http://127.0.0.1:8789/dashboard
```

## What The MVP Includes

- Consumer dashboard at `/`.
- Create-video wizard.
- Script assistant.
- Avatar selector.
- Voice selector with consent checkbox.
- Brand controls for colors, logo URL, captions, and music.
- Generation progress UI.
- Preview state.
- Export controls for vertical, landscape, and square.
- Local FFmpeg MP4 draft export through `/api/video-os-lite/export`.
- Browser fallback that downloads a project brief when the local engine/export is unavailable.

## Worker

```powershell
python .\scripts\video_os_worker.py --once
python .\scripts\video_os_worker.py --drain
python .\scripts\video_os_worker.py --interval 10
```

## Smoke Test

Start the server first, then run:

```powershell
python .\scripts\video_os_lite_smoke.py
```

The smoke test checks health, talent loading, script generation, project creation, and local MP4 export.

## Environment

See [ENVIRONMENT.md](ENVIRONMENT.md) for configuration and secret handling.

## Architecture And Audit

- [Architecture summary](docs/video-os-lite-architecture.md)
- [Repository audit](docs/video-os-lite-audit.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)

## Security Notes

This codebase is currently a local single-user MVP. Do not expose `server.py` beyond `127.0.0.1` without adding authentication, CSRF/origin checks, and redacted consumer-facing API responses. Do not commit `data/`, generated exports, or provider credentials.

## Deploy

```powershell
npx vercel deploy --yes
```

Do not deploy `data/` or real credentials. Live HeyGen submission requires explicit live-render handling plus `HEYGEN_API_KEY` or `HEYGEN_TOKEN` in the server/worker environment.

