# Base image pinned to torch==2.5.1 + cu121, matching LatentSync's own
# requirements.txt exactly (verified pullable: `docker manifest inspect
# pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime` succeeds).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/lux-lipsync

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# face_detector_mediapipe.py's default model_asset_path is
# "checkpoints/auxiliary/face_landmarker.task", resolved relative to this
# WORKDIR at runtime (runner.py never chdirs). Bake it in at build time --
# it's small (~3.6MB) and Apache-2.0, so there's no reason to make it a
# network-volume dependency like the multi-GB weights below. Hash pinned to
# model-manifest.json's already-verified entry; the build fails loudly if
# either side of this ever drifts instead of silently shipping a
# tampered/wrong asset.
RUN mkdir -p checkpoints/auxiliary \
    && curl -fsSL -o checkpoints/auxiliary/face_landmarker.task \
       https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task \
    && echo "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  checkpoints/auxiliary/face_landmarker.task" | sha256sum -c -

# The MediaPipe-based face detector replacement is already baked into
# source/latentsync/utils/face_detector.py (see source/PROVENANCE.md) --
# no separate override COPY is needed here.
COPY source ./source
COPY runner.py ./runner.py
COPY model-manifest.json ./model-manifest.json
COPY handler.py ./handler.py

ENV PYTHONUNBUFFERED=1 \
    LUX_WORKER_MODE=real \
    HF_HUB_OFFLINE=1

CMD ["python", "-u", "/opt/lux-lipsync/handler.py"]
