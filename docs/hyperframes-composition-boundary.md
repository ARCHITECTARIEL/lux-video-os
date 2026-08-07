# HyperFrames composition boundary

## Decision

Video OS keeps HeyGen as the avatar, voice, presenter-motion, and provider-job engine. HyperFrames 0.7.64 is the opt-in final composition engine. A durable Workflow step remains the controller; rendering runs in a short-lived Vercel Sandbox restored from a pinned snapshot; the controller validates the MP4 and writes it through the existing private Blob gateway before finalizing the job.

```text
Vercel Workflow
  -> allowlisted, DNS-pinned retrieval of the authorized HeyGen MP4
  -> ephemeral Vercel Sandbox (4 vCPU / 8 GB, 10-minute cap)
       -> HyperFrames 0.7.64 + Chrome Headless Shell + FFmpeg
       -> bounded LUX HTML composition
  -> MP4 signature, size, SHA-256 validation
  -> private Blob final
  -> existing transactional job finalization
  -> Final Cut Preview
```

The current FFmpeg finisher remains the default. HyperFrames is selected only when both `VIDEO_OS_COMPOSITION_ENGINE=hyperframes` and `VIDEO_OS_HYPERFRAMES_ENABLED=true` are present, and a valid `VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID` is mandatory. A selected HyperFrames failure never falls back to FFmpeg because that could silently finalize an uncomposed video.

## Inspection findings

1. HyperFrames was not present in dependencies, scripts, skills, or executable finishing code. Existing mentions were product copy only.
2. The local proof host runs Node.js 24.14.1. The Vercel project requests Node 24.x; the generated Workflow step currently targets Node 22.x on Linux ARM64.
3. Local FFmpeg is the Gyan 8.1.2 full build with H.264/H.265/AV1, AAC, libass, FreeType, and hardware encoder support. The existing deployed step stages the platform-correct `ffmpeg-static` binary.
4. `workflows/video-render.js` durably submits and polls HeyGen, then calls `services/media-finisher.js` in a Workflow step.
5. The existing finisher therefore runs inside the generated Vercel Workflow step Function, using `/tmp`; it is not a local worker or container.
6. The generated step is Node 22.x ARM64 with an unbounded Workflow step duration declaration, but the underlying Function class remains CPU, memory, bundle, ephemeral-disk, and request-lifecycle constrained. Vercel's published baseline is 2 GB / 1 vCPU, with higher Pro configurations available; Function payloads are capped at 4.5 MB and duration is plan/config dependent.
7. HyperFrames is not a safe fit inside that existing Function bundle/runtime. It needs Chrome, FFmpeg, native libraries, substantial cache/disk, and multiple minutes for longer videos. HeyGen's own Vercel reference uses Vercel Sandbox Firecracker microVMs and a prepared snapshot for this reason.
8. The existing FFmpeg path already performs crop/scale, light color treatment, a top bar, synthetic music mixing, H.264/AAC encoding, private storage, and artifact hashing. HyperFrames supersedes the visual assembly and encoding portion; private retrieval, validation, storage, state transitions, and finalization remain shared infrastructure.
9. The authoritative `heygen-com/hyperframes` repository and npm package are Apache-2.0. HyperFrames 0.7.64 requires Node >=22 and brings Puppeteer/Chrome, FFmpeg, and a large transitive dependency graph. `@vercel/sandbox` 2.8.0 is also Apache-2.0. Exact pins and a prepared snapshot prevent an unreviewed `latest` install at render time.
10. HyperFrames uses deterministic timeline seeking. Two same-host Windows renders were byte-identical, including decoded frames. Separate Linux Sandbox instances produced identical decoded audio and perceptually equivalent video (SSIM 0.996207), but not byte-identical MP4s or decoded-frame hashes even with one worker and browser GPU disabled. The job model can safely use each successful result as an immutable, content-addressed artifact, but must not predict its SHA-256 before rendering. Exact golden hashes are environment-local; upgrades to the engine, browser, fonts, FFmpeg, composition, or compute image require a new proof.

## Private composition proof

- Source job: `job-76d8d77b-07d7-4453-805d-14632580a0ab`
- Source: 951,537 bytes; SHA-256 `b13d1610c9ba56ffd79089c99e425c710b098f1fd9466f393f36d9ff11dc4674`
- HyperFrames: 0.7.64, authoritative npm package from `heygen-com/hyperframes`
- Composition: `lux-marketing-proof`, 1920x1080, 30 fps, 5.24 seconds, 158 rendered frames
- Gate: zero runtime/layout/motion/contrast errors; 106 motion samples and 18 WCAG contrast checks passed
- Output A/B: 3,996,519 bytes each; byte-identical SHA-256 `89a025f38b246f94c3444d20f6342301bbed6b2f69a4563b29b293636e3d8832`
- Decoded-frame manifest A/B SHA-256: `9153745f15167407b9ea308fd2b8b7c7f91b77bdaa02e6c8417f1b6607e071f0`
- Output streams: H.264 yuv420p 1920x1080 at 30 fps; AAC 48 kHz stereo; 5.269333 seconds
- Vercel Sandbox proof: restored a 1,502,072,173-byte pinned snapshot into ephemeral Node 22 compute with 4 vCPU / 8 GB and completed in 67-94 seconds
- Software Sandbox A/B: 3,783,585 and 3,790,578 bytes; SHA-256 `a9bb7690ab47266773de25984d8dd07e6becd7c33bd1e4b5704f2a9cdc2d0edb` and `847232b34333a4ddb891be0629e2b93ac2eefba6dd6f8ec196fb6a16c789421c`
- Sandbox reproducibility: decoded audio hashes identical; video SSIM 0.996207 across isolated instances; source-to-composed SSIM 0.617235 proves the result is materially different from a copy

The proof files remain ignored and private. No new HeyGen job was submitted and no source or final asset was made public.

## Snapshot and rollout

`npm run hyperframes:snapshot` creates the supported Linux Node 22, 4-vCPU snapshot with exact engine and media-tool pins. It is intentionally a manual, side-effectful operation; the resulting ID must first be placed in Preview. Preview should run the same private proof input through the Sandbox path and verify output provenance before Production configuration is considered.

Rollback is configuration-only: remove `VIDEO_OS_COMPOSITION_ENGINE=hyperframes` or set it back to `ffmpeg`. The existing finishing implementation is retained unchanged apart from exporting its private source-retrieval and hashing helpers.

## Residual risks

- The bounded composition is landscape-only. Portrait and square jobs fail closed until dedicated compositions are proven.
- The controller currently buffers the authorized provider input once to transfer it into Sandbox. The existing 250 MB source cap keeps this below the Function memory boundary, but a future larger limit should move to a streamed transfer mechanism.
- `npm audit --omit=dev` reports zero runtime vulnerabilities. The full development/snapshot graph reports advisories, including an unfixed high-severity `adm-zip` issue inherited by HyperFrames through `onnxruntime-node`. Snapshot creation accepts only pinned packages and the runtime Sandbox accepts only controlled local composition/media files with font-only egress, reducing exposure; the advisory remains an upgrade gate.
- Snapshot IDs expire after seven days in this proof workflow. Preview rollout needs an explicit rotation/retention procedure before enabling the engine.
