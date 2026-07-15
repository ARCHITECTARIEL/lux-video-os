# Video OS Lite Repository Audit

## What Works

- Local Python server runs the app on `127.0.0.1:8789`.
- `/health`, `/api/video-os`, `/api/video-os/jobs`, and `/api/video-os/talent` are already available.
- Project creation, updates, feedback, job queueing, and worker processing exist.
- Script and scene manifest generation already work through `video_os_backend.py`.
- HeyGen talent sync, submission, and polling are implemented behind environment/credential gates.
- Static public snapshot generation exists for hosted preview mode.

## What Was Reused

- Python local server.
- Talent inventory.
- Project store.
- Existing dashboard at `/dashboard`.
- Existing fallback presets.
- Existing FFmpeg availability on the machine for draft MP4 export.

## What Was Simplified

- Root page now focuses only on the consumer create-video path.
- Goal, script, avatar, voice, brand, generate, preview, and export are presented as one obvious sequence.
- Browser fallback remains available when the local API is not reachable.
- Consumer labels replace internal enterprise language.

## What Should Be Removed From The Consumer MVP

- Internal access gate on the first screen.
- Ops board.
- Last30Days trend tabs.
- Admin controls.
- Raw project/job internals.
- Render provider IDs and local filesystem paths.

## Current Bugs / Debt

- The repository has no package manifest or formal test harness.
- Smoke tests accumulate projects because there is no delete/reset endpoint.
- Public snapshot generation can expose too much local/internal state if deployed carelessly.
- Raw errors are still returned by legacy `/api/video-os` endpoints.
- Local write protection relies on loopback only; production auth is not implemented.

## Competitive UX Takeaways Applied

- Start with intent, not a blank editor.
- Generate a draft quickly, then let users refine.
- Make script text the control plane.
- Treat avatar and voice as reusable identity choices.
- Make brand and captions visible before generation.
- Keep technical model/provider language out of the main flow.
