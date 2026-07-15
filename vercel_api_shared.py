import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus

MAX_UPLOAD_BYTES = 20_000_000
TALENT_REQUEST_TIMEOUT_SECONDS = 8
PROVIDERS = {
    "heygen": {"id": "heygen", "name": "HeyGen", "cost": 90},
    "argil": {"id": "argil", "name": "Argil", "cost": 80},
    "tavus": {"id": "tavus", "name": "Tavus", "cost": 120},
    "did": {"id": "did", "name": "D-ID", "cost": 45},
}


def read_json(handler):
    try:
        size = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        size = 0
    if size <= 0 or size > 25_000_000:
        raise ValueError("Invalid request size.")
    return json.loads(handler.rfile.read(size).decode("utf-8"))


def send_json(handler, payload, status=HTTPStatus.OK):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_options(handler):
    handler.send_response(204)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()


def error(handler, message, status=HTTPStatus.BAD_REQUEST):
    send_json(handler, {"ok": False, "error": str(message)}, status)


def compact_text(value, limit=1200):
    return str(value or "").strip()[:limit]


def aspect_ratio(fmt):
    return {"vertical": "9:16", "portrait": "9:16", "landscape": "16:9", "square": "1:1"}.get(str(fmt or "").lower(), "9:16")


def heygen_key():
    return (os.environ.get("HEYGEN_API_KEY") or os.environ.get("HEYGEN_TOKEN") or "").strip()


def extract_job_id(result):
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    for key in ("video_id", "id", "job_id"):
        if data.get(key):
            return data[key]
        if result.get(key):
            return result[key]
    return None


def provider_video_url(result):
    if not isinstance(result, dict):
        return None
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    candidates = [
        data.get("video_url"), data.get("videoUrl"), data.get("download_url"), data.get("downloadUrl"), data.get("url"),
        result.get("video_url"), result.get("videoUrl"), result.get("download_url"), result.get("downloadUrl"), result.get("url"),
    ]
    return next((value for value in candidates if isinstance(value, str) and value.startswith(("http://", "https://"))), None)


def submit_heygen(payload):
    key = heygen_key()
    if not key:
        raise RuntimeError("HEYGEN_API_KEY is not configured on Vercel. Add it in Project Settings > Environment Variables and redeploy.")
    avatar = payload.get("avatar") or {}
    voice = payload.get("voice") or {}
    avatar_id = compact_text(avatar.get("avatarId") or avatar.get("id"), 160)
    voice_id = compact_text(voice.get("voiceId") or voice.get("id"), 160)
    if not avatar_id or not voice_id:
        raise RuntimeError("Choose a provider-ready HeyGen avatar and voice before live rendering.")
    body = {
        "type": "avatar",
        "avatar_id": avatar_id,
        "script": compact_text(payload.get("script") or payload.get("scriptInput"), 4000),
        "voice_id": voice_id,
        "title": compact_text(payload.get("title") or "Video OS Lite", 120),
        "resolution": "1080p",
        "aspect_ratio": aspect_ratio(payload.get("format")),
    }
    locale = compact_text(payload.get("language") or voice.get("locale"), 40)
    if locale:
        body["voice_settings"] = {"locale": locale}
    callback_url = os.environ.get("HEYGEN_CALLBACK_URL")
    if callback_url:
        body["callback_url"] = callback_url
    req = urllib.request.Request(
        "https://api.heygen.com/v3/videos",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-api-key": key, "X-Api-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"HeyGen submission failed: HTTP {exc.code} {detail}") from exc


def poll_heygen(video_id):
    key = heygen_key()
    if not key:
        raise RuntimeError("HEYGEN_API_KEY is not configured on Vercel.")
    if not video_id:
        raise RuntimeError("providerJobId is required to check HeyGen render status.")
    url = f"https://api.heygen.com/v3/videos/{video_id}"
    req = urllib.request.Request(url, headers={"x-api-key": key, "X-Api-Key": key}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"HeyGen status check failed: HTTP {exc.code} {detail}") from exc


def upload_payload(payload):
    name = compact_text(payload.get("name") or "avatar-source", 120)
    data_url = str(payload.get("dataUrl") or "")
    kind = compact_text(payload.get("kind") or "avatar", 40)
    if "," not in data_url or not data_url.startswith("data:"):
        raise ValueError("Choose an image or video file to upload first.")
    header, encoded = data_url.split(",", 1)
    mime = header[5:].split(";", 1)[0].lower()
    allowed = {"image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"}
    if mime not in allowed:
        raise ValueError("Unsupported upload format. Use JPG, PNG, WebP, MP4, or MOV.")
    try:
        blob = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("The upload could not be decoded. Try a smaller valid file.") from exc
    if not blob or len(blob) > MAX_UPLOAD_BYTES:
        raise ValueError("Uploads must be under 20 MB.")
    safe = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "avatar-source"
    filename = f"{safe}-{int(time.time())}"
    return {
        "url": data_url,
        "providerUrl": "",
        "filename": filename,
        "mime": mime,
        "kind": kind,
        "size": len(blob),
        "requiresPublicUrl": True,
        "message": "Upload validated in the browser. For HeyGen avatar training, paste a public HTTPS asset URL or connect Blob storage next.",
    }

def fetch_heygen_collection(url, timeout=TALENT_REQUEST_TIMEOUT_SECONDS):
    key = heygen_key()
    if not url or not key:
        return []
    req = urllib.request.Request(url, headers={"Accept": "application/json", "X-Api-Key": key, "x-api-key": key}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        for key_name in ("avatars", "voices", "items", "list"):
            if isinstance(data.get(key_name), list):
                return data[key_name]
    if isinstance(data, list):
        return data
    return []


def normalize_talent_item(item, fallback_prefix):
    item = item if isinstance(item, dict) else {}
    item_id = compact_text(item.get("id") or item.get("avatar_id") or item.get("voice_id") or item.get("avatarId") or item.get("voiceId") or f"{fallback_prefix}-{int(time.time())}", 160)
    name = compact_text(item.get("name") or item.get("avatar_name") or item.get("voice_name") or item.get("display_name") or item.get("displayName") or item_id or "Unnamed", 180)
    return {
        "id": item_id,
        "name": name,
        "source": compact_text(item.get("source") or "heygen", 80),
        "style": compact_text(item.get("style") or item.get("gender") or item.get("language") or item.get("locale") or "available", 120),
        "role": compact_text(item.get("type") or item.get("category") or "Ready to render", 120),
    }


def unique_items(items):
    seen = set()
    result = []
    for item in items:
        item_id = item.get("id")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        result.append(item)
    return result


def supports_avatar_iv(item):
    engines = item.get("supported_api_engines") if isinstance(item, dict) else None
    return isinstance(engines, list) and "avatar_iv" in engines


def hosted_talent_inventory():
    avatars_url = os.environ.get("HEYGEN_AVATARS_URL") or "https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50"
    voices_url = os.environ.get("HEYGEN_VOICES_URL") or "https://api.heygen.com/v2/voices"
    if not heygen_key():
        return {
            "talent": {"source": "missing-key", "avatars": [], "voices": []},
            "connection": {"connected": False, "status": "missing_key", "missing": ["HEYGEN_API_KEY"], "detail": "HEYGEN_API_KEY is required for live HeyGen inventory."},
        }
    urls = {"avatars": avatars_url, "voices": voices_url}
    raw_inventory = {}
    failures = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        requests = {label: executor.submit(fetch_heygen_collection, url) for label, url in urls.items()}
        for label, request in requests.items():
            try:
                raw_inventory[label] = request.result()
            except Exception:
                raw_inventory[label] = []
                failures.append(label)
    avatars = unique_items([
        normalize_talent_item(item, "avatar")
        for item in raw_inventory["avatars"]
        if supports_avatar_iv(item)
    ])
    voices = unique_items([normalize_talent_item(item, "voice") for item in raw_inventory["voices"]])
    connected = bool(avatars and voices)
    status = "degraded" if failures else ("connected" if connected else "empty_inventory")
    if failures:
        detail = f"HeyGen {', '.join(failures)} inventory is temporarily unavailable; safe fallback talent remains available."
    elif connected:
        detail = f"Connected to HeyGen inventory with {len(avatars)} avatar(s) and {len(voices)} voice(s)."
    else:
        detail = "HeyGen returned no usable avatars or voices."
    return {
        "talent": {"source": "heygen-partial" if failures else "heygen", "avatars": avatars, "voices": voices},
        "connection": {
            "connected": connected,
            "status": status,
            "failed": failures,
            "avatarCount": len(avatars),
            "voiceCount": len(voices),
            "avatarsUrl": avatars_url,
            "voicesUrl": voices_url,
            "detail": detail,
        },
    }
