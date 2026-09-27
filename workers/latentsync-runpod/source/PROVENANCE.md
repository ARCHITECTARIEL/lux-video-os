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

## Known un-audited dependency

`latentsync/whisper/whisper/` is itself a vendored fork of OpenAI's Whisper
(MIT-licensed upstream) that ships with LatentSync's own repo — kept as-is,
not re-fetched from `openai/whisper` directly, to match exactly what
LatentSync's own `Audio2Feature` class expects.
