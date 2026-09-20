"""RunPod queue worker for the Video OS Standard rendering contract.

The default mode is ``real`` and fails closed unless the verified SadTalker
runtime and model mount are present. ``simulation`` exists only for an explicit
infrastructure proof; its result is marked and rejected by the application
unless VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT=true.
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


MAX_INPUT_BYTES = int(os.getenv("LUX_MAX_INPUT_BYTES", "7000000"))
MAX_OUTPUT_BYTES = int(os.getenv("LUX_MAX_OUTPUT_BYTES", "7000000"))
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
        "portrait": {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"},
        "audio": {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3"},
    }
    try:
        return allowed[kind][mime_type]
    except KeyError as error:
        raise ValueError(f"unsupported {kind} MIME type") from error


def _run_simulation(portrait: Path, audio: Path, output: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-i", str(portrait), "-i", str(audio),
            "-vf", "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1,format=yuv420p",
            "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "25",
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(output),
        ],
        check=True,
        timeout=180,
    )


def _run_real(portrait: Path, audio: Path, output: Path, job_id: str) -> None:
    runner = Path(os.getenv("SADTALKER_RUNNER", "/opt/sadtalker/runner.py"))
    manifest = Path(os.getenv("SADTALKER_MANIFEST", "/opt/sadtalker/model-manifest.json"))
    model_dir = Path(os.getenv("SADTALKER_MODEL_DIR", "/runpod-volume/models"))
    source_dir = Path(os.getenv("SADTALKER_SOURCE_DIR", "/opt/sadtalker/source"))
    if not runner.is_file() or not manifest.is_file() or not model_dir.is_dir() or not source_dir.is_dir():
        raise RuntimeError("real SadTalker runtime or verified model mount is unavailable")
    job_path = output.parent / "runner-job.json"
    job_path.write_text(json.dumps({
        "jobId": job_id,
        "portraitPath": str(portrait),
        "audioPath": str(audio),
        "outputPath": str(output),
        "timeoutSeconds": int(os.getenv("SADTALKER_TIMEOUT_SECONDS", "900")),
    }), encoding="utf-8")
    subprocess.run(
        [
            "python", str(runner), "--job", str(job_path), "--manifest", str(manifest),
            "--model-dir", str(model_dir), "--source-dir", str(source_dir),
        ],
        check=True,
        timeout=int(os.getenv("SADTALKER_TIMEOUT_SECONDS", "900")) + 30,
    )


def render(job_input: object) -> dict:
    if not isinstance(job_input, dict) or job_input.get("schemaVersion") != 1:
        raise ValueError("unsupported Standard worker input")
    job_id = str(job_input.get("jobId") or "")
    if not ID_PATTERN.fullmatch(job_id):
        raise ValueError("job id is invalid")
    portrait_bytes, portrait_mime = _decode_asset(job_input.get("portrait"), "portrait")
    audio_bytes, audio_mime = _decode_asset(job_input.get("drivenAudio"), "driven audio")
    if len(portrait_bytes) + len(audio_bytes) > MAX_INPUT_BYTES:
        raise ValueError("combined source payload is too large")
    mode = str(os.getenv("LUX_WORKER_MODE", "real")).strip().lower()
    if mode not in {"real", "simulation"}:
        raise RuntimeError("unsupported worker mode")

    with tempfile.TemporaryDirectory(prefix="lux-standard-") as directory:
        root = Path(directory)
        portrait = root / f"portrait{_extension(portrait_mime, 'portrait')}"
        audio = root / f"audio{_extension(audio_mime, 'audio')}"
        output = root / "result.mp4"
        portrait.write_bytes(portrait_bytes)
        audio.write_bytes(audio_bytes)
        if mode == "simulation":
            _run_simulation(portrait, audio, output)
        else:
            _run_real(portrait, audio, output, job_id)
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
