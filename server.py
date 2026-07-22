import base64
import hashlib
import hmac
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import video_os_backend as video_os
import provider_gateway


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
EXPORTS = PUBLIC / "exports"
UPLOADS = PUBLIC / "uploads"
ASSETS = ROOT / "data" / "video-os" / "assets"
ASSET_MANIFEST = ASSETS / "asset-manifest.json"
MAX_POST_BYTES = 25_000_000


SESSION_COOKIE = "video_os_lite_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
DEFAULT_SESSION_SECRET = "local-video-os-lite-session-secret"


def session_secret():
    return (os.environ.get("VIDEO_OS_SESSION_SECRET") or DEFAULT_SESSION_SECRET).encode("utf-8")


def session_security_status():
    configured = bool(os.environ.get("VIDEO_OS_SESSION_SECRET"))
    return {
        "configured": configured,
        "status": "ready" if configured else "local_dev",
        "message": "Session secret is configured." if configured else "Set VIDEO_OS_SESSION_SECRET before launch.",
    }


def b64url(data):
    raw = data if isinstance(data, bytes) else data.encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def unb64url(value):
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def sign_session_payload(payload):
    digest = hmac.new(session_secret(), payload.encode("utf-8"), hashlib.sha256).digest()
    return b64url(digest)


def make_session_cookie(account_id):
    account_id = account_id or provider_gateway.default_account_id()
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    payload = f"{account_id}.{expires_at}"
    token = f"{b64url(payload)}.{sign_session_payload(payload)}"
    return f"{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax"


def parse_cookie_header(header):
    cookies = {}
    for part in str(header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def verify_session_token(token):
    try:
        payload_b64, signature = str(token or "").split(".", 1)
        payload = unb64url(payload_b64).decode("utf-8")
        expected = sign_session_payload(payload)
        if not hmac.compare_digest(signature, expected):
            return None
        account_id, expires_at = payload.rsplit(".", 1)
        if int(expires_at) < int(time.time()):
            return None
        return account_id or None
    except Exception:
        return None

class Hub:
    def __init__(self):
        self._clients = set()
        self._lock = threading.Lock()

    def subscribe(self):
        client = queue.Queue(maxsize=20)
        with self._lock:
            self._clients.add(client)
        return client

    def unsubscribe(self, client):
        with self._lock:
            self._clients.discard(client)

    def publish(self, event, data):
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                client.put_nowait({"event": event, "data": data})
            except queue.Full:
                pass


hub = Hub()


def is_loopback(address):
    return address in {"127.0.0.1", "::1", "localhost"}


def worker_pulse(interval):
    while True:
        video_os.publish_public_snapshot()
        hub.publish("video-os", {"videoOs": video_os.publish_public_snapshot()})
        time.sleep(max(3, interval))


def embedded_worker_loop(interval):
    while True:
        try:
            video_os.record_worker_heartbeat("Embedded server worker draining queue.")
            job = video_os.process_next_job()
            if job:
                hub.publish("video-os", {"videoOs": video_os.publish_public_snapshot()})
        except Exception as exc:
            video_os.record_worker_heartbeat(f"Embedded worker error: {exc}")
        time.sleep(max(1, interval))


def scheduler_loop(interval):
    while True:
        try:
            result = video_os.queue_due_scheduled_scans()
            if result.get("queued"):
                hub.publish("video-os", {"videoOs": video_os.publish_public_snapshot()})
        except Exception as exc:
            video_os.record_worker_heartbeat(f"Scheduler error: {exc}")
        time.sleep(max(30, interval))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, fmt, *args):
        return

    def session_account_id(self, payload=None):
        cookies = parse_cookie_header(self.headers.get("Cookie"))
        account_id = verify_session_token(cookies.get(SESSION_COOKIE))
        if account_id:
            return account_id, None
        account_id = provider_gateway.default_account_id()
        return account_id, make_session_cookie(account_id)
    def with_account(self, payload=None):
        account_id, cookie = self.session_account_id(payload)
        enriched = {**(payload or {}), "accountId": account_id}
        return account_id, cookie, enriched
    def do_GET(self):
        if self.path.startswith("/events"):
            self.handle_events()
            return
        if self.path == "/health":
            self.send_json({"ok": True, "app": "lux-video-os"})
            return
        if self.path == "/api/video-os":
            self.send_json({"ok": True, "videoOs": video_os.publish_public_snapshot()})
            return
        if self.path == "/api/video-os/jobs":
            self.send_json({"ok": True, "jobs": video_os.list_jobs()})
            return
        if self.path == "/api/video-os/talent":
            self.send_json({"ok": False, "error": "Provider talent requires the authenticated hosted application."}, HTTPStatus.UNAUTHORIZED)
            return
        if self.path == "/api/video-os-lite/providers":
            account_id, cookie, _payload = self.with_account()
            self.send_json({"ok": True, **provider_gateway.provider_status(account_id)}, cookie=cookie)
            return
        if self.path == "/api/video-os-lite/assets":
            self.send_json({"ok": True, "assets": lite_asset_catalog()})
            return
        if self.path.startswith("/api/video-os-lite/assets/"):
            self.send_lite_asset_file()
            return
        if self.path == "/api/video-os-lite/results":
            account_id, cookie, _payload = self.with_account()
            self.send_json({"ok": True, "accountId": account_id, "results": list_lite_results(account_id=account_id)}, cookie=cookie)
            return
        if self.path == "/api/video-os-lite/account":
            account_id, cookie, _payload = self.with_account()
            self.send_json({"ok": True, "session": {"accountId": account_id, "security": session_security_status()}, **provider_gateway.account_status()}, cookie=cookie)
            return
        if self.path == "/api/video-os/discover-options":
            self.send_json({
                "ok": True,
                "discoverOptions": {
                    **video_os.load_discover_options(),
                    "watchlists": video_os.load_watchlists(),
                    "scanSchedules": video_os.load_scan_schedules(),
                },
            })
            return
        if self.path in ("/dashboard", "/dashboard/"):
            self.path = "/dashboard.html"
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/video-os-lite"):
            self.handle_video_os_lite_post()
            return
        if not self.path.startswith("/api/video-os"):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self.handle_video_os_post()

    def send_json(self, payload, status=HTTPStatus.OK, cookie=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        if not is_loopback(self.client_address[0]):
            raise PermissionError("Video OS write operations are local-only.")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size <= 0 or size > MAX_POST_BYTES:
            raise ValueError("Invalid request size.")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def send_lite_asset_file(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = parsed.path.split("/")
        if len(parts) < 6:
            self.send_error(HTTPStatus.NOT_FOUND, "Asset not found")
            return
        folder = parts[4]
        filename = urllib.parse.unquote(parts[5])
        allowed = {"music", "backgrounds", "luts", "cta", "overlays"}
        if folder not in allowed:
            self.send_error(HTTPStatus.NOT_FOUND, "Asset not found")
            return
        path = resolve_asset_file(filename, folder)
        if not path:
            self.send_error(HTTPStatus.NOT_FOUND, "Asset not found")
            return
        mime = {
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".mp4": "video/mp4",
            ".mov": "video/quicktime",
            ".gif": "image/gif",
            ".cube": "text/plain",
        }.get(path.suffix.lower(), "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile)
    def handle_video_os_post(self):
        try:
            payload = self.read_json_body()
            if self.path == "/api/video-os/projects":
                account_id, cookie, account_payload = self.with_account(payload)
                project = video_os.create_project(account_payload)
                self.send_json({"ok": True, "accountId": account_id, "project": project, "videoOs": video_os.publish_public_snapshot()}, HTTPStatus.CREATED, cookie=cookie)
                return
            if self.path == "/api/video-os/projects/update":
                patch = payload.get("patch") or {}
                if isinstance(patch, dict):
                    patch.pop("accountId", None)
                    patch.pop("customer", None)
                project = video_os.update_project(payload.get("projectId"), patch)
                self.send_json({"ok": True, "project": project, "videoOs": video_os.publish_public_snapshot()})
                return
            if self.path == "/api/video-os/jobs":
                job = video_os.create_job(payload.get("type"), payload.get("projectId"), payload.get("payload") or {})
                self.send_json({"ok": True, "job": job, "videoOs": video_os.publish_public_snapshot()}, HTTPStatus.CREATED)
                return
            if self.path == "/api/video-os/trends/discover":
                job = video_os.create_job("trend_discovery", None, payload)
                self.send_json({"ok": True, "job": job, "videoOs": video_os.publish_public_snapshot()}, HTTPStatus.CREATED)
                return
            if self.path == "/api/video-os/trends/create-video":
                job = video_os.create_job("trend_to_video_project", None, payload)
                self.send_json({"ok": True, "job": job, "videoOs": video_os.publish_public_snapshot()}, HTTPStatus.CREATED)
                return
            if self.path == "/api/video-os/jobs/run-next":
                job = video_os.process_next_job()
                self.send_json({"ok": True, "job": job, "videoOs": video_os.publish_public_snapshot()})
                return
            if self.path == "/api/video-os/talent/refresh":
                self.send_json({"ok": False, "error": "Provider talent refresh is unavailable on the anonymous local control plane."}, HTTPStatus.UNAUTHORIZED)
                return
            if self.path == "/api/video-os/discover-options":
                discover_options = video_os.update_discover_config(payload)
                self.send_json({"ok": True, "discoverOptions": discover_options, "videoOs": video_os.publish_public_snapshot()})
                return
            if self.path == "/api/video-os/scheduler/run-due":
                result = video_os.queue_due_scheduled_scans(force=bool(payload.get("force")))
                self.send_json({"ok": True, "scheduler": result, "videoOs": video_os.publish_public_snapshot()})
                return
            if self.path == "/api/video-os/feedback":
                item = video_os.add_feedback(payload.get("projectId"), payload)
                self.send_json({"ok": True, "feedback": item, "videoOs": video_os.publish_public_snapshot()}, HTTPStatus.CREATED)
                return
            self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.FORBIDDEN)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def handle_video_os_lite_post(self):
        try:
            payload = self.read_json_body()
            account_id, cookie, payload = self.with_account(payload)
            if self.path == "/api/video-os-lite/script":
                self.send_json({"ok": True, "script": render_lite_script(payload), "accountId": account_id}, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/assets/recommend":
                self.send_json({"ok": True, "accountId": account_id, "productionKit": provider_gateway.recommend_production_kit(payload)}, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/export":
                result = export_lite_mp4(payload)
                self.send_json({"ok": True, "accountId": account_id, **result}, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/finalize":
                result = finalize_provider_mp4(payload)
                status = HTTPStatus.OK if result.get("ready", True) else HTTPStatus.ACCEPTED
                self.send_json({"ok": True, "accountId": account_id, **result}, status, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/uploads":
                result = save_lite_upload(payload)
                self.send_json({"ok": True, "accountId": account_id, **result}, HTTPStatus.CREATED, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/render":
                result = provider_gateway.render_with_provider(payload)
                self.send_json({"ok": True, "accountId": account_id, **result}, HTTPStatus.CREATED, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/checkout":
                result = provider_gateway.create_checkout(payload)
                self.send_json({"ok": True, "accountId": account_id, **result}, cookie=cookie)
                return
            if self.path == "/api/video-os-lite/avatar":
                result = provider_gateway.create_avatar_asset(payload)
                self.send_json({"ok": True, "accountId": account_id, **result}, HTTPStatus.CREATED, cookie=cookie)
                return
            self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.FORBIDDEN)
        except Exception as exc:
            message = str(exc) if self.path in {"/api/video-os-lite/render", "/api/video-os-lite/finalize", "/api/video-os-lite/checkout", "/api/video-os-lite/avatar", "/api/video-os-lite/uploads"} else "Video export could not be completed. Check FFmpeg availability and try again."
            self.send_json({"ok": False, "error": message}, HTTPStatus.BAD_REQUEST)
    def handle_events(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        client = hub.subscribe()
        self.write_event("video-os", {"videoOs": video_os.publish_public_snapshot()})
        try:
            while True:
                try:
                    payload = client.get(timeout=20)
                    self.write_event(payload["event"], payload["data"])
                except queue.Empty:
                    self.write_event("ping", {"time": time.time()})
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            hub.unsubscribe(client)

    def write_event(self, event, data):
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
        self.wfile.flush()


def lite_text(value, max_len=900):
    return str(value or "").strip()[:max_len]


def render_lite_script(payload):
    title = lite_text(payload.get("title") or "Your video", 120)
    audience = lite_text(payload.get("audience") or "your audience", 160)
    goal_type = lite_text(payload.get("goalType") or "Explainer", 80)
    objective = lite_text(payload.get("objective") or "take the next step", 700)
    tone = lite_text(payload.get("tone") or "warm and clear", 80).lower()
    return "\n".join([
        f"Scene 1: {title}",
        f"Hi {audience}. In this short {goal_type.lower()}, I will show you why this matters and what to do next.",
        "",
        "Scene 2: The problem",
        "Creating a polished video usually means planning, recording, editing, captions, music, and exports across several tools.",
        "",
        "Scene 3: The payoff",
        f"Video OS Lite turns that into one guided path so the viewer can {objective[:1].lower() + objective[1:] if objective else 'take action'}.",
        "",
        "Scene 4: Next step",
        f"Keep the message {tone}, show the main proof, and end with one simple action the viewer can take now.",
    ])


def wrap_lite_lines(value, width=28, max_lines=8):
    words = re.findall(r"\S+", lite_text(value, 420))
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word[:width]
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    return lines or ["Video OS Lite"]


def ass_escape(value):
    return str(value or "").replace("\\", "\\\\").replace("{", "").replace("}", "").replace("\n", "\\N")



def normalize_asset_name(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def load_asset_manifest():
    if not ASSET_MANIFEST.exists():
        return []
    try:
        items = json.loads(ASSET_MANIFEST.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return []
    return items if isinstance(items, list) else []


def resolve_asset_file(name, folder):
    needle = normalize_asset_name(name)
    if not needle:
        return None
    for item in load_asset_manifest():
        if item.get("folder") != folder:
            continue
        candidates = [item.get("title"), item.get("file"), Path(item.get("path") or "").name]
        if any(normalize_asset_name(candidate) == needle for candidate in candidates):
            path = Path(item.get("path") or "")
            if path.exists() and path.is_file() and path.stat().st_size > 0:
                return path
    folder_path = ASSETS / folder
    if folder_path.exists():
        for path in folder_path.iterdir():
            if path.is_file() and normalize_asset_name(path.name) == needle:
                return path
    return None


def kit_asset(kit, key, folder):
    name = kit_item_name(kit, key)
    path = resolve_asset_file(name, folder)
    return {"name": name, "path": path, "source": "local" if path else "generated"}


def input_label(index):
    return f"[{index}:v]"

def kit_item_name(kit, key, fallback="Auto"):
    value = (kit or {}).get(key) or {}
    if isinstance(value, dict):
        return lite_text(value.get("name") or fallback, 90)
    return lite_text(value or fallback, 90)


def production_kit_for_export(payload):
    kit = payload.get("productionKit")
    if not isinstance(kit, dict) or not kit:
        kit = provider_gateway.recommend_production_kit(payload)
    return kit


def kit_video_style(kit):
    text = " ".join(kit_item_name(kit, key, "") for key in ("background", "lut", "music", "cta", "overlay")).lower()
    style = {
        "color": "0x111827",
        "accent": "white@0.08",
        "saturation": "1.10",
        "contrast": "1.04",
        "musicFrequency": "196",
    }
    if "vhs" in text or "freefall" in text or "pop" in text:
        style.update({"color": "0x16111f", "accent": "0x2f6df6@0.16", "saturation": "1.38", "contrast": "1.10", "musicFrequency": "330"})
    elif "static" in text or "bright" in text or "crystal" in text:
        style.update({"color": "0x12151c", "accent": "0x24a67a@0.15", "saturation": "1.28", "contrast": "1.08", "musicFrequency": "262"})
    elif "kinetic" in text or "studio" in text:
        style.update({"color": "0x0f172a", "accent": "0x2f6df6@0.14", "saturation": "1.18", "contrast": "1.06", "musicFrequency": "220"})
    return style


def kit_video_filter(ass_path, kit, width, height):
    style = kit_video_style(kit)
    bar_h = max(10, height // 80)
    side_w = max(10, width // 95)
    return ",".join([
        "drawgrid=w=iw/12:h=ih/12:t=1:c=white@0.045",
        f"drawbox=x=0:y=0:w=iw:h={bar_h}:color={style['accent']}:t=fill",
        f"drawbox=x=0:y=0:w={side_w}:h=ih:color={style['accent']}:t=fill",
        f"eq=saturation={style['saturation']}:contrast={style['contrast']}",
        f"subtitles={ass_path.name}",
    ])


def save_lite_upload(payload):
    UPLOADS.mkdir(parents=True, exist_ok=True)
    name = lite_text(payload.get("name") or "avatar-source", 120)
    data_url = str(payload.get("dataUrl") or "")
    kind = lite_text(payload.get("kind") or "avatar", 40)
    if "," not in data_url or not data_url.startswith("data:"):
        raise ValueError("Choose an image or video file to upload first.")
    header, encoded = data_url.split(",", 1)
    mime = header[5:].split(";", 1)[0].lower()
    allowed = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
    }
    if mime not in allowed:
        raise ValueError("Unsupported upload format. Use JPG, PNG, WebP, MP4, or MOV.")
    try:
        blob = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("The upload could not be decoded. Try a smaller valid file.") from exc
    if not blob or len(blob) > 20_000_000:
        raise ValueError("Uploads must be under 20 MB for the local MVP.")
    safe = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "avatar-source"
    filename = f"{safe}-{int(time.time())}{allowed[mime]}"
    target = UPLOADS / filename
    target.write_bytes(blob)
    local_url = f"/uploads/{filename}"
    public_base = os.environ.get("VIDEO_OS_PUBLIC_URL", "").rstrip("/")
    provider_url = f"{public_base}{local_url}" if public_base.startswith("https://") else ""
    return {
        "url": local_url,
        "providerUrl": provider_url,
        "filename": filename,
        "mime": mime,
        "kind": kind,
        "size": len(blob),
        "requiresPublicUrl": not bool(provider_url),
        "message": "Upload staged locally. Set VIDEO_OS_PUBLIC_URL to an HTTPS app URL before provider avatar submission." if not provider_url else "Upload ready for provider avatar submission.",
    }
def write_lite_ass_card(path, payload, width, height):
    kit = production_kit_for_export(payload)
    title = ass_escape(lite_text(payload.get("title") or "Video OS Lite", 80))
    goal = ass_escape(lite_text(payload.get("goalType") or "AI Video", 80).upper())
    voice = ass_escape(lite_text(payload.get("tone") or "Warm and clear", 80))
    script = payload.get("script") or title
    body = ass_escape("\\N".join(wrap_lite_lines(script, 30 if height > width else 48, 7)))
    kit_line = ass_escape(" | ".join([
        f"Music: {kit_item_name(kit, 'music')}",
        f"Background: {kit_item_name(kit, 'background')}",
        f"LUT: {kit_item_name(kit, 'lut')}",
    ]))
    cta_line = ass_escape(f"CTA motion: {kit_item_name(kit, 'cta')} | Overlay: {kit_item_name(kit, 'overlay')}")
    title_margin = max(80, int(height * 0.15))
    body_margin = max(120, int(height * 0.20))
    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Eyebrow,Arial,{max(30, width // 34)},&H0000F62F,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,4,0,1,1,0,8,80,80,{title_margin + 96},1
Style: Title,Arial,{max(56, width // 15)},&H00FFFFFF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,2,0,8,80,80,{title_margin},1
Style: Body,Arial,{max(38, width // 24)},&H00FFFFFF,&H000000FF,&H00000000,&HAA000000,1,0,0,0,100,100,0,0,3,2,0,2,90,90,{body_margin},1
Style: Kit,Arial,{max(24, width // 48)},&H00DCE7F3,&H000000FF,&H00000000,&HAA000000,1,0,0,0,100,100,0,0,3,1,0,2,80,80,{max(118, int(height * 0.08))},1
Style: Meta,Arial,{max(26, width // 42)},&H00E1E7EF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,1,0,2,80,80,80,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:12.00,Eyebrow,,0,0,0,,{goal}
Dialogue: 0,0:00:00.00,0:00:12.00,Title,,0,0,0,,{title}
Dialogue: 0,0:00:00.00,0:00:12.00,Body,,0,0,0,,{body}
Dialogue: 0,0:00:00.00,0:00:12.00,Kit,,0,0,0,,{kit_line}\\N{cta_line}
Dialogue: 0,0:00:00.00,0:00:12.00,Meta,,0,0,0,,Voice: {voice} | Captions on | Video OS Lite
"""
    path.write_text(ass, encoding="utf-8")


def narration_text(payload):
    text = lite_text(payload.get("script") or payload.get("objective") or payload.get("title") or "Your Video OS Lite draft is ready.", 900)
    text = re.sub(r"Scene\s*\d+\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip()
    return text or "Your Video OS Lite draft is ready."


def synthesize_lite_voice(payload, wav_path):
    text_path = wav_path.with_suffix(".txt")
    ps1_path = wav_path.with_suffix(".ps1")
    text_path.write_text(narration_text(payload), encoding="utf-8")
    ps1_path.write_text(
        "\n".join([
            "Add-Type -AssemblyName System.Speech",
            "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
            "$synth.Rate = 0",
            "$synth.Volume = 95",
            f"$text = Get-Content -LiteralPath '{str(text_path).replace("'", "''")}' -Raw",
            f"$synth.SetOutputToWaveFile('{str(wav_path).replace("'", "''")}')",
            "$synth.Speak($text)",
            "$synth.Dispose()",
        ]),
        encoding="utf-8",
    )
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=45,
        )
    except Exception:
        return None
    return wav_path if wav_path.exists() and wav_path.stat().st_size > 0 else None
def export_lite_mp4(payload):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")
    EXPORTS.mkdir(parents=True, exist_ok=True)
    title = lite_text(payload.get("title") or "Video OS Lite", 80)
    safe = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "video-os-lite"
    fmt = payload.get("format") or "vertical"
    sizes = {"vertical": (1080, 1920), "landscape": (1920, 1080), "square": (1080, 1080)}
    width, height = sizes.get(fmt, sizes["vertical"])
    stamp = int(time.time())
    filename = f"{safe}-{fmt}-{stamp}.mp4"
    target = EXPORTS / filename
    ass_path = EXPORTS / f"{safe}-{fmt}-{stamp}.ass"
    wav_path = EXPORTS / f"{safe}-{fmt}-{stamp}.wav"
    kit = production_kit_for_export(payload)
    style = kit_video_style(kit)
    assets = {
        "background": kit_asset(kit, "background", "backgrounds"),
        "lut": kit_asset(kit, "lut", "luts"),
        "music": kit_asset(kit, "music", "music"),
        "cta": kit_asset(kit, "cta", "cta"),
        "overlay": kit_asset(kit, "overlay", "overlays"),
    }
    write_lite_ass_card(ass_path, {**payload, "productionKit": kit}, width, height)
    voice_path = synthesize_lite_voice(payload, wav_path)
    music_enabled = bool(payload.get("music", True))

    cmd = [ffmpeg, "-y"]
    input_roles = []
    if assets["background"]["path"]:
        cmd.extend(["-stream_loop", "-1", "-i", str(assets["background"]["path"] )])
        input_roles.append("background")
    else:
        cmd.extend(["-f", "lavfi", "-i", f"color=c={style['color']}:s={width}x{height}:r=30:d=12"])
        input_roles.append("generated-background")
    if voice_path:
        cmd.extend(["-i", str(voice_path)])
        input_roles.append("voice")
    if music_enabled:
        if assets["music"]["path"]:
            cmd.extend(["-stream_loop", "-1", "-i", str(assets["music"]["path"] )])
            input_roles.append("music")
        else:
            cmd.extend(["-f", "lavfi", "-i", f"sine=frequency={style['musicFrequency']}:duration=12:sample_rate=44100"])
            input_roles.append("generated-music")
    overlay_index = None
    if assets["overlay"]["path"]:
        cmd.extend(["-ignore_loop", "0", "-i", str(assets["overlay"]["path"] )])
        overlay_index = len(input_roles)
        input_roles.append("overlay")
    cta_index = None
    if assets["cta"]["path"]:
        cmd.extend(["-stream_loop", "-1", "-i", str(assets["cta"]["path"] )])
        cta_index = len(input_roles)
        input_roles.append("cta")

    copied_lut = None
    lut_filter = ""
    if assets["lut"]["path"]:
        copied_lut = EXPORTS / f"{safe}-{fmt}-{stamp}.cube"
        shutil.copyfile(assets["lut"]["path"], copied_lut)
        lut_filter = f",lut3d={copied_lut.name}"

    bar_h = max(10, height // 80)
    side_w = max(10, width // 95)
    base_chain = (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,trim=duration=12,setpts=PTS-STARTPTS,format=rgba,"
        f"drawgrid=w=iw/12:h=ih/12:t=1:c=white@0.045,"
        f"drawbox=x=0:y=0:w=iw:h={bar_h}:color={style['accent']}:t=fill,"
        f"drawbox=x=0:y=0:w={side_w}:h=ih:color={style['accent']}:t=fill,"
        f"eq=saturation={style['saturation']}:contrast={style['contrast']}{lut_filter},"
        f"subtitles={ass_path.name}[vbase]"
    )
    filters = [base_chain]
    current = "vbase"
    layer = 0
    if overlay_index is not None:
        layer += 1
        filters.append(f"[{overlay_index}:v]scale={max(120, width // 6)}:-1,format=rgba,colorchannelmixer=aa=0.72,setpts=PTS-STARTPTS[ov{layer}]")
        filters.append(f"[{current}][ov{layer}]overlay=x=W-w-{max(26, width // 34)}:y={max(28, height // 40)}:shortest=1:enable='between(t,1,11)'[v{layer}]")
        current = f"v{layer}"
    if cta_index is not None:
        layer += 1
        filters.append(f"[{cta_index}:v]scale={max(260, width // 3)}:-1,format=rgba,colorchannelmixer=aa=0.78,setpts=PTS-STARTPTS[cta{layer}]")
        filters.append(f"[{current}][cta{layer}]overlay=x=(W-w)/2:y=H-h-{max(36, height // 24)}:shortest=1:enable='between(t,7,12)'[v{layer}]")
        current = f"v{layer}"
    filters.append(f"[{current}]format=yuv420p[vout]")

    voice_index = input_roles.index("voice") if "voice" in input_roles else None
    music_index = input_roles.index("music") if "music" in input_roles else (input_roles.index("generated-music") if "generated-music" in input_roles else None)
    audio_map = None
    if voice_index is not None and music_index is not None:
        filters.append(f"[{music_index}:a]atrim=duration=12,volume=0.075[musicbed]")
        filters.append(f"[{voice_index}:a][musicbed]amix=inputs=2:duration=shortest:dropout_transition=1[aout]")
        audio_map = "[aout]"
    elif voice_index is not None:
        audio_map = f"{voice_index}:a"
    elif music_index is not None:
        filters.append(f"[{music_index}:a]atrim=duration=12,volume=0.18[aout]")
        audio_map = "[aout]"

    cmd.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    if audio_map:
        cmd.extend(["-map", audio_map, "-c:a", "aac", "-b:a", "128k", "-shortest"])
    cmd.extend(["-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target)])
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=120, cwd=str(EXPORTS))
    return {
        "url": f"/exports/{filename}",
        "filename": filename,
        "voice": "local-tts" if voice_path else "none",
        "productionKit": kit,
        "effects": {
            "background": assets["background"]["name"],
            "lut": assets["lut"]["name"],
            "music": assets["music"]["name"] if music_enabled else "Off",
            "cta": assets["cta"]["name"],
            "overlay": assets["overlay"]["name"],
        },
        "assetSources": {key: value["source"] for key, value in assets.items()},
    }



def has_audio_stream(path):
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return True
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        return bool(result.stdout.strip())
    except Exception:
        return True


def resolve_provider_source(payload, safe, stamp):
    source_url = lite_text(payload.get("sourceUrl") or payload.get("providerVideoUrl"), 1200)
    source_path = lite_text(payload.get("sourcePath"), 1200)
    if source_path:
        path = Path(source_path)
        if path.exists() and path.is_file():
            return path
    if source_url.startswith(("/exports/", "/uploads/")):
        path = (PUBLIC / source_url.lstrip("/")).resolve()
        public_root = PUBLIC.resolve()
        if str(path).startswith(str(public_root)) and path.exists() and path.is_file():
            return path
    if source_url.startswith(("http://", "https://")):
        parsed = urllib.parse.urlparse(source_url)
        ext = Path(parsed.path).suffix.lower()
        if ext not in {".mp4", ".mov", ".webm"}:
            ext = ".mp4"
        target = EXPORTS / f"{safe}-provider-source-{stamp}{ext}"
        request = urllib.request.Request(source_url, headers={"User-Agent": "VideoOSLite/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response:
            with target.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        if target.exists() and target.stat().st_size > 0:
            return target
    poll = provider_gateway.poll_provider_render(payload) if payload.get("projectId") or payload.get("providerJobId") else None
    if poll and not poll.get("ready"):
        return poll
    if poll and poll.get("sourceUrl"):
        return resolve_provider_source({**payload, "sourceUrl": poll["sourceUrl"]}, safe, stamp)
    return {"ready": False, "stage": "rendering", "message": "Avatar video is not ready yet. Wait for HeyGen to finish, then run Final Render again."}



def kit_signature(kit):
    keys = ("background", "lut", "music", "cta", "overlay")
    signature = []
    for key in keys:
        value = (kit or {}).get(key) or {}
        name = value.get("name") if isinstance(value, dict) else value
        signature.append((key, str(name or "")))
    return tuple(signature)


def patch_lite_project_render_state(payload, review_state, status="rendering", url=None, message=None):
    project_id = payload.get("projectId")
    if not project_id:
        return
    try:
        store = video_os.load_store()
        project = video_os.find_project(store, project_id)
        telemetry = (project or {}).get("telemetry") or {}
        telemetry.update({
            "renderStage": review_state,
            "providerStatus": review_state,
            "finalUrl": url or telemetry.get("finalUrl"),
            "renderMessage": message or telemetry.get("renderMessage"),
        })
        patch = {"status": status, "reviewState": review_state, "telemetry": telemetry}
        if url:
            patch["finalUrl"] = url
        video_os.update_project(project_id, patch)
    except Exception:
        pass


def existing_final_render(payload, safe, fmt, kit):
    provider_job_id = str(payload.get("providerJobId") or "")
    project_id = str(payload.get("projectId") or "")
    if not provider_job_id and not project_id:
        return None
    expected_kit = kit_signature(kit)
    candidates = sorted(EXPORTS.glob(f"{safe}-final-{fmt}-*.mp4"), key=lambda item: item.stat().st_mtime, reverse=True)
    for path in candidates:
        sidecar_path = path.with_suffix(".json")
        if not sidecar_path.exists():
            continue
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if sidecar.get("format") != fmt:
            continue
        if provider_job_id and str(sidecar.get("providerJobId") or "") != provider_job_id:
            continue
        account_id = str(payload.get("accountId") or "")
        if account_id and sidecar.get("accountId") and str(sidecar.get("accountId")) != account_id:
            continue
        if project_id and str(sidecar.get("projectId") or "") != project_id:
            continue
        if kit_signature(sidecar.get("productionKit") or {}) != expected_kit:
            continue
        url = f"/exports/{path.name}"
        return {
            "ready": True,
            "stage": "ready",
            "status": "final_ready",
            "url": url,
            "filename": path.name,
            "source": "existing-final-render",
            "productionKit": sidecar.get("productionKit") or kit,
            "effects": sidecar.get("effects") or {},
            "assetSources": sidecar.get("assetSources") or {},
            "idempotent": True,
        }
    return None
def finalize_provider_mp4(payload):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")
    EXPORTS.mkdir(parents=True, exist_ok=True)
    title = lite_text(payload.get("title") or "Video OS Lite final", 80)
    safe = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "video-os-lite"
    fmt = payload.get("format") or "vertical"
    sizes = {"vertical": (1080, 1920), "landscape": (1920, 1080), "square": (1080, 1080)}
    width, height = sizes.get(fmt, sizes["vertical"])
    stamp = int(time.time())
    kit = production_kit_for_export(payload)
    existing = existing_final_render(payload, safe, fmt, kit)
    if existing:
        patch_lite_project_render_state(payload, "final_ready", status="qc_required", url=existing["url"], message="Final MP4 already exists.")
        return existing
    source = resolve_provider_source(payload, safe, stamp)
    if isinstance(source, dict):
        result = {
            "ready": False,
            "stage": source.get("stage") or "rendering",
            "status": source.get("status") or "rendering",
            "message": source.get("message") or "Avatar video is still rendering.",
        }
        patch_lite_project_render_state(payload, source.get("stage") or "provider_rendering", status="rendering", message=result["message"])
        return result
    patch_lite_project_render_state(payload, "applying_kit", status="rendering", message="Applying Lux production kit.")
    style = kit_video_style(kit)
    assets = {
        "background": kit_asset(kit, "background", "backgrounds"),
        "lut": kit_asset(kit, "lut", "luts"),
        "music": kit_asset(kit, "music", "music"),
        "cta": kit_asset(kit, "cta", "cta"),
        "overlay": kit_asset(kit, "overlay", "overlays"),
    }
    filename = f"{safe}-final-{fmt}-{stamp}.mp4"
    target = EXPORTS / filename
    lut_filter = ""
    if assets["lut"]["path"]:
        copied_lut = EXPORTS / f"{safe}-final-{fmt}-{stamp}.cube"
        shutil.copyfile(assets["lut"]["path"], copied_lut)
        lut_filter = f",lut3d={copied_lut.name}"

    cmd = [ffmpeg, "-y", "-i", str(source)]
    input_roles = ["source"]
    music_enabled = bool(payload.get("music", True))
    if music_enabled and assets["music"]["path"]:
        cmd.extend(["-stream_loop", "-1", "-i", str(assets["music"]["path"])])
        input_roles.append("music")
    overlay_index = None
    if assets["overlay"]["path"]:
        cmd.extend(["-ignore_loop", "0", "-i", str(assets["overlay"]["path"])])
        overlay_index = len(input_roles)
        input_roles.append("overlay")
    cta_index = None
    if assets["cta"]["path"]:
        cmd.extend(["-stream_loop", "-1", "-i", str(assets["cta"]["path"])])
        cta_index = len(input_roles)
        input_roles.append("cta")

    bar_h = max(10, height // 80)
    filters = [
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,format=rgba,eq=saturation={style['saturation']}:contrast={style['contrast']}{lut_filter},drawbox=x=0:y=0:w=iw:h={bar_h}:color={style['accent']}:t=fill[vbase]"
    ]
    current = "vbase"
    layer = 0
    if overlay_index is not None:
        layer += 1
        filters.append(f"[{overlay_index}:v]scale={max(120, width // 6)}:-1,format=rgba,colorchannelmixer=aa=0.68,setpts=PTS-STARTPTS[ov{layer}]")
        filters.append(f"[{current}][ov{layer}]overlay=x=W-w-{max(26, width // 34)}:y={max(28, height // 40)}:shortest=1:enable='between(t,1,999)'[v{layer}]")
        current = f"v{layer}"
    if cta_index is not None:
        layer += 1
        filters.append(f"[{cta_index}:v]scale={max(260, width // 3)}:-1,format=rgba,colorchannelmixer=aa=0.78,setpts=PTS-STARTPTS[cta{layer}]")
        filters.append(f"[{current}][cta{layer}]overlay=x=(W-w)/2:y=H-h-{max(36, height // 24)}:shortest=1:enable='gte(t,3)'[v{layer}]")
        current = f"v{layer}"
    filters.append(f"[{current}]format=yuv420p[vout]")

    source_has_audio = has_audio_stream(source)
    music_index = input_roles.index("music") if "music" in input_roles else None
    audio_map = None
    if source_has_audio and music_index is not None:
        filters.append(f"[{music_index}:a]volume=0.075[musicbed]")
        filters.append("[0:a][musicbed]amix=inputs=2:duration=first:dropout_transition=1[aout]")
        audio_map = "[aout]"
    elif source_has_audio:
        audio_map = "0:a"
    elif music_index is not None:
        filters.append(f"[{music_index}:a]volume=0.16[aout]")
        audio_map = "[aout]"

    cmd.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    if audio_map:
        cmd.extend(["-map", audio_map, "-c:a", "aac", "-b:a", "160k", "-shortest"])
    cmd.extend(["-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target)])
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=180, cwd=str(EXPORTS))
    except subprocess.CalledProcessError as exc:
        raise RuntimeError("Final MP4 could not be created. Check that the provider video and kit assets are valid media files.") from exc
    effects = {
        "background": assets["background"]["name"],
        "lut": assets["lut"]["name"],
        "music": assets["music"]["name"] if music_enabled else "Off",
        "cta": assets["cta"]["name"],
        "overlay": assets["overlay"]["name"],
    }
    asset_sources = {key: value["source"] for key, value in assets.items()}
    sidecar = {
        "title": title,
        "provider": payload.get("provider") or "heygen",
        "accountId": payload.get("accountId") or provider_gateway.default_account_id(),
        "projectId": payload.get("projectId"),
        "providerJobId": payload.get("providerJobId"),
        "format": fmt,
        "kind": "final",
        "avatar": payload.get("avatar") or {},
        "voice": payload.get("voice") or {},
        "productionKit": kit,
        "effects": effects,
        "assetSources": asset_sources,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(target.stat().st_mtime)),
    }
    (EXPORTS / f"{Path(filename).stem}.json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    final_url = f"/exports/{filename}"
    patch_lite_project_render_state(payload, "final_ready", status="qc_required", url=final_url, message="Final MP4 ready.")
    return {
        "ready": True,
        "stage": "ready",
        "status": "final_ready",
        "url": final_url,
        "filename": filename,
        "source": str(source),
        "productionKit": kit,
        "effects": effects,
        "assetSources": asset_sources,
    }

def result_family_key(name):
    stem = Path(name).stem.lower()
    stem = re.sub(r"-provider-source-\d+$", "", stem)
    stem = re.sub(r"-final-(vertical|landscape|square)-\d+$", "", stem)
    stem = re.sub(r"-(vertical|landscape|square)-\d+$", "", stem)
    return stem


def display_title_from_key(key):
    return " ".join(part.capitalize() for part in key.split("-") if part)


def load_project_lookup():
    store = video_os.read_json(video_os.PROJECTS_FILE, {"projects": []})
    return {str(project.get("id") or "").lower(): project for project in store.get("projects", [])}


def compact_kit_name(value):
    if isinstance(value, dict):
        value = value.get("name") or value.get("title") or value.get("file")
    return lite_text(value or "Auto", 80)


def load_result_sidecar(path):
    sidecar = path.with_suffix(".json")
    if not sidecar.exists():
        return {}
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def result_metadata(key, project):
    project = project or {}
    telemetry = project.get("telemetry") or {}
    context = project.get("kitContext") or telemetry.get("kitContext") or {}
    context_items = context.get("items") if isinstance(context, dict) else {}
    kit = project.get("productionKit") or {}
    avatar = project.get("avatar") or {}
    voice = project.get("voice") or {}
    provider = project.get("provider") or ("HeyGen" if project.get("providerJobId") else "Local")

    def kit_value(name):
        if isinstance(kit, dict) and kit.get(name):
            return kit.get(name)
        if isinstance(context_items, dict):
            return context_items.get(name)
        return None

    return {
        "accountId": project.get("accountId") or (project.get("customer") or {}).get("accountId") or provider_gateway.default_account_id(),
        "title": lite_text(project.get("name") or display_title_from_key(key), 90),
        "provider": lite_text(provider, 50),
        "goal": lite_text(project.get("topic") or project.get("goal") or "Video", 80),
        "avatar": lite_text(avatar.get("name") or avatar.get("avatarId") or "Auto presenter", 80),
        "voice": lite_text(voice.get("name") or voice.get("voiceId") or "Auto voice", 80),
        "kit": {
            "music": compact_kit_name(kit_value("music")),
            "background": compact_kit_name(kit_value("background")),
            "lut": compact_kit_name(kit_value("lut")),
            "cta": compact_kit_name(kit_value("cta")),
            "overlay": compact_kit_name(kit_value("overlay")),
        },
    }


def list_lite_results(limit=12, account_id=None):
    EXPORTS.mkdir(parents=True, exist_ok=True)
    projects = load_project_lookup()
    account_id = account_id or provider_gateway.default_account_id()
    grouped = {}
    for path in sorted(EXPORTS.glob("*.mp4"), key=lambda item: item.stat().st_mtime, reverse=True):
        name = path.name
        lower = name.lower()
        if lower.startswith("qa-smoke-") or "-qa" in lower or lower in {"test-ass.mp4"} or "-provider-source-" in lower:
            continue
        fmt = "vertical" if "vertical" in lower else ("landscape" if "landscape" in lower else ("square" if "square" in lower else "mp4"))
        kind = "final" if "-final-" in lower else "draft"
        key = result_family_key(name)
        sidecar = load_result_sidecar(path)
        metadata = result_metadata(key, projects.get(key))
        result_account = sidecar.get("accountId") or metadata.get("accountId")
        if account_id and result_account and str(result_account) != str(account_id):
            continue
        if sidecar:
            sidecar_avatar = sidecar.get("avatar") or {}
            sidecar_voice = sidecar.get("voice") or {}
            sidecar_effects = sidecar.get("effects") or {}
            metadata.update({
                "title": lite_text(sidecar.get("title") or metadata.get("title"), 90),
                "accountId": sidecar.get("accountId") or metadata.get("accountId"),
                "provider": lite_text(sidecar.get("provider") or metadata.get("provider"), 50),
                "avatar": lite_text(sidecar_avatar.get("name") or sidecar_avatar.get("avatarId") or metadata.get("avatar"), 80),
                "voice": lite_text(sidecar_voice.get("name") or sidecar_voice.get("voiceId") or metadata.get("voice"), 80),
                "kit": {
                    "music": compact_kit_name(sidecar_effects.get("music")),
                    "background": compact_kit_name(sidecar_effects.get("background")),
                    "lut": compact_kit_name(sidecar_effects.get("lut")),
                    "cta": compact_kit_name(sidecar_effects.get("cta")),
                    "overlay": compact_kit_name(sidecar_effects.get("overlay")),
                },
            })
        item = {
            "filename": name,
            "url": f"/exports/{name}",
            "kind": sidecar.get("kind") or kind,
            "format": sidecar.get("format") or fmt,
            "size": path.stat().st_size,
            "createdAt": sidecar.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime)),
            "mtime": path.stat().st_mtime,
            **metadata,
        }
        current = grouped.get(key)
        if not current or (item["kind"] == "final" and current["kind"] != "final"):
            grouped[key] = item
    visible = sorted(grouped.values(), key=lambda item: (item["kind"] != "final", -item["mtime"]))[:limit]
    for item in visible:
        item.pop("mtime", None)
    return visible

def lite_asset_catalog():
    grouped = {folder: [] for folder in ("music", "backgrounds", "luts", "cta", "overlays")}
    for item in load_asset_manifest():
        folder = item.get("folder")
        if folder not in grouped:
            continue
        path = Path(item.get("path") or "")
        grouped[folder].append({
            "name": item.get("title") or item.get("file") or path.name,
            "file": item.get("file") or path.name,
            "size": item.get("size") or (path.stat().st_size if path.exists() else 0),
            "local": path.exists() and path.is_file(),
        })
    return grouped


def main():
    thread = threading.Thread(target=worker_pulse, args=(15,), daemon=True)
    thread.start()
    if os.environ.get("VIDEO_OS_EMBEDDED_WORKER", "1") != "0":
        worker_thread = threading.Thread(
            target=embedded_worker_loop,
            args=(int(os.environ.get("VIDEO_OS_WORKER_INTERVAL", "5")),),
            daemon=True,
        )
        worker_thread.start()
    if os.environ.get("VIDEO_OS_SCHEDULER", "1") != "0":
        scheduler_thread = threading.Thread(
            target=scheduler_loop,
            args=(int(os.environ.get("VIDEO_OS_SCHEDULER_INTERVAL", "60")),),
            daemon=True,
        )
        scheduler_thread.start()
    server = ThreadingHTTPServer(("127.0.0.1", 8789), Handler)
    print("LUX Video OS public site live at http://127.0.0.1:8789/; cockpit at http://127.0.0.1:8789/dashboard")
    server.serve_forever()


if __name__ == "__main__":
    main()



















































