import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import uuid4

import video_os_backend as video_os


ROOT = Path(__file__).resolve().parent
CREDITS_FILE = ROOT / "data" / "video-os" / "credits.json"
ACCOUNT_FILE = ROOT / "data" / "video-os" / "account.json"
AVATAR_REQUESTS_FILE = ROOT / "data" / "video-os" / "avatar-requests.json"

RENDER_STAGE_SUBMITTED = "provider_submitted"
RENDER_STAGE_RENDERING = "provider_rendering"
RENDER_STAGE_READY = "provider_ready"
RENDER_STAGE_FAILED = "provider_failed"
RENDER_STAGE_NEEDS_CONSENT = "needs_consent"


def normalized_render_stage(status, ready=False, message=""):
    value = str(status or "").lower()
    text = f"{value} {message or ''}".lower()
    if "consent" in text or "permission" in text:
        return RENDER_STAGE_NEEDS_CONSENT
    if ready or value in {"completed", "success", "ready"}:
        return RENDER_STAGE_READY
    if value in {"failed", "error", "cancelled", "canceled"}:
        return RENDER_STAGE_FAILED
    if value in {"submitted", "queued", "pending"}:
        return RENDER_STAGE_SUBMITTED
    return RENDER_STAGE_RENDERING


def user_render_message(stage, provider_name="Provider"):
    if stage == RENDER_STAGE_NEEDS_CONSENT:
        return "This avatar needs consent before the provider can render it. Pick a ready avatar or complete consent, then try again."
    if stage == RENDER_STAGE_FAILED:
        return f"{provider_name} could not finish this render. Credits should be reviewed before retrying."
    if stage == RENDER_STAGE_READY:
        return "Avatar video is ready. Applying the Lux production kit next."
    if stage == RENDER_STAGE_SUBMITTED:
        return f"Submitted to {provider_name}. Waiting for avatar rendering to start."
    return "Avatar video is still rendering. Lux will finish the MP4 automatically."
ASSETS = ROOT / "data" / "video-os" / "assets"
ASSET_MANIFEST = ASSETS / "asset-manifest.json"


PROVIDERS = {
    "heygen": {
        "id": "heygen",
        "name": "HeyGen",
        "label": "Best first render",
        "cost": 90,
        "env": ["HEYGEN_API_KEY or HEYGEN_TOKEN"],
        "capabilities": ["stock avatars", "personal avatars", "AI voices", "languages"],
    },
    "argil": {
        "id": "argil",
        "name": "Argil",
        "label": "Clone-style videos",
        "cost": 80,
        "env": ["ARGIL_API_KEY", "ARGIL_RENDER_URL"],
        "capabilities": ["avatar videos", "templates", "media", "captions"],
    },
    "tavus": {
        "id": "tavus",
        "name": "Tavus",
        "label": "Personalized video clone",
        "cost": 120,
        "env": ["TAVUS_API_KEY", "TAVUS_REPLICA_ID"],
        "capabilities": ["face", "voice", "personalized scripts"],
    },
    "did": {
        "id": "did",
        "name": "D-ID",
        "label": "Fast talking-head render",
        "cost": 45,
        "env": ["DID_API_KEY", "DID_SOURCE_URL"],
        "capabilities": ["talking head", "source image", "text script"],
    },
}

ASSET_LIBRARIES = [
    {
        "id": "gif-reactions",
        "name": "GIF reactions and stickers",
        "type": "gif",
        "url": "https://drive.google.com/drive/folders/1EioIhUvCMgEIAjC9b7zRuCgdY1Z3E0AM",
        "examples": ["78-Hundred-Points.gif", "77-Heart-2.gif", "75-Folded-Hands.gif"],
    },
    {
        "id": "music-beds",
        "name": "Music beds",
        "type": "audio",
        "url": "https://drive.google.com/drive/folders/1DlpzePBzfxmxZI6c6n3nEuJiYOwj1vHR",
        "examples": ["Waimea - Kellin.wav", "Infinite Morning - Kellin.wav", "Crystal Clear - Kellin.wav"],
    },
    {
        "id": "video-backgrounds",
        "name": "Video backgrounds",
        "type": "video",
        "url": "https://drive.google.com/drive/folders/1FSm9VTwfoG10GKm7bkEx9SvwbiCHTCMF",
        "examples": ["VHS background Overlay.mp4", "Kinetic Dots background (white).mp4", "Static Background 1.mp4"],
    },
    {
        "id": "color-grades",
        "name": "LUT color grades",
        "type": "lut",
        "url": "https://drive.google.com/drive/folders/1j-fgAnRfgNYfGsf-eykMdgaEeRdswP7v",
        "examples": ["iPhone 13 : Studio Contrast : Strong.cube", "Creative : Bright & Saturated : Strong.cube"],
    },
    {
        "id": "cta-motion",
        "name": "CTA and subscribe motion assets",
        "type": "video",
        "url": "https://drive.google.com/drive/folders/1cRuC6v3fqI4kCpCVbzE7_bSN0GWlkOx_",
        "examples": ["Like and Subscribe ProRes.mov", "CIRCLE-1080.mov", "Arrow_6.mov"],
    },
]

def _json_request(url, body, headers=None, timeout=45):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise video_os.VideoOsError(f"Provider request failed: HTTP {exc.code} {detail}") from exc



def default_account_id():
    return os.environ.get("VIDEO_OS_ACCOUNT_ID") or "local-client"


def account_id_from_payload(payload=None):
    value = ""
    if isinstance(payload, dict):
        value = str(payload.get("accountId") or "").strip()
    return value or default_account_id()


def _read_account():
    ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
    if ACCOUNT_FILE.exists():
        try:
            return json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    payload = {
        "accountId": default_account_id(),
        "email": os.environ.get("VIDEO_OS_ACCOUNT_EMAIL") or "client@example.com",
        "name": os.environ.get("VIDEO_OS_ACCOUNT_NAME") or "Client Account",
        "subscription": {
            "plan": os.environ.get("VIDEO_OS_PLAN") or "Lite MVP",
            "status": os.environ.get("VIDEO_OS_PLAN_STATUS") or "trial",
            "renewal": os.environ.get("VIDEO_OS_PLAN_RENEWAL") or "Not connected to Stripe yet",
            "includedCredits": int(os.environ.get("VIDEO_OS_PLAN_CREDITS", "1500")),
        },
    }
    _write_account(payload)
    return payload


def _write_account(payload):
    ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACCOUNT_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _read_avatar_requests():
    AVATAR_REQUESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if AVATAR_REQUESTS_FILE.exists():
        try:
            return json.loads(AVATAR_REQUESTS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return []


def _write_avatar_requests(items):
    AVATAR_REQUESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    AVATAR_REQUESTS_FILE.write_text(json.dumps(items[-100:], indent=2), encoding="utf-8")
def _read_credits():
    CREDITS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if CREDITS_FILE.exists():
        try:
            data = json.loads(CREDITS_FILE.read_text(encoding="utf-8"))
            if data.get("accountId") in {None, "", "local"}:
                data["accountId"] = default_account_id()
            return data
        except json.JSONDecodeError:
            pass
    payload = {
        "accountId": default_account_id(),
        "balance": int(os.environ.get("VIDEO_OS_STARTER_CREDITS", "1530")),
        "currency": "credits",
        "ledger": [],
    }
    _write_credits(payload)
    return payload


def _write_credits(payload):
    CREDITS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDITS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _credit_event(kind, amount, note, provider=None, project_id=None, account_id=None):
    account_id = account_id or default_account_id()
    credits = _read_credits()
    credits["accountId"] = account_id
    credits["balance"] = int(credits.get("balance") or 0) + int(amount)
    credits.setdefault("ledger", []).append({
        "id": f"credit-{uuid4().hex[:10]}",
        "kind": kind,
        "amount": int(amount),
        "provider": provider,
        "projectId": project_id,
        "accountId": account_id,
        "note": note,
        "createdAt": video_os.utc_now(),
    })
    credits["ledger"] = credits["ledger"][-100:]
    _write_credits(credits)
    return credits


def configured_provider(provider_id):
    if provider_id == "heygen":
        return bool(video_os.heygen_api_key())
    if provider_id == "argil":
        return bool(os.environ.get("ARGIL_API_KEY") and os.environ.get("ARGIL_RENDER_URL"))
    if provider_id == "tavus":
        return bool(os.environ.get("TAVUS_API_KEY") and os.environ.get("TAVUS_REPLICA_ID"))
    if provider_id == "did":
        return bool(os.environ.get("DID_API_KEY") and os.environ.get("DID_SOURCE_URL"))
    return False


def provider_status(account_id=None):
    account = _read_account()
    account_id = account_id or account.get("accountId") or default_account_id()
    credits = _read_credits()
    credits.setdefault("accountId", account_id)
    return {
        "account": account,
        "accountId": account_id,
        "credits": {
            "accountId": credits.get("accountId") or account_id,
            "balance": credits.get("balance", 0),
            "currency": credits.get("currency", "credits"),
            "ledger": credits.get("ledger", [])[-8:],
        },
        "providers": [
            {
                **provider,
                "configured": configured_provider(provider_id),
                "missing": [] if configured_provider(provider_id) else provider["env"],
            }
            for provider_id, provider in PROVIDERS.items()
        ],
        "stripe": {
            "configured": bool(
                os.environ.get("STRIPE_PAYMENT_LINK_URL")
                or (os.environ.get("STRIPE_SECRET_KEY") and os.environ.get("STRIPE_CREDIT_PRICE_ID"))
            ),
            "mode": "payment_link" if os.environ.get("STRIPE_PAYMENT_LINK_URL") else "checkout_session",
        },
    }


def _asset_manifest():
    if not ASSET_MANIFEST.exists():
        return []
    try:
        items = json.loads(ASSET_MANIFEST.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return []
    return items if isinstance(items, list) else []


def _normalize_asset_name(value):
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _kit_asset_url(name, folder, public_base):
    if not name or not public_base:
        return None
    needle = _normalize_asset_name(name)
    for item in _asset_manifest():
        if item.get("folder") != folder:
            continue
        candidates = [item.get("title"), item.get("file"), Path(item.get("path") or "").name]
        if not any(_normalize_asset_name(candidate) == needle for candidate in candidates):
            continue
        filename = urllib.parse.quote(item.get("file") or Path(item.get("path") or "").name)
        return f"{public_base.rstrip('/')}/api/video-os-lite/assets/{folder}/{filename}"
    return None

def kit_context(kit, public_base=None):
    kit = kit or {}
    public_base = public_base or os.environ.get("VIDEO_OS_PUBLIC_URL", "").rstrip("/")
    folders = {"background": "backgrounds", "music": "music", "lut": "luts", "cta": "cta", "overlay": "overlays"}
    items = {}
    for key, folder in folders.items():
        value = kit.get(key) or {}
        name = value.get("name") if isinstance(value, dict) else value
        asset_url = _kit_asset_url(name, folder, public_base)
        items[key] = {"name": name or "Auto", "url": asset_url, "folder": folder}
    note = "Apply Video OS Lite finishing kit after avatar render: "
    note += ", ".join(f"{key}={value['name']}" for key, value in items.items())
    return {
        "name": kit.get("name") or "Auto production kit",
        "reason": kit.get("reason") or "",
        "items": items,
        "assetUrls": {key: value["url"] for key, value in items.items() if value.get("url")},
        "renderNotes": note,
        "postProcessRequired": True,
        "publicAssetBase": public_base,
    }

def _lite_project_payload(payload, provider_id):
    kit = payload.get("productionKit") or recommend_production_kit(payload)
    context = kit_context(kit)
    account_id = account_id_from_payload(payload)
    return {
        "accountId": account_id,
        "customer": {"accountId": account_id},
        "name": payload.get("title") or "Video OS Lite video",
        "audience": payload.get("audience"),
        "goal": payload.get("objective") or payload.get("goal"),
        "topic": payload.get("goalType"),
        "tone": payload.get("tone"),
        "scriptMode": "paste_exact",
        "scriptInput": payload.get("script"),
        "provider": provider_id,
        "productionKit": kit,
        "kitContext": context,
        "renderNotes": context["renderNotes"],
        "avatar": {
            "avatarId": (payload.get("avatar") or {}).get("id") or payload.get("avatarId"),
            "name": (payload.get("avatar") or {}).get("name"),
            "source": (payload.get("avatar") or {}).get("source"),
        },
        "voice": {
            "voiceId": (payload.get("voice") or {}).get("id") or payload.get("voiceId"),
            "name": (payload.get("voice") or {}).get("name"),
            "source": (payload.get("voice") or {}).get("source"),
        },
        "brand": {
            "name": payload.get("brandName"),
            "logoUrl": payload.get("logoUrl"),
            "primaryColor": payload.get("primaryColor"),
            "accentColor": payload.get("accentColor"),
            "captions": bool(payload.get("captions")),
            "music": bool(payload.get("music")),
        },
    }

def create_lite_project(payload, provider_id):
    project = video_os.create_project(_lite_project_payload(payload, provider_id))
    return video_os.update_project(project["id"], {
        "status": "approved",
        "reviewState": "provider_render_requested",
        "provider": provider_id,
        "nextActions": ["Provider render requested from Video OS Lite."],
        "renderFormat": payload.get("format") or "vertical",
        "telemetry": {
            "providerStatus": "queued",
            "kitContext": kit_context(payload.get("productionKit") or recommend_production_kit(payload)),
        },
    })


def _ensure_credit_balance(provider_id, account_id=None):
    provider = PROVIDERS[provider_id]
    credits = _read_credits()
    if account_id:
        credits["accountId"] = account_id
    if int(credits.get("balance") or 0) < provider["cost"]:
        raise video_os.VideoOsError(f"Not enough credits. {provider['name']} requires {provider['cost']} credits.")


def _submit_heygen(project):
    job = video_os.create_job("heygen_submit", project["id"], {"allowLive": True})
    return video_os.process_job(job)


def _submit_argil(project, payload):
    key = os.environ.get("ARGIL_API_KEY")
    url = os.environ.get("ARGIL_RENDER_URL")
    if not key or not url:
        raise video_os.VideoOsError("Argil is not configured. Set ARGIL_API_KEY and ARGIL_RENDER_URL.")
    body = {
        "title": project.get("name"),
        "script": project.get("scriptInput"),
        "avatar_id": (project.get("avatar") or {}).get("avatarId"),
        "voice_id": (project.get("voice") or {}).get("voiceId"),
        "format": payload.get("format") or "vertical",
        "brand": project.get("brand") or {},
        "production_kit": kit_context(project.get("productionKit")),
        "render_notes": project.get("renderNotes"),
    }
    return _json_request(url, body, {"Authorization": f"Bearer {key}"})


def _submit_tavus(project, payload):
    key = os.environ.get("TAVUS_API_KEY")
    replica_id = os.environ.get("TAVUS_REPLICA_ID")
    if not key or not replica_id:
        raise video_os.VideoOsError("Tavus is not configured. Set TAVUS_API_KEY and TAVUS_REPLICA_ID.")
    body = {
        "replica_id": replica_id,
        "video_name": project.get("name"),
        "script": project.get("scriptInput"),
        "production_kit": kit_context(project.get("productionKit")),
        "render_notes": project.get("renderNotes"),
    }
    if os.environ.get("TAVUS_CALLBACK_URL"):
        body["callback_url"] = os.environ["TAVUS_CALLBACK_URL"]
    return _json_request(
        os.environ.get("TAVUS_RENDER_URL") or "https://tavusapi.com/v2/videos",
        body,
        {"x-api-key": key},
    )


def _submit_did(project, payload):
    key = os.environ.get("DID_API_KEY")
    source_url = payload.get("sourceUrl") or os.environ.get("DID_SOURCE_URL")
    if not key or not source_url:
        raise video_os.VideoOsError("D-ID is not configured. Set DID_API_KEY and DID_SOURCE_URL.")
    basic = os.environ.get("DID_BASIC_AUTH") or base64.b64encode(key.encode("utf-8")).decode("ascii")
    body = {
        "source_url": source_url,
        "name": project.get("name"),
        "metadata": {
            "production_kit": kit_context(project.get("productionKit")),
            "render_notes": project.get("renderNotes"),
        },
        "script": {
            "type": "text",
            "input": project.get("scriptInput") or "",
        },
    }
    return _json_request(
        os.environ.get("DID_RENDER_URL") or "https://api.d-id.com/talks",
        body,
        {"Authorization": f"Basic {basic}"},
    )


def _provider_job_id(result):
    if isinstance(result, dict):
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        for key in ("video_id", "id", "job_id", "talk_id"):
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
        data.get("video_url"),
        data.get("videoUrl"),
        data.get("download_url"),
        data.get("downloadUrl"),
        data.get("url"),
        result.get("video_url"),
        result.get("videoUrl"),
        result.get("download_url"),
        result.get("downloadUrl"),
        result.get("url"),
    ]
    return next((value for value in candidates if isinstance(value, str) and value.startswith(("http://", "https://"))), None)


def poll_provider_render(payload):
    provider_id = (payload.get("provider") or "heygen").lower()
    project_id = payload.get("projectId")
    provider_job_id = payload.get("providerJobId")
    if provider_id != "heygen":
        return {
            "ready": False,
            "stage": RENDER_STAGE_RENDERING,
            "status": RENDER_STAGE_RENDERING,
            "message": "This provider does not have an automatic polling adapter yet. Paste the finished provider video URL to apply the production kit.",
        }
    if not project_id:
        return {"ready": False, "stage": RENDER_STAGE_FAILED, "status": RENDER_STAGE_FAILED, "message": "Project ID is required to poll HeyGen."}
    job = video_os.create_job("heygen_poll", project_id, {"providerJobId": provider_job_id})
    job = video_os.process_job(job)
    result = job.get("result") or {}
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    status = data.get("status") or result.get("status") or job.get("status") or "rendering"
    url = provider_video_url(result)
    provider_name = PROVIDERS.get(provider_id, {}).get("name") or "Provider"
    failed_message = job.get("error") or "Provider render is not ready yet."
    if job.get("status") == "failed":
        stage = normalized_render_stage(status, message=failed_message)
        return {"ready": False, "stage": stage, "status": stage, "providerStatus": status, "message": user_render_message(stage, provider_name)}
    ready = bool(url and status in {"completed", "success"})
    stage = normalized_render_stage(status, ready=ready)
    return {
        "ready": ready,
        "stage": stage,
        "status": stage,
        "providerStatus": status,
        "sourceUrl": url,
        "providerJobId": provider_job_id,
        "raw": result,
        "message": user_render_message(stage, provider_name),
    }

def render_with_provider(payload):
    provider_id = (payload.get("provider") or "heygen").lower()
    account_id = account_id_from_payload(payload)
    if provider_id not in PROVIDERS:
        raise video_os.VideoOsError(f"Unsupported render provider: {provider_id}")
    if not payload.get("script"):
        raise video_os.VideoOsError("Add a script before requesting a live render.")
    _ensure_credit_balance(provider_id, account_id)
    project = create_lite_project({**payload, "accountId": account_id}, provider_id)
    try:
        if provider_id == "heygen":
            job = _submit_heygen(project)
            if job.get("status") == "failed":
                raise video_os.VideoOsError(job.get("error") or "HeyGen submission failed before a provider job was created.")
            result = job.get("result") or {}
            provider_job_id = project.get("providerJobId") or _provider_job_id(result)
            status = RENDER_STAGE_SUBMITTED
        elif provider_id == "argil":
            result = _submit_argil(project, payload)
            provider_job_id = _provider_job_id(result)
            status = "submitted"
        elif provider_id == "tavus":
            result = _submit_tavus(project, payload)
            provider_job_id = _provider_job_id(result)
            status = "submitted"
        else:
            result = _submit_did(project, payload)
            provider_job_id = _provider_job_id(result)
            status = "submitted"
        _credit_event("debit", -PROVIDERS[provider_id]["cost"], f"{PROVIDERS[provider_id]['name']} render", provider_id, project["id"], account_id)
        telemetry = project.get("telemetry") or {}
        telemetry.update({"providerStatus": status, "renderStage": RENDER_STAGE_SUBMITTED, "kitContext": kit_context(payload.get("productionKit") or recommend_production_kit(payload))})
        patch = {
            "status": "rendering",
            "reviewState": "provider_rendering",
            "provider": provider_id,
            "accountId": account_id,
            "providerJobId": provider_job_id,
            "telemetry": telemetry,
        }
        project = video_os.update_project(project["id"], patch)
        return {
            "project": project,
            "provider": PROVIDERS[provider_id],
            "accountId": account_id,
            "providerJobId": provider_job_id,
            "status": status,
            "stage": RENDER_STAGE_SUBMITTED,
            "message": user_render_message(RENDER_STAGE_SUBMITTED, PROVIDERS[provider_id]["name"]),
            "credits": _read_credits(),
            "raw": result,
        }
    except Exception as exc:
        video_os.update_project(project["id"], {
            "status": "quarantined",
            "reviewState": "provider_submit_failed",
            "telemetry": {"providerStatus": "failed", "providerError": str(exc)[:500]},
        })
        raise




def recommend_production_kit(payload):
    goal = (payload.get("goalType") or payload.get("topic") or "explainer").lower()
    tone = (payload.get("tone") or "warm").lower()
    music = "Infinite Morning - Kellin.wav"
    background = "Kinetic Dots background (white).mp4"
    lut = "iPhone 13 : Studio Contrast : Strong.cube"
    cta = "CIRCLE-1080.mov"
    overlay = "77-Heart-2.gif"
    if "sales" in goal or "confident" in tone:
        music = "Crystal Clear - Kellin.wav"
        background = "Static Background 1.mp4"
        lut = "Creative : Bright & Saturated : Strong.cube"
        cta = "Like and Subscribe ProRes.mov"
        overlay = "78-Hundred-Points.gif"
    elif "social" in goal or "high-energy" in tone:
        music = "Freefall - Kellin.wav"
        background = "VHS background Overlay.mp4"
        lut = "EOS-m50 : POP colors : Strong.cube"
        cta = "Arrow_6.mov"
        overlay = "75-Folded-Hands.gif"
    elif "demo" in goal:
        music = "BLT - Kellin.wav"
        background = "Kinetic Dots background (white).mp4"
        lut = "Fix : Overexposed & Preserve Shadows : Strong.cube"
        cta = "CIRCLE-1080.mov"
        overlay = "78-Hundred-Points.gif"
    return {
        "id": "kit-" + video_os.slugify(payload.get("title") or goal),
        "name": "Auto production kit",
        "reason": "Picked automatically from the included asset libraries based on goal and tone.",
        "music": {"name": music, "libraryId": "music-beds"},
        "background": {"name": background, "libraryId": "video-backgrounds"},
        "lut": {"name": lut, "libraryId": "color-grades"},
        "cta": {"name": cta, "libraryId": "cta-motion"},
        "overlay": {"name": overlay, "libraryId": "gif-reactions"},
    }
def account_status(account_id=None):
    account = _read_account()
    account_id = account_id or account.get("accountId") or default_account_id()
    requests = [item for item in _read_avatar_requests() if not item.get("accountId") or item.get("accountId") == account_id]
    return {
        "account": account,
        **provider_status(account.get("accountId")),
        "assetLibraries": ASSET_LIBRARIES,
        "avatarBuild": {
            "photoAvatar": {
                "available": bool(video_os.heygen_api_key()),
                "requires": ["Upload JPG/PNG/WebP or paste public HTTPS photo URL", "Consent to create an avatar"],
                "cost": 150,
            },
            "digitalTwin": {
                "available": bool(video_os.heygen_api_key()),
                "requires": ["Upload MP4/MOV or paste public HTTPS training video URL", "Consent to create a digital twin"],
                "cost": 300,
            },
            "requests": requests[-8:],
        },
    }


def create_avatar_asset(payload):
    avatar_type = (payload.get("type") or "photo").strip().lower()
    if avatar_type not in {"photo", "digital_twin"}:
        raise video_os.VideoOsError("Avatar type must be photo or digital_twin.")
    name = (payload.get("name") or "Client Avatar").strip()[:120]
    file_url = (payload.get("fileUrl") or "").strip()
    consent = bool(payload.get("consent"))
    if not consent:
        raise video_os.VideoOsError("Consent is required before creating a client avatar or digital twin.")
    if file_url.startswith("/uploads/"):
        requests = _read_avatar_requests()
        item = {
            "id": f"avatar-build-{uuid4().hex[:10]}",
            "accountId": account_id_from_payload(payload),
            "type": avatar_type,
            "name": name,
            "fileUrl": file_url,
            "status": "staged",
            "provider": "local",
            "createdAt": video_os.utc_now(),
            "message": "Source file is staged locally. Set VIDEO_OS_PUBLIC_URL to an HTTPS URL or paste a public file URL to submit to HeyGen.",
        }
        requests.append(item)
        _write_avatar_requests(requests)
        return {"request": item, "credits": _read_credits(), "message": item["message"]}
    if not file_url.startswith("https://"):
        raise video_os.VideoOsError("Use an uploaded local source or a public HTTPS file URL for the avatar source asset.")
    cost = 300 if avatar_type == "digital_twin" else 150
    credits = _read_credits()
    if int(credits.get("balance") or 0) < cost:
        raise video_os.VideoOsError(f"Not enough credits. This avatar build requires {cost} credits.")
    key = video_os.heygen_api_key()
    if not key:
        raise video_os.VideoOsError("HeyGen is not configured for avatar creation.")
    body = {
        "type": avatar_type,
        "name": name,
        "file": {"type": "url", "url": file_url},
    }
    if payload.get("avatarGroupId"):
        body["avatar_group_id"] = str(payload.get("avatarGroupId"))
    result = _json_request("https://api.heygen.com/v3/avatars", body, {"x-api-key": key, "X-Api-Key": key})
    requests = _read_avatar_requests()
    item = {
        "id": f"avatar-build-{uuid4().hex[:10]}",
        "accountId": account_id_from_payload(payload),
            "type": avatar_type,
        "name": name,
        "fileUrl": file_url,
        "status": "submitted",
        "provider": "heygen",
        "createdAt": video_os.utc_now(),
        "result": result,
    }
    requests.append(item)
    _write_avatar_requests(requests)
    _credit_event("debit", -cost, f"HeyGen {avatar_type} build", "heygen", item["id"], account_id_from_payload(payload))
    return {"request": item, "credits": _read_credits()}
def create_checkout(payload):
    account_id = account_id_from_payload(payload)
    payment_link = os.environ.get("STRIPE_PAYMENT_LINK_URL")
    if payment_link:
        return {"url": payment_link, "mode": "payment_link", "accountId": account_id}
    secret = os.environ.get("STRIPE_SECRET_KEY")
    price_id = os.environ.get("STRIPE_CREDIT_PRICE_ID")
    if not secret or not price_id:
        raise video_os.VideoOsError("Stripe is not configured. Set STRIPE_PAYMENT_LINK_URL or STRIPE_SECRET_KEY plus STRIPE_CREDIT_PRICE_ID.")
    origin = payload.get("origin") or os.environ.get("VIDEO_OS_PUBLIC_URL") or "http://127.0.0.1:8789"
    form = urllib.parse.urlencode({
        "success_url": f"{origin}/?checkout=success",
        "cancel_url": f"{origin}/?checkout=cancelled",
        "mode": "payment",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": str(max(1, int(payload.get("quantity") or 1))),
        "client_reference_id": account_id,
        "metadata[account_id]": account_id,
    }).encode("utf-8")
    auth = base64.b64encode(f"{secret}:".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(
        "https://api.stripe.com/v1/checkout/sessions",
        data=form,
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise video_os.VideoOsError(f"Stripe checkout failed: HTTP {exc.code} {detail}") from exc
    return {"url": result.get("url"), "id": result.get("id"), "mode": "checkout_session", "accountId": account_id}





























