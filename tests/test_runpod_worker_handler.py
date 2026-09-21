import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import wave


ROOT = Path(__file__).resolve().parents[1]
HANDLER_PATH = ROOT / "workers" / "sadtalker-runpod" / "handler.py"
SPEC = importlib.util.spec_from_file_location("lux_runpod_handler", HANDLER_PATH)
HANDLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDLER)


def asset(payload, mime_type):
    return {
        "mimeType": mime_type,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "base64": base64.b64encode(payload).decode("ascii"),
    }


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for the infrastructure-proof worker test")
class RunpodWorkerHandlerTest(unittest.TestCase):
    def test_simulation_is_explicit_and_returns_a_hash_bound_mp4(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            portrait = root / "portrait.png"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", str(portrait),
            ], check=True)
            audio = root / "audio.wav"
            with wave.open(str(audio), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\0\0" * 16000)
            prior = os.environ.get("LUX_WORKER_MODE")
            os.environ["LUX_WORKER_MODE"] = "simulation"
            try:
                result = HANDLER.handler({"input": {
                    "schemaVersion": 1,
                    "jobId": "job-worker-proof",
                    "portrait": asset(portrait.read_bytes(), "image/png"),
                    "drivenAudio": {**asset(audio.read_bytes(), "audio/wav"), "durationMs": 1000},
                }})
            finally:
                if prior is None:
                    os.environ.pop("LUX_WORKER_MODE", None)
                else:
                    os.environ["LUX_WORKER_MODE"] = prior
            video = base64.b64decode(result["videoBase64"], validate=True)
            self.assertTrue(result["simulation"])
            self.assertEqual(result["bytes"], len(video))
            self.assertEqual(result["sha256"], hashlib.sha256(video).hexdigest())
            self.assertEqual(video[4:8], b"ftyp")

    def test_real_mode_fails_closed_without_runtime_and_models(self):
        prior = os.environ.get("LUX_WORKER_MODE")
        os.environ["LUX_WORKER_MODE"] = "real"
        payload = b"not-a-real-image-but-hash-bound"
        try:
            with self.assertRaisesRegex(RuntimeError, "runtime or verified model mount"):
                HANDLER.render({
                    "schemaVersion": 1,
                    "jobId": "job-worker-real",
                    "portrait": asset(payload, "image/png"),
                    "drivenAudio": {**asset(payload, "audio/wav"), "durationMs": 1000},
                })
        finally:
            if prior is None:
                os.environ.pop("LUX_WORKER_MODE", None)
            else:
                os.environ["LUX_WORKER_MODE"] = prior


if __name__ == "__main__":
    unittest.main()
