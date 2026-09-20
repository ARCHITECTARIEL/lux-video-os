# RunPod Standard worker

The Standard provider has two explicit modes:

- `VIDEO_OS_STANDARD_PROVIDER=simulation` (default): local FFmpeg composition. This is not lip-sync inference.
- `VIDEO_OS_STANDARD_PROVIDER=runpod`: asynchronous RunPod submit/poll plus verified private output persistence.

## Application configuration

Set these only on the server-side Vercel/VPS environment:

- `VIDEO_OS_STANDARD_PROVIDER=runpod`
- `VIDEO_OS_RUNPOD_ENDPOINT_ID=<endpoint id>`
- `RUNPOD_API_KEY=<secret>`
- Optional limits: `VIDEO_OS_RUNPOD_TIMEOUT_MS`, `VIDEO_OS_RUNPOD_MAX_INPUT_BYTES`, `VIDEO_OS_RUNPOD_MAX_OUTPUT_BYTES`

The adapter reads the already-authorized private portrait and narration, verifies their stored SHA-256 identities, sends a bounded base64 request to RunPod's asynchronous `/run` endpoint, polls `/status/<job id>`, validates the returned MP4/hash/size, and stores it in the account's private final namespace.

The current transport is intentionally bounded to 7 MB combined input and 7 MB output so base64 expansion stays inside RunPod queue payload/result limits. Oversized sources fail before provider submission.

## Worker image

Build `workers/sadtalker-runpod/Dockerfile` for `linux/amd64` with an immutable tag:

```powershell
docker build --platform linux/amd64 -t ghcr.io/architectariel/lux-video-os-sadtalker-runpod:<version> workers/sadtalker-runpod
```

The worker defaults to `LUX_WORKER_MODE=real` and fails closed unless these paths exist:

- `/opt/sadtalker/runner.py`
- `/opt/sadtalker/model-manifest.json`
- `/opt/sadtalker/source`
- `/runpod-volume/models`

The checked-in lightweight image is therefore an infrastructure transport image, not yet a real SadTalker image. For the first endpoint plumbing proof only, set `LUX_WORKER_MODE=simulation` on the RunPod template and set `VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT=true` on the matching isolated Vercel preview. Every returned artifact remains marked `simulation: true`.

Never enable simulated output for a real canary or production. A real canary requires the pinned SadTalker runtime, verified model manifest/checksums, private model volume, and a non-simulated result.

## Deployment order

1. Build and run the image locally in simulation mode.
2. Push an immutable image tag/digest to the approved registry.
3. Create a RunPod serverless template with `LUX_WORKER_MODE=simulation` for the infrastructure proof, workers minimum `0`, maximum `1`.
4. Create the queue endpoint without pinning a data center unless a model volume requires it.
5. Send one real non-sensitive fixture request and verify its hash-bound result.
6. Configure an isolated Vercel preview with the endpoint ID/key and simulated-output flag.
7. Prove the browser/API/job/download flow.
8. Replace the template with the real runtime/model mount, remove the simulated-output flag, and run one separately authorized GPU canary.
