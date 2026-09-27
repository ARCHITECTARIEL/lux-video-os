"""RunPod queue worker for the Video OS Standard rendering contract.

The default mode is ``real`` and fails closed unless the verified LatentSync
runtime and model mount are present. ``simulation`` exists only for an explicit
infrastructure proof; its result is marked and rejected by the application
unless VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT=true.

Input is a short self-recorded video (not a still photo -- LatentSync is a
video-to-video lip-resync model, it has no mechanism to animate a still
image). See workers/latentsync-runpod/source/PROVENANCE.md for why this
worker exists instead of workers/sadtalker-runpod/.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


MAX_INPUT_BYTES = int(os.getenv("LUX_MAX_INPUT_BYTES", "40000000"))
# 40MB default -- sized for a ~15-20s self-recorded clip at reasonable mobile
# recording bitrate, NOT a precise figure. This is a placeholder for product
# to tune against real recording sizes once the Identity Studio video-record
# flow exists; the original 7MB default (workers/sadtalker-runpod/handler.py)
# was sized for a single still photo and is far too small for a video.
MAX_OUTPUT_BYTES = int(os.getenv("LUX_MAX_OUTPUT_BYTES", "40000000"))
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,255}$")


def _decode_asset(value: object, label: str) -> tuple[bytes, str]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} is required")
    encoded = value.get("base64")
    expected = str(value.get("sha256") or "").lower()
    if not isinstance(encoded, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError(f"{label} identity is invalid")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"{label} encoding is invalid") from error
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ValueError(f"{label} size is invalid")
    observed = hashlib.sha256(payload).hexdigest()
    if observed != expected:
        raise ValueError(f"{label} hash mismatch")
    return payload, str(value.get("mimeType") or "")


def _extension(mime_type: str, kind: str) -> str:
    allowed = {
        "sourceVideo": {"video/mp4": ".mp4", "video/webm": ".webm"},
        "audio": {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3"},
    }
    try:
        return allowed[kind][mime_type]
    except KeyError as error:
        raise ValueError(f"unsupported {kind} MIME type") from error


def _run_simulation(source_video: Path, audio: Path, output: Path) -> None:
    # Input is always a video now (never a still image), so this just
    # remuxes the recorded video against the new audio track rather than
    # the old still-image ffmpeg loop (workers/sadtalker-runpod/handler.py's
    # `-loop 1 -i portrait`, which no longer matches the input type). Still
    # clearly marked simulation: true / workerMode: "simulation" downstream,
    # still gated the same way by VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT.
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source_video), "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0",
            "-vf", "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1,format=yuv420p",
            "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "25",
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(output),
        ],
        check=True,
        timeout=180,
    )


def _run_real(source_video: Path, audio: Path, output: Path, job_id: str) -> None:
    runner = Path(os.getenv("LUX_LIPSYNC_RUNNER", "/opt/lux-lipsync/runner.py"))
    manifest = Path(os.getenv("LUX_LIPSYNC_MANIFEST", "/opt/lux-lipsync/model-manifest.json"))
    model_dir = Path(os.getenv("LUX_LIPSYNC_MODEL_DIR", "/runpod-volume/models"))
    source_dir = Path(os.getenv("LUX_LIPSYNC_SOURCE_DIR", "/opt/lux-lipsync/source"))
    if not runner.is_file() or not manifest.is_file() or not model_dir.is_dir() or not source_dir.is_dir():
        raise RuntimeError("real LatentSync runtime or verified model mount is unavailable")
    job_path = output.parent / "runner-job.json"
    job_path.write_text(json.dumps({
        "jobId": job_id,
        "sourceVideoPath": str(source_video),
        "audioPath": str(audio),
        "outputPath": str(output),
        "timeoutSeconds": int(os.getenv("LUX_LIPSYNC_TIMEOUT_SECONDS", "900")),
    }), encoding="utf-8")
    subprocess.run(
        [
            "python", str(runner), "--job", str(job_path), "--manifest", str(manifest),
            "--model-dir", str(model_dir), "--source-dir", str(source_dir),
        ],
        check=True,
        timeout=int(os.getenv("LUX_LIPSYNC_TIMEOUT_SECONDS", "900")) + 30,
    )


def render(job_input: object) -> dict:
    if not isinstance(job_input, dict) or job_input.get("schemaVersion") != 1:
        raise ValueError("unsupported Standard worker input")
    job_id = str(job_input.get("jobId") or "")
    if not ID_PATTERN.fullmatch(job_id):
        raise ValueError("job id is invalid")
    source_video_bytes, source_video_mime = _decode_asset(job_input.get("sourceVideo"), "source video")
    audio_bytes, audio_mime = _decode_asset(job_input.get("drivenAudio"), "driven audio")
    if len(source_video_bytes) + len(audio_bytes) > MAX_INPUT_BYTES:
        raise ValueError("combined source payload is too large")
    mode = str(os.getenv("LUX_WORKER_MODE", "real")).strip().lower()
    if mode not in {"real", "simulation"}:
        raise RuntimeError("unsupported worker mode")

    with tempfile.TemporaryDirectory(prefix="lux-standard-") as directory:
        root = Path(directory)
        source_video = root / f"source{_extension(source_video_mime, 'sourceVideo')}"
        audio = root / f"audio{_extension(audio_mime, 'audio')}"
        output = root / "result.mp4"
        source_video.write_bytes(source_video_bytes)
        audio.write_bytes(audio_bytes)
        if mode == "simulation":
            _run_simulation(source_video, audio, output)
        else:
            _run_real(source_video, audio, output, job_id)
        payload = output.read_bytes()
        if not payload or len(payload) > MAX_OUTPUT_BYTES or len(payload) < 12 or payload[4:8] != b"ftyp":
            raise RuntimeError("worker output is not an accepted MP4")
        return {
            "mimeType": "video/mp4",
            "videoBase64": base64.b64encode(payload).decode("ascii"),
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "width": 512,
            "height": 512,
            "simulation": mode == "simulation",
            "workerMode": mode,
        }


def handler(job: object) -> dict:
    if not isinstance(job, dict):
        raise ValueError("RunPod job envelope is invalid")
    return render(job.get("input"))


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
