import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import provider_gateway
import server
import video_os_backend as video_os


KIT = {
    "background": {"name": "Static Background 1.mp4"},
    "lut": {"name": "Creative : Bright & Saturated : Strong.cube"},
    "music": {"name": "Crystal Clear - Kellin.wav"},
    "cta": {"name": "Like and Subscribe ProRes.mov"},
    "overlay": {"name": "78-Hundred-Points.gif"},
}

PAYLOAD = {
    "title": "Phase 2 Canary",
    "audience": "Lux buyers",
    "goal": "Prove render reliability with selected avatar voice and kit.",
    "script": "A short regression canary for Video OS Lite.",
    "provider": "heygen",
    "format": "vertical",
    "avatar": {"id": "avatar-1", "name": "OSO CONSULTING", "source": "heygen"},
    "voice": {"id": "voice-1", "name": "OSO CONSULTING", "source": "heygen"},
    "productionKit": KIT,
    "music": True,
    "accountId": "acct-phase-2",
}


class ProviderGatewayPhase2Tests(unittest.TestCase):
    def test_render_with_provider_debits_once_and_returns_normalized_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            credits_file = Path(tmp) / "credits.json"
            credits_file.write_text(json.dumps({"balance": 200, "currency": "credits", "ledger": []}), encoding="utf-8")
            project = {"id": "project-1", "telemetry": {}, "providerJobId": "video-1"}

            with patch.object(provider_gateway, "CREDITS_FILE", credits_file), \
                 patch.object(provider_gateway, "create_lite_project", return_value=project), \
                 patch.object(provider_gateway, "_submit_heygen", return_value={"data": {"video_id": "video-1"}}), \
                 patch.object(video_os, "update_project", side_effect=lambda _id, patch_data: {**project, **patch_data}):
                result = provider_gateway.render_with_provider(dict(PAYLOAD))

            self.assertEqual(result["stage"], provider_gateway.RENDER_STAGE_SUBMITTED)
            self.assertEqual(result["status"], provider_gateway.RENDER_STAGE_SUBMITTED)
            self.assertEqual(result["providerJobId"], "video-1")
            self.assertEqual(result["credits"]["balance"], 110)
            self.assertEqual(result["credits"]["ledger"][-1]["amount"], -90)
            self.assertEqual(result["accountId"], "acct-phase-2")
            self.assertEqual(result["credits"]["ledger"][-1]["accountId"], "acct-phase-2")

    def test_submit_failure_does_not_debit_credits(self):
        with tempfile.TemporaryDirectory() as tmp:
            credits_file = Path(tmp) / "credits.json"
            credits_file.write_text(json.dumps({"balance": 200, "currency": "credits", "ledger": []}), encoding="utf-8")
            project = {"id": "project-1", "telemetry": {}}

            with patch.object(provider_gateway, "CREDITS_FILE", credits_file), \
                 patch.object(provider_gateway, "create_lite_project", return_value=project), \
                 patch.object(provider_gateway, "_submit_heygen", return_value={"status": "failed", "error": "avatar consent required"}), \
                 patch.object(video_os, "update_project", return_value=project):
                with self.assertRaises(video_os.VideoOsError):
                    provider_gateway.render_with_provider(dict(PAYLOAD))

            credits = json.loads(credits_file.read_text(encoding="utf-8"))
            self.assertEqual(credits["balance"], 200)
            self.assertEqual(credits["ledger"], [])

    def test_non_heygen_poll_returns_normalized_rendering_stage(self):
        result = provider_gateway.poll_provider_render({"provider": "tavus", "projectId": "p1", "providerJobId": "v1"})

        self.assertFalse(result["ready"])
        self.assertEqual(result["stage"], provider_gateway.RENDER_STAGE_RENDERING)
        self.assertEqual(result["status"], provider_gateway.RENDER_STAGE_RENDERING)
    def test_poll_consent_failure_returns_needs_consent(self):
        job = {"status": "failed", "error": "avatar consent required", "result": {"status": "failed"}}
        with patch.object(video_os, "create_job", return_value={"id": "job-1"}), \
             patch.object(video_os, "process_job", return_value=job):
            result = provider_gateway.poll_provider_render({"provider": "heygen", "projectId": "p1", "providerJobId": "v1"})

        self.assertFalse(result["ready"])
        self.assertEqual(result["stage"], provider_gateway.RENDER_STAGE_NEEDS_CONSENT)
        self.assertIn("consent", result["message"].lower())

    def test_poll_success_returns_provider_ready_with_source_url(self):
        job = {"status": "completed", "result": {"data": {"status": "completed", "video_url": "https://example.com/video.mp4"}}}
        with patch.object(video_os, "create_job", return_value={"id": "job-1"}), \
             patch.object(video_os, "process_job", return_value=job):
            result = provider_gateway.poll_provider_render({"provider": "heygen", "projectId": "p1", "providerJobId": "v1"})

        self.assertTrue(result["ready"])
        self.assertEqual(result["stage"], provider_gateway.RENDER_STAGE_READY)
        self.assertEqual(result["sourceUrl"], "https://example.com/video.mp4")


class FinalizePhase2Tests(unittest.TestCase):
    def test_existing_final_render_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            exports = Path(tmp)
            final = exports / "phase-2-canary-final-vertical-123.mp4"
            final.write_bytes(b"mp4")
            final.with_suffix(".json").write_text(json.dumps({
                "title": "Phase 2 Canary",
                "projectId": "project-1",
                "providerJobId": "video-1",
                "format": "vertical",
                "productionKit": KIT,
                "effects": {"music": KIT["music"]["name"]},
                "assetSources": {"music": "local"},
            }), encoding="utf-8")

            payload = {**PAYLOAD, "projectId": "project-1", "providerJobId": "video-1"}
            with patch.object(server, "EXPORTS", exports), \
                 patch.object(server.shutil, "which", return_value="ffmpeg"), \
                 patch.object(server, "resolve_provider_source", side_effect=AssertionError("should not resolve source for existing final")), \
                 patch.object(server, "patch_lite_project_render_state"):
                result = server.finalize_provider_mp4(payload)

        self.assertTrue(result["ready"])
        self.assertTrue(result["idempotent"])
        self.assertEqual(result["filename"], final.name)

    def test_finalize_creates_sidecar_and_second_call_reuses_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            exports = Path(tmp) / "exports"
            exports.mkdir()
            source = Path(tmp) / "source.mp4"
            source.write_bytes(b"source")
            payload = {**PAYLOAD, "projectId": "project-2", "providerJobId": "video-2"}

            def fake_run(cmd, **_kwargs):
                Path(cmd[-1]).write_bytes(b"final")
                return None

            with patch.object(server, "EXPORTS", exports), \
                 patch.object(server.shutil, "which", return_value="ffmpeg"), \
                 patch.object(server, "resolve_provider_source", return_value=source), \
                 patch.object(server, "kit_asset", return_value={"path": None, "name": "Auto", "source": "fallback"}), \
                 patch.object(server, "has_audio_stream", return_value=False), \
                 patch.object(server.subprocess, "run", side_effect=fake_run), \
                 patch.object(server, "patch_lite_project_render_state"):
                first = server.finalize_provider_mp4(payload)
                second = server.finalize_provider_mp4(payload)

            sidecar = exports / first["filename"].replace(".mp4", ".json")
            data = json.loads(sidecar.read_text(encoding="utf-8"))

        self.assertTrue(first["ready"])
        self.assertFalse(first.get("idempotent", False))
        self.assertTrue(second["idempotent"])
        self.assertEqual(second["filename"], first["filename"])
        self.assertEqual(data["avatar"]["name"], "OSO CONSULTING")
        self.assertEqual(data["voice"]["name"], "OSO CONSULTING")
        self.assertEqual(data["productionKit"], KIT)
        self.assertEqual(data["accountId"], "acct-phase-2")


if __name__ == "__main__":
    unittest.main()


