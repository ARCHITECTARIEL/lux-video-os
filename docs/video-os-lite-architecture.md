# Video OS Lite Architecture

## Current Architecture

Video OS Lite reuses the existing `lux-video-os` local control plane instead of rebuilding the video backend.

- `server.py`: local HTTP server, static file host, server-sent events, local-only POST gate, and Lite API endpoints.
- `video_os_backend.py`: existing project store, SQLite job queue, talent inventory, script/scene generation, HeyGen submission, polling, archive, and handoff logic.
- `public/index.html`, `public/lite.css`, `public/lite.js`: consumer MVP surface.
- `public/dashboard.html`, `public/app.js`, `public/styles.css`: existing advanced cockpit, still available at `/dashboard`.
- `data/video-os`: private local persistence for projects, jobs, artifacts, trend scans, talent inventory, SQLite, and worker heartbeat.
- `public/video-os.json` and `public/data/video-os.json`: generated public snapshot for the advanced cockpit.

## Reused

- Local-only mutation checks in `server.py`.
- Talent inventory loading and HeyGen fallback presets.
- Existing project creation contract.
- Existing worker/job architecture for future render integrations.
- Existing static fallback pattern for hosted/browser-only demos.

## Simplified For MVP

- The root route is now a single consumer wizard.
- Internal discovery, ops, admin, archive, and handoff controls are hidden from the first screen.
- Script generation is synchronous for the Lite flow.
- Export produces a local FFmpeg MP4 draft when the local server is running, with browser JSON fallback if export is unavailable.

## Hidden Until Later

- Last30Days trend discovery.
- Scheduler controls.
- Admin talent refresh.
- Job queue operations.
- Post-production handoff and artifact archive.
- Live HeyGen submit/poll controls.

## Security Notes

The current server is suitable as a single-user local MVP. It should not be exposed beyond `127.0.0.1` without authentication, CSRF/origin protection, and redacted DTOs for public reads.

## Provider gateway

`provider_gateway.py` is the Lite render orchestration layer. It keeps provider choice, local credits, Stripe checkout creation, and provider-specific submit payloads out of the UI. HeyGen uses the existing `video_os_backend` job path. Argil, Tavus, and D-ID are adapter endpoints controlled by environment variables so the MVP can support multiple render vendors without leaking credentials to the browser.

The Lite UI still supports local FFmpeg draft export. Live provider render is a separate button and returns clear setup errors when a provider is not configured.
