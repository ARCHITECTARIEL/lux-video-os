# Base image pinned to torch==2.5.1 + cu121, matching LatentSync's own
# requirements.txt exactly (verified pullable: `docker manifest inspect
# pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime` succeeds).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/lux-lipsync

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

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
