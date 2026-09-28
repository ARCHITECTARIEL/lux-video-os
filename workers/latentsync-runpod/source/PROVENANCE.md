# Provenance

Vendored from: https://github.com/bytedance/LatentSync
Pinned commit: `a229c3948406bc2cf6eaf4873e662e70c6a04746` (tip of `main` as of
this vendoring; upstream has had no commits since 2025-06-20, so this is
already a stable pin, not an arbitrary point-in-time snapshot).
Date vendored: 2026-09-27
Upstream license: Apache License 2.0 (`LICENSE` in this directory, copied
verbatim from the pinned commit).

## What was kept vs. trimmed

Only the inference-time code path was vendored. Confirmed by tracing every
import starting from `scripts/inference.py` (upstream) and
`latentsync/pipelines/lipsync_pipeline.py`:

**Kept:**
- `latentsync/models/{unet,unet_blocks,attention,motion_module,resnet,utils}.py`
  — the U-Net architecture itself.
- `latentsync/pipelines/lipsync_pipeline.py` — the diffusion pipeline.
- `latentsync/utils/{util,affine_transform,av_reader,image_processor,mask.png}`
  — video I/O and face-crop/mask preprocessing.
- `latentsync/whisper/` (whole subpackage, including its own vendored OpenAI
  Whisper fork and tokenizer assets) — audio-to-embedding.
- `configs/unet/*.yaml`, `configs/scheduler_config.json` — model + scheduler
  config, used exactly as `scripts/inference.py` loads them.

**Dropped (training/eval-only, never imported by the inference path):**
- `latentsync/data/` (dataset loaders for training)
- `latentsync/trepa/` (a training-time perceptual loss module)
- `latentsync/models/stable_syncnet.py`, `latentsync/models/wav2lip_syncnet.py`
  (SyncNet architectures, imported only by `scripts/train_syncnet.py` and
  `scripts/train_unet.py` — confirmed via
  `grep -rl stable_syncnet\|wav2lip_syncnet` across the whole upstream repo)
- `latentsync/utils/audio.py`, `configs/audio.yaml` (only imported by
  `latentsync/data/*_dataset.py`, which is itself dropped)
- `configs/syncnet/*.yaml` (SyncNet training configs)
- Everything under `preprocess/`, `eval/`, `tools/`, top-level training
  shell scripts, `gradio_app.py`, `predict.py` (a Cog/Replicate wrapper),
  `cog.yaml`.

## Modified: `latentsync/utils/face_detector.py`

**Why:** the original file hard-imports `insightface.app.FaceAnalysis`
with the default `buffalo_l` pack, used on every single inference frame for
face detection and 106-point landmarks (not training-only, as originally
suspected before this file was actually read). InsightFace's own model-zoo
license states "ALL models are available for non-commercial research
purposes only," with no carve-out for using only the detection/landmark
sub-models — a hard blocker for a paid commercial product, confirmed via
dedicated research before this vendoring task began.

**What changed:** the original file is preserved, unused, at
`latentsync/utils/face_detector.insightface-original.py` (never imported by
anything — a reference diff only, do not add it to any import path). The
active `latentsync/utils/face_detector.py` is a from-scratch replacement
backed by MediaPipe's Face Landmarker (Apache-2.0, genuinely commercial),
authored at `workers/latentsync-runpod/face_detector_mediapipe.py` (read
that file's own module docstring for the full design rationale and the
exact landmark-index mapping). It implements the identical
`__call__(frame, threshold=0.5) -> (bbox, landmark_2d_106)` contract, so
nothing else in this vendored tree needed to change.

The landmark-index mapping was verified visually, not just by inspection —
see `workers/latentsync-runpod/tools/verify_face_detector.py` and its
output under `tools/verify-output/`.

## Modified: `latentsync/pipelines/lipsync_pipeline.py` (`affine_transform_video`)

**Why:** a real GPU verification run (2026-09-28, RTX 4090, RunPod) proved
the original behavior of this method: a single video frame with no
detectable face (motion blur, a quick head turn) raises immediately and
aborts the entire job. Confirmed for real, not theorized -- a 242-frame
real test video failed outright at frame 127 this way. This is inherited
from upstream (both the original InsightFace-based detector and the
MediaPipe-based replacement share this all-or-nothing behavior via
`ImageProcessor.affine_transform`'s `RuntimeError("Face not detected")`),
not something introduced by the detector swap -- but it's a real
production risk: one bad frame anywhere in a customer's self-recorded
video would currently kill their entire paid render.

**What changed:** `affine_transform_video` now catches that specific
`RuntimeError` per-frame and falls back to the immediately-preceding
frame's `(face, box, affine_matrix)` rather than propagating. Faces don't
teleport between frames at 25fps, so reusing the last known-good detection
for one transient miss is visually safe -- this is a standard pattern for
video face trackers. Still fails loudly (no silent fallback) if the very
first frame has no prior detection to fall back to. Each fallback prints a
frame-indexed log line, so a customer render that had to lean on this is
visible and auditable in production logs, not silent.

## Known un-audited dependency

`latentsync/whisper/whisper/` is itself a vendored fork of OpenAI's Whisper
(MIT-licensed upstream) that ships with LatentSync's own repo — kept as-is,
not re-fetched from `openai/whisper` directly, to match exactly what
LatentSync's own `Audio2Feature` class expects.
