import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4


ROOT = Path(__file__).resolve().parent
PUBLIC_VIDEO_OS = ROOT / "public" / "data" / "video-os.json"
HOSTED_VIDEO_OS = ROOT / "public" / "video-os.json"
PRIVATE_ROOT = ROOT / "data" / "video-os"
PROJECTS_FILE = PRIVATE_ROOT / "projects.json"
SQLITE_FILE = PRIVATE_ROOT / "video-os.sqlite3"
FEEDBACK_FILE = PRIVATE_ROOT / "feedback.jsonl"
JOBS_DIR = PRIVATE_ROOT / "jobs"
ARTIFACTS_DIR = PRIVATE_ROOT / "artifacts"
POST_DIR = PRIVATE_ROOT / "post-production-handoffs"
TRENDS_DIR = PRIVATE_ROOT / "trends"
TREND_RUNS_DIR = TRENDS_DIR / "runs"
TREND_OPPORTUNITIES_FILE = TRENDS_DIR / "opportunities.json"
TREND_WATCHLIST_FILE = TRENDS_DIR / "watchlists.json"
TREND_SOURCE_HEALTH_FILE = TRENDS_DIR / "source-health.json"
WORKER_HEARTBEAT_FILE = PRIVATE_ROOT / "worker-heartbeat.json"
TALENT_INVENTORY_FILE = PRIVATE_ROOT / "talent-inventory.json"
DEFAULT_LAST30DAYS_SCRIPT = (
    Path.home()
    / "OneDrive"
    / "Documents"
    / "Obsidian"
    / "LUX"
    / "03 Execution"
    / "Automations"
    / "content-intelligence-engine"
    / "agents"
    / "last30days"
    / "scripts"
    / "last30days.py"
)
LAST30DAYS_SCRIPT = Path(os.environ.get("LAST30DAYS_SCRIPT_PATH") or DEFAULT_LAST30DAYS_SCRIPT)
VIDEO_HELPER_ROOT = Path.home() / "OneDrive" / "Desktop" / "VIDEO HELPER"
HEYGEN_SUBMISSIONS_DIR = VIDEO_HELPER_ROOT / "heygen_submissions"
HEYGEN_KEY_FILE = Path(os.environ.get("HEYGEN_KEY_FILE") or (VIDEO_HELPER_ROOT / "HeyGen.txt"))
HEYGEN_AVATARS_URL = os.environ.get("HEYGEN_AVATARS_URL") or "https://api.heygen.com/v2/avatars"
HEYGEN_VOICES_URL = os.environ.get("HEYGEN_VOICES_URL") or "https://api.heygen.com/v2/voices"
PINNED_PRIVATE_HEYGEN_AVATARS = [
    {
        "id": "880ad1223ca84f9590f21a0df4bf66b2",
        "name": "KD",
        "source": "heygen",
        "style": "private",
        "visibility": "private",
        "role": "LUX leadership avatar",
        "notes": "Pinned private HeyGen avatar used for LUX AI OS executive briefing videos.",
    },
]
STATE_MACHINE = [
    "draft",
    "configured",
    "research_queued",
    "research_ready",
    "brief_ready",
    "script_draft",
    "review_required",
    "approved",
    "render_queued",
    "rendering",
    "rendered",
    "qc_required",
    "approved_for_publish",
    "published",
    "monitoring",
    "failed",
    "quarantined",
    "cancelled",
]
JOB_TYPES = {
    "script_generation",
    "heygen_submit",
    "heygen_poll",
    "artifact_archive",
    "post_production_handoff",
    "trend_discovery",
    "trend_scoring",
    "trend_to_video_project",
}
TREND_JOB_TYPES = {"trend_discovery", "trend_scoring", "trend_to_video_project"}
MAX_TEXT = 12_000
IO_LOCK = threading.RLock()
DEFAULT_SCAN_INTERVAL_HOURS = max(1, int(os.environ.get("VIDEO_OS_SCAN_INTERVAL_HOURS", "24")))
DEFAULT_TREND_WATCHLISTS = [
    {
        "id": "ai-video-production",
        "name": "AI Video Production",
        "industry": "AI video",
        "demo": "founders, marketers, sales leaders",
        "topic": "AI video tools and avatar production",
        "region": "US",
        "platforms": ["reddit", "youtube", "tiktok", "instagram"],
        "freshnessDays": 30,
    },
    {
        "id": "sales-enablement-ai",
        "name": "Sales Enablement AI",
        "industry": "B2B sales",
        "demo": "sales reps, managers, operators",
        "topic": "AI sales coaching call intelligence dashboards",
        "region": "US",
        "platforms": ["reddit", "youtube", "hackernews"],
        "freshnessDays": 30,
    },
]
DEFAULT_TALENT_INVENTORY = {
    "avatars": [
        {"id": "default-studio-presenter", "name": "Default Studio Presenter", "source": "local", "style": "balanced"},
        {"id": "executive-narrator", "name": "Executive Narrator", "source": "local", "style": "executive"},
        {"id": "friendly-operator", "name": "Friendly Operator", "source": "local", "style": "training"},
        {"id": "client-report-guide", "name": "Client Report Guide", "source": "local", "style": "client-facing"},
    ],
    "voices": [
        {"id": "brand-neutral-executive", "name": "Brand Neutral Executive", "source": "local", "style": "balanced"},
        {"id": "calm-strategist", "name": "Calm Strategist", "source": "local", "style": "strategic"},
        {"id": "high-clarity-trainer", "name": "High-Clarity Trainer", "source": "local", "style": "training"},
        {"id": "premium-report-host", "name": "Premium Report Host", "source": "local", "style": "client-facing"},
    ],
}
DISCOVER_OPTIONS = {
    "industries": [
        {"id": "ai-video", "label": "AI Video", "value": "AI video"},
        {"id": "b2b-sales", "label": "B2B Sales", "value": "B2B sales"},
        {"id": "home-services", "label": "Home Services", "value": "home services"},
        {"id": "local-seo", "label": "Local SEO", "value": "local SEO"},
        {"id": "client-reporting", "label": "Client Reporting", "value": "client reporting"},
    ],
    "audiences": [
        {"id": "founders-marketing", "label": "Founders + Marketing Leaders", "value": "founders and marketing leaders"},
        {"id": "sales-managers", "label": "Sales Managers", "value": "sales managers"},
        {"id": "operators", "label": "Operators", "value": "operations leaders"},
        {"id": "local-business-owners", "label": "Local Business Owners", "value": "local business owners"},
        {"id": "client-stakeholders", "label": "Client Stakeholders", "value": "client stakeholders"},
    ],
    "topics": [
        {"id": "ai-video-tools", "label": "AI video tools", "value": "AI video tools and avatar production"},
        {"id": "sales-call-intelligence", "label": "Sales call intelligence", "value": "AI sales coaching call intelligence dashboards"},
        {"id": "local-seo-ai-search", "label": "Local SEO + AI search", "value": "local SEO and AI search visibility"},
        {"id": "client-report-videos", "label": "Client report videos", "value": "AI generated client report videos"},
        {"id": "automation-dashboards", "label": "Automation dashboards", "value": "automation dashboards for marketing operations"},
    ],
    "regions": [
        {"id": "us", "label": "United States", "value": "US"},
        {"id": "north-america", "label": "North America", "value": "North America"},
        {"id": "english-global", "label": "English-speaking global", "value": "English-speaking global"},
        {"id": "local-market", "label": "Local market", "value": "local market"},
    ],
    "platforms": [
        {"id": "reddit", "label": "Reddit", "available": True, "note": "Always available via public Reddit adapter."},
        {"id": "youtube", "label": "YouTube", "available": True, "note": "Requires yt-dlp or configured YouTube source for best coverage."},
        {"id": "tiktok", "label": "TikTok", "available": False, "note": "Requires ScrapeCreators API key."},
        {"id": "instagram", "label": "Instagram", "available": False, "note": "Requires ScrapeCreators API key."},
        {"id": "hackernews", "label": "Hacker News", "available": True, "note": "Useful for AI/dev/operator topics."},
        {"id": "grounding", "label": "Web", "available": False, "note": "Requires Brave, Exa, Serper, or Parallel API key."},
        {"id": "github", "label": "GitHub", "available": False, "note": "Requires GitHub token or gh CLI auth."},
    ],
    "limits": [
        "Topic can be custom, but the knowledge base is strongest for AI video, sales enablement, local SEO, automation, client reporting, and LUX operating workflows.",
        "Region is currently metadata for scoring and positioning; Last30Days does not guarantee true geo-filtered source retrieval for every platform.",
        "Audience/demo is used for scoring, angle generation, and brief creation; it is not a hard audience filter inside every external source.",
        "Platform scans are restricted to Last30Days source keys and whatever credentials/tools are available locally.",
    ],
}
DEFAULT_SCAN_RECIPES = [
    {
        "id": "ai-video-founder-radar",
        "name": "AI Video Founder Radar",
        "industry": "AI video",
        "demo": "founders and marketing leaders",
        "topic": "AI video tools and avatar production",
        "region": "US",
        "platforms": ["reddit", "youtube"],
        "freshnessDays": 30,
    },
    {
        "id": "sales-enablement-ops-radar",
        "name": "Sales Enablement Ops Radar",
        "industry": "B2B sales",
        "demo": "sales managers",
        "topic": "AI sales coaching call intelligence dashboards",
        "region": "US",
        "platforms": ["reddit", "youtube", "hackernews"],
        "freshnessDays": 30,
    },
    {
        "id": "local-seo-ai-search-radar",
        "name": "Local SEO + AI Search Radar",
        "industry": "local SEO",
        "demo": "local business owners",
        "topic": "local SEO and AI search visibility",
        "region": "US",
        "platforms": ["reddit", "youtube", "grounding"],
        "freshnessDays": 30,
    },
]


class VideoOsError(ValueError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def parse_utc(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def future_utc(hours):
    return (datetime.now(timezone.utc) + timedelta(hours=max(1, int(hours)))).isoformat()


def ensure_dirs():
    for path in [
        PRIVATE_ROOT,
        JOBS_DIR,
        ARTIFACTS_DIR,
        POST_DIR,
        TRENDS_DIR,
        TREND_RUNS_DIR,
        PUBLIC_VIDEO_OS.parent,
        HOSTED_VIDEO_OS.parent,
    ]:
        path.mkdir(parents=True, exist_ok=True)


def read_json(path, default):
    with IO_LOCK:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise VideoOsError(f"Could not parse {path}: {exc}") from exc


def write_json(path, payload):
    with IO_LOCK:
        ensure_dirs()
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        temp.replace(path)


def db_connect():
    ensure_dirs()
    conn = sqlite3.connect(SQLITE_FILE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db():
    with IO_LOCK, db_connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS video_projects (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                project_id TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
            CREATE TABLE IF NOT EXISTS trend_opportunities (
                id TEXT PRIMARY KEY,
                score REAL,
                status TEXT,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS watchlists (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS discover_options (
                category TEXT NOT NULL,
                id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (category, id)
            );
            CREATE TABLE IF NOT EXISTS scan_recipes (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scan_schedules (
                id TEXT PRIMARY KEY,
                watchlist_id TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL,
                interval_hours INTEGER NOT NULL,
                next_run_at TEXT NOT NULL,
                last_queued_at TEXT,
                last_job_id TEXT,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        seed_discover_config(conn)
        migrated = conn.execute("SELECT value FROM meta WHERE key = 'json_migrated'").fetchone()
        if migrated:
            conn.commit()
            return
        if PROJECTS_FILE.exists():
            store = read_json(PROJECTS_FILE, {"projects": []})
        else:
            seed = load_public_seed()
            store = {"projects": seed.get("projects", [])}
        for raw in store.get("projects", []):
            project = normalize_project(raw)
            conn.execute(
                "INSERT OR REPLACE INTO video_projects (id, status, updated_at, payload) VALUES (?, ?, ?, ?)",
                (project["id"], project["status"], project["updatedAt"], json.dumps(project, ensure_ascii=False)),
            )
        if JOBS_DIR.exists():
            for path in JOBS_DIR.glob("*.json"):
                job = read_json(path, {})
                if not job.get("id"):
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO jobs (id, type, project_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        job["id"],
                        job.get("type") or "",
                        job.get("projectId"),
                        job.get("status") or "queued",
                        job.get("createdAt") or utc_now(),
                        job.get("updatedAt") or utc_now(),
                        json.dumps(job, ensure_ascii=False),
                    ),
                )
        trend_payload = read_json(TREND_OPPORTUNITIES_FILE, {"opportunities": []})
        for raw in trend_payload.get("opportunities", []):
            item = enrich_opportunity(raw)
            conn.execute(
                "INSERT OR REPLACE INTO trend_opportunities (id, score, status, updated_at, payload) VALUES (?, ?, ?, ?, ?)",
                (
                    item["id"],
                    float(item.get("videoOpportunityScore") or 0),
                    item.get("status") or "candidate",
                    item.get("updatedAt") or utc_now(),
                    json.dumps(item, ensure_ascii=False),
                ),
            )
        watch_payload = read_json(TREND_WATCHLIST_FILE, {"watchlists": DEFAULT_TREND_WATCHLISTS})
        for raw in watch_payload.get("watchlists") or DEFAULT_TREND_WATCHLISTS:
            item = {**raw, "id": raw.get("id") or slugify(raw.get("name") or raw.get("topic"))}
            conn.execute(
                "INSERT OR REPLACE INTO watchlists (id, updated_at, payload) VALUES (?, ?, ?)",
                (item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', ?)",
            (utc_now(),),
        )
        conn.commit()


def db_ready():
    init_db()


def seed_discover_config(conn):
    for category in ("industries", "audiences", "topics", "regions", "platforms"):
        existing = conn.execute(
            "SELECT COUNT(*) AS count FROM discover_options WHERE category = ?",
            (category,),
        ).fetchone()["count"]
        if existing:
            continue
        for raw in DISCOVER_OPTIONS.get(category, []):
            item = {**raw, "id": raw.get("id") or slugify(raw.get("label") or raw.get("value"))}
            conn.execute(
                "INSERT OR REPLACE INTO discover_options (category, id, updated_at, payload) VALUES (?, ?, ?, ?)",
                (category, item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
            )
    existing_recipes = conn.execute("SELECT COUNT(*) AS count FROM scan_recipes").fetchone()["count"]
    if not existing_recipes:
        for raw in DEFAULT_SCAN_RECIPES:
            item = {**raw, "id": raw.get("id") or slugify(raw.get("name"))}
            conn.execute(
                "INSERT OR REPLACE INTO scan_recipes (id, updated_at, payload) VALUES (?, ?, ?)",
                (item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
            )


def slugify(value):
    text = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return text[:72].strip("-") or f"video-{uuid4().hex[:8]}"


def clamp_text(value, max_len=MAX_TEXT):
    text = str(value or "").strip()
    return text[:max_len]


def load_public_seed():
    return read_json(PUBLIC_VIDEO_OS, {"projects": [], "templates": [], "gates": []})


def normalize_project(project):
    now = utc_now()
    avatar = project.get("avatar") or {}
    voice = project.get("voice") or {}
    if project.get("avatarId"):
        avatar = {**avatar, "avatarId": project.get("avatarId")}
    if project.get("voiceId"):
        voice = {**voice, "voiceId": project.get("voiceId")}
    normalized = {
        "id": project.get("id") or slugify(project.get("name") or project.get("topic")),
        "name": clamp_text(project.get("name") or project.get("title") or "Untitled Video", 160),
        "template": project.get("template") or "custom",
        "scriptMode": project.get("scriptMode") or "generate",
        "status": project.get("status") or "draft",
        "owner": project.get("owner") or "LUX Video AI OS",
        "accountId": clamp_text(project.get("accountId") or (project.get("customer") or {}).get("accountId") or "local-client", 160),
        "customer": project.get("customer") or {"accountId": project.get("accountId") or "local-client"},
        "audience": clamp_text(project.get("audience"), 500),
        "goal": clamp_text(project.get("goal"), 800),
        "topic": clamp_text(project.get("topic") or project.get("name"), 500),
        "tone": clamp_text(project.get("tone") or "authoritative, clear, premium", 240),
        "aesthetic": clamp_text(project.get("aesthetic") or "LUX command-center cinematic", 240),
        "avatar": avatar,
        "voice": voice,
        "scriptInput": clamp_text(project.get("scriptInput") or project.get("script") or "", MAX_TEXT),
        "sourceNotes": clamp_text(project.get("sourceNotes") or "", MAX_TEXT),
        "provider": project.get("provider") or "HeyGen v3 Video Agent",
        "providerJobId": project.get("providerJobId"),
        "sessionId": project.get("sessionId"),
        "renderFormat": project.get("renderFormat"),
        "productionKit": project.get("productionKit") or {},
        "kitContext": project.get("kitContext") or {},
        "renderNotes": clamp_text(project.get("renderNotes") or "", MAX_TEXT),
        "brand": project.get("brand") or {},
        "durationSeconds": project.get("durationSeconds"),
        "qualityScore": project.get("qualityScore"),
        "reviewState": project.get("reviewState") or "not_started",
        "cost": project.get("cost") or {"renderAttempts": 0, "estimatedCredits": 0, "postProductionEstimate": "unknown"},
        "telemetry": project.get("telemetry") or {
            "providerStatus": "not_submitted",
            "etaMinutes": None,
            "latencyRisk": "unknown",
            "fallbackAvatar": "default-studio-presenter",
            "fallbackVoice": "brand-neutral-executive",
        },
        "versions": project.get("versions") or {"scripts": [], "sceneManifests": [], "renders": [], "postProduction": []},
        "feedbackCount": int(project.get("feedbackCount") or 0),
        "nextActions": project.get("nextActions") or [],
        "createdAt": project.get("createdAt") or now,
        "updatedAt": now,
    }
    if normalized["status"] not in STATE_MACHINE:
        normalized["status"] = "draft"
    return normalized


def load_store():
    db_ready()
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT payload FROM video_projects ORDER BY updated_at DESC"
        ).fetchall()
    projects = [normalize_project(json.loads(row["payload"])) for row in rows]
    return {
        "version": "2026-05-20-sqlite",
        "createdAt": projects[-1]["createdAt"] if projects else utc_now(),
        "updatedAt": utc_now(),
        "projects": projects,
    }


def save_store(store):
    store["updatedAt"] = utc_now()
    db_ready()
    with IO_LOCK, db_connect() as conn:
        for raw in store.get("projects", []):
            project = normalize_project(raw)
            conn.execute(
                "INSERT OR REPLACE INTO video_projects (id, status, updated_at, payload) VALUES (?, ?, ?, ?)",
                (project["id"], project["status"], project["updatedAt"], json.dumps(project, ensure_ascii=False)),
            )
        conn.commit()
    write_json(PROJECTS_FILE, store)
    publish_public_snapshot(store=store)


def find_project(store, project_id):
    for project in store.get("projects", []):
        if project.get("id") == project_id:
            return project
    return None


def public_foundation():
    seed = load_public_seed()
    return {
        "version": seed.get("version", "2026-05-18"),
        "system": seed.get("system", {}),
        "stateMachine": seed.get("stateMachine", {"states": STATE_MACHINE, "branchStates": []}),
        "templates": seed.get("templates", []),
        "gates": seed.get("gates", []),
        "reviewRoom": seed.get("reviewRoom", {}),
        "assetIntelligence": normalize_asset_intelligence(seed.get("assetIntelligence")),
        "postProduction": seed.get("postProduction", {}),
        "feedback": seed.get("feedback", {}),
        "trendIntelligence": seed.get("trendIntelligence", {
            "positioning": "Trend-to-video decision layer for finding timely market signals by industry, demographic, topic, platform, and region.",
            "sources": ["last30days", "Apify-ready", "YouTube Data API-ready", "Google Trends API Alpha-ready"],
            "qualityGates": [
                "source evidence present",
                "audience fit scored",
                "brand safety reviewed",
                "video angle selected",
                "human approval before render",
            ],
        }),
    }


def default_asset_intelligence():
    return {
        "positioning": "Scene-aware production asset router for making every LUX video feel edited, graded, and intentionally paced.",
        "localLibraryRoot": r"C:\Users\ariel\OneDrive\Desktop\VIDEO HELPER",
        "packs": [
            {
                "name": "Backgrounds",
                "archive": "Backgrounds-20260518T142540Z-3-001.zip",
                "count": 4,
                "role": "scene environments and subtle movement plates",
                "bestUses": ["cold open", "presenter backdrop", "dashboard transition bed"],
                "recommended": ["Static Background 1.mp4", "Kinetic Dots background (white).mp4"],
                "avoidForExecutive": ["Crumpled Paper Background.mp4", "VHS background Overlay.mp4"],
            },
            {
                "name": "Music",
                "archive": "Music-20260518T142537Z-3-001.zip",
                "count": 5,
                "role": "emotional bed and pacing spine",
                "bestUses": ["product reveal", "manager walkthrough", "strategic briefing"],
                "recommended": ["Crystal Clear - Kellin.wav", "Infinite Morning - Kellin.wav", "Freefall - Kellin.wav"],
            },
            {
                "name": "Sound Effects",
                "archive": "Sound Effects-20260518T142542Z-3-001.zip",
                "count": 7,
                "role": "micro-emphasis, UI proof, and transition punctuation",
                "bestUses": ["node reveal", "email arrival", "KPI highlight", "scene transition"],
                "recommended": ["Mouse Click.wav", "Pop.wav", "Bell.wav", "Tension Builder.wav"],
                "useSparingly": ["Impact.wav", "Whip whoosh.mp3", "Braam cinematic hit.wav"],
            },
            {
                "name": "LUT Pack #1",
                "archive": "LUT PACK #1-20260518T142543Z-3-001.zip",
                "count": 12,
                "role": "brand color grade and render unification",
                "bestUses": ["avatar footage", "dashboard inserts", "final master"],
                "recommended": ["Creative _ Teal Shadows _ Strong.cube", "Creative _ Moody _ Strong.cube", "iPhone 13 _ Anamorphic Levels _ Subtle.cube"],
            },
            {
                "name": "YouTube Elements",
                "archive": "Youtube Elements-20260518T142538Z-3-001.zip",
                "count": 4,
                "role": "platform-native overlays for derivatives",
                "bestUses": ["YouTube cutdown", "CTA moment", "dashboard pointer"],
                "recommended": ["CIRCLE-1080.mov", "Arrow_6.mov"],
                "avoidForExecutive": ["Like, Notify, and subscribe_1.mov", "Like and Subscribe ProRes.mov"],
            },
            {
                "name": "GIF",
                "archive": "GIF-20260518T142536Z-3-001.zip",
                "count": 79,
                "role": "social cutdown emphasis and OSO micro-moments",
                "bestUses": ["short-form cutdowns", "email GIF loops", "playful proof moments"],
                "recommended": ["78-Hundred-Points.gif", "73-OK-Hand.gif", "74-Thumbs-Up.gif", "63-Pondering.gif"],
            },
        ],
        "sceneRouting": [
            {
                "moment": "Cold Open / Narrative Hook",
                "assets": ["Static Background 1.mp4", "Tension Builder.wav", "Creative _ Teal Shadows _ Strong.cube"],
                "direction": "Open with controlled movement, one low tension rise, and deep-blue grade. Avoid gimmick overlays.",
            },
            {
                "moment": "Fathom Transcript Flow",
                "assets": ["Mouse Click.wav", "Pop.wav", "Kinetic Dots background (white).mp4"],
                "direction": "Use clean UI clicks, soft card reveals, and restrained background motion behind transcript excerpts.",
            },
            {
                "moment": "n8n Orchestration Logic",
                "assets": ["Whip whoosh.mp3", "Impact.wav", "Arrow_6.mov"],
                "direction": "Use quick transitions only when moving between nodes. Keep SFX low so it feels engineered, not YouTube-template.",
            },
            {
                "moment": "Dashboard / KPI Proof",
                "assets": ["CIRCLE-1080.mov", "Mouse Click.wav", "Creative _ Moody _ Strong.cube"],
                "direction": "Circle or point to one metric at a time; grade inserts consistently with the master.",
            },
            {
                "moment": "Manager Coaching Insight",
                "assets": ["Crystal Clear - Kellin.wav", "Bell.wav", "iPhone 13 _ Anamorphic Levels _ Subtle.cube"],
                "direction": "Reduce motion and music density. Use one completion cue when the action becomes clear.",
            },
            {
                "moment": "Social / YouTube Derivative",
                "assets": ["78-Hundred-Points.gif", "Arrow_6.mov", "Like and Subscribe ProRes.mov"],
                "direction": "Use platform-native assets only in derivatives, never in the executive master unless explicitly selected.",
            },
        ],
        "externalSources": [
            {
                "name": "Pexels",
                "type": "stock video / photography",
                "licenseNote": "Free for personal and commercial use under Pexels license; avoid unmodified resale.",
                "bestFor": "premium B-roll, office, abstract technology, people-in-workflow cutaways",
                "status": "candidate source",
            },
            {
                "name": "Mixkit",
                "type": "stock video / music / SFX / templates",
                "licenseNote": "Free stock video license supports commercial marketing projects; check asset-specific terms.",
                "bestFor": "abstract backgrounds, transitions, subtle corporate B-roll",
                "status": "candidate source",
            },
            {
                "name": "LottieFiles",
                "type": "Lottie motion graphics",
                "licenseNote": "Free animations use Lottie Simple License; commercial use allowed, standalone redistribution restricted.",
                "bestFor": "data loading, checkmarks, AI node animations, light UI motion accents",
                "status": "candidate source",
            },
            {
                "name": "CC0 SFX Libraries",
                "type": "sound effects",
                "licenseNote": "Prefer CC0 or clearly royalty-free SFX; store source URL and license proof at ingest.",
                "bestFor": "whooshes, soft UI clicks, risers, impacts, confirmation sounds",
                "status": "candidate source",
            },
            {
                "name": "GitHub / Remotion / HyperFrames",
                "type": "code-native transitions and motion systems",
                "licenseNote": "Use permissive MIT/open-source code where possible; record repository license before copying.",
                "bestFor": "repeatable transitions, captions, kinetic typography, dashboard motion templates",
                "status": "tooling source",
            },
        ],
        "rules": [
            "Executive master uses restrained backgrounds, LUTs, music, and subtle SFX.",
            "YouTube subscribe elements and GIF reactions are derivative-only unless manually approved.",
            "Every downloaded external asset must store source URL, license, creator, date, and intended use.",
            "Asset selection should be attached to scene manifests before HeyGen render or post-production handoff.",
            "Use Remotion or HyperFrames for reusable motion templates; use FFmpeg for LUT, audio mix, and final assembly.",
        ],
    }


def normalize_asset_intelligence(existing=None):
    base = default_asset_intelligence()
    if not existing:
        return base
    merged = {**existing}
    for key in ["positioning", "localLibraryRoot", "packs", "sceneRouting", "externalSources", "rules"]:
        if not merged.get(key):
            merged[key] = base[key]
    return merged


def scene_asset_profiles():
    return {
        "cold_open": {
            "label": "Cold Open / Narrative Hook",
            "background": "Static Background 1.mp4",
            "lut": "Creative _ Teal Shadows _ Strong.cube",
            "music": "Crystal Clear - Kellin.wav",
            "sfx": ["Tension Builder.wav", "Pop.wav"],
            "overlay": "none",
            "transitionIn": "cinematic fade with subtle light sweep",
            "transitionOut": "15-frame Remotion fade into workflow reveal",
            "motion": "slow parallax, controlled type reveal, one proof stat entering after the hook",
            "technique": "Remotion TransitionSeries fade + HyperFrames GSAP stagger; keep avatar/presenter readable.",
            "rule": "Establish authority in the first 3 seconds; no GIFs, no subscribe elements.",
        },
        "transcript_flow": {
            "label": "Fathom Transcript Flow",
            "background": "Kinetic Dots background (white).mp4",
            "lut": "iPhone 13 _ Anamorphic Levels _ Subtle.cube",
            "music": "Crystal Clear - Kellin.wav",
            "sfx": ["Mouse Click.wav", "Pop.wav"],
            "overlay": "none",
            "transitionIn": "soft slide from right with transcript card mask",
            "transitionOut": "crossfade into automation map",
            "motion": "highlight phrases as evidence, then collapse transcript into structured fields",
            "technique": "HyperFrames timeline with masked card reveal; use SFX only on evidence locks.",
            "rule": "Use transcript text as proof, not decoration. One highlighted claim at a time.",
        },
        "n8n_logic": {
            "label": "n8n Orchestration Logic",
            "background": "Static Background 1.mp4",
            "lut": "Creative _ Moody _ Strong.cube",
            "music": "Freefall - Kellin.wav",
            "sfx": ["Mouse Click.wav", "Whip whoosh.mp3", "Impact.wav"],
            "overlay": "Arrow_6.mov",
            "transitionIn": "node-line wipe",
            "transitionOut": "directional slide into output proof",
            "motion": "route line animates Fathom to n8n to email/dashboard; nodes pulse only when active",
            "technique": "Remotion wipe/slide transitions; use GSAP stroke-dashoffset for node paths.",
            "rule": "Make orchestration legible before making it cinematic.",
        },
        "kpi_proof": {
            "label": "Dashboard / KPI Proof",
            "background": "Static Background 1.mp4",
            "lut": "Creative _ Moody _ Strong.cube",
            "music": "Crystal Clear - Kellin.wav",
            "sfx": ["Mouse Click.wav", "Bell.wav"],
            "overlay": "CIRCLE-1080.mov",
            "transitionIn": "precision zoom to KPI panel",
            "transitionOut": "clean cut after metric comprehension",
            "motion": "spotlight one KPI, then reveal implication and manager action",
            "technique": "Remotion scale interpolation with overlay mask; avoid constant camera movement.",
            "rule": "Every highlighted metric needs a business interpretation.",
        },
        "manager_coaching": {
            "label": "Manager Coaching Insight",
            "background": "Kinetic Dots background (white).mp4",
            "lut": "iPhone 13 _ Anamorphic Levels _ Subtle.cube",
            "music": "Waimea - Kellin.wav",
            "sfx": ["Bell.wav", "Pop.wav"],
            "overlay": "none",
            "transitionIn": "calm dissolve from KPI proof",
            "transitionOut": "fade into CTA",
            "motion": "reduce density, use calmer lower thirds, keep presenter/direct camera dominant",
            "technique": "Remotion fade + lower-third spring with high damping.",
            "rule": "This is the trust-building segment. Slow down and clarify the coaching behavior.",
        },
        "cta": {
            "label": "CTA / Feedback Ask",
            "background": "Static Background 1.mp4",
            "lut": "Creative _ Teal Shadows _ Strong.cube",
            "music": "Infinite Morning - Kellin.wav",
            "sfx": ["Bell.wav"],
            "overlay": "none",
            "transitionIn": "minimal fade",
            "transitionOut": "brand lockup fade to black-blue",
            "motion": "feedback prompt slides in after presenter ask; hold long enough to read",
            "technique": "HyperFrames static hero frame first, then GSAP from() entrance.",
            "rule": "One CTA only: ask reps/managers what was unclear and what would make the next video more useful.",
        },
        "social_derivative": {
            "label": "Social / YouTube Derivative",
            "background": "VHS background Overlay.mp4",
            "lut": "Creative _ Bright & Saturated _ Strong.cube",
            "music": "Freefall - Kellin.wav",
            "sfx": ["Whip whoosh.mp3", "Impact.wav", "Pop.wav"],
            "overlay": "Arrow_6.mov",
            "gif": "78-Hundred-Points.gif",
            "transitionIn": "fast pattern-interrupt cut",
            "transitionOut": "platform-native CTA snap",
            "motion": "faster captions, bolder callouts, one GIF/proof accent max",
            "technique": "Derivative-only Remotion composition with tighter cuts and caption emphasis.",
            "rule": "Never use this profile in the executive master unless manually approved.",
        },
    }


def classify_scene_purpose(scene, project=None):
    text = " ".join([
        str(scene.get("visual") or ""),
        str(scene.get("cutaway") or ""),
        str(project.get("template") if project else ""),
        str(project.get("topic") if project else ""),
    ]).lower()
    if "social" in text or "youtube" in text or "subscribe" in text:
        return "social_derivative"
    if "feedback" in text or "cta" in text or "next-project" in text or "next project" in text:
        return "cta"
    if "coach" in text or "manager" in text or "decision" in text or "quality" in text:
        return "manager_coaching"
    if "kpi" in text or "dashboard" in text or "email" in text or "strategy decode" in text:
        return "kpi_proof"
    if "n8n" in text or "orchestration" in text or "workflow" in text or "node" in text:
        return "n8n_logic"
    if "transcript" in text or "fathom" in text:
        return "transcript_flow"
    return "cold_open"


def choose_assets_for_scene(scene, project=None, forced_purpose=None):
    purpose = forced_purpose or classify_scene_purpose(scene, project)
    profile = scene_asset_profiles().get(purpose) or scene_asset_profiles()["cold_open"]
    return {
        "purpose": purpose,
        "label": profile["label"],
        "background": profile.get("background"),
        "lut": profile.get("lut"),
        "music": profile.get("music"),
        "sfx": profile.get("sfx", []),
        "overlay": profile.get("overlay"),
        "gif": profile.get("gif"),
        "transitionIn": profile.get("transitionIn"),
        "transitionOut": profile.get("transitionOut"),
        "motion": profile.get("motion"),
        "technique": profile.get("technique"),
        "rule": profile.get("rule"),
        "execution": {
            "renderEngine": "Remotion or HyperFrames post layer",
            "ffmpeg": "Apply selected LUT with lut3d during final assembly; mix SFX below narration.",
            "qualityGate": "Confirm readability, audio ducking, brand fit, and derivative-only restrictions before export.",
        },
    }


def job_counts():
    db_ready()
    counts = {"queued": 0, "running": 0, "completed": 0, "failed": 0}
    with db_connect() as conn:
        rows = conn.execute("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").fetchall()
    for row in rows:
        counts[row["status"]] = row["count"]
    return counts


def load_watchlists():
    db_ready()
    with db_connect() as conn:
        rows = conn.execute("SELECT payload FROM watchlists ORDER BY id").fetchall()
        if not rows:
            for raw in DEFAULT_TREND_WATCHLISTS:
                item = {**raw, "id": raw.get("id") or slugify(raw.get("name") or raw.get("topic"))}
                conn.execute(
                    "INSERT OR REPLACE INTO watchlists (id, updated_at, payload) VALUES (?, ?, ?)",
                    (item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
                )
            conn.commit()
            rows = conn.execute("SELECT payload FROM watchlists ORDER BY id").fetchall()
    watchlists = [json.loads(row["payload"]) for row in rows]
    write_json(TREND_WATCHLIST_FILE, {"updatedAt": utc_now(), "watchlists": watchlists})
    return watchlists


def save_watchlists(watchlists):
    db_ready()
    normalized = []
    with IO_LOCK, db_connect() as conn:
        conn.execute("DELETE FROM watchlists")
        for raw in watchlists:
            item = {
                **raw,
                "id": raw.get("id") or slugify(raw.get("name") or raw.get("topic")),
                "name": clamp_text(raw.get("name") or raw.get("topic") or "Watchlist", 180),
                "industry": clamp_text(raw.get("industry"), 120),
                "demo": clamp_text(raw.get("demo"), 180),
                "topic": clamp_text(raw.get("topic"), 180),
                "region": clamp_text(raw.get("region") or "US", 80),
                "platforms": [clamp_text(item, 40) for item in raw.get("platforms", []) if clamp_text(item, 40)],
                "freshnessDays": int(raw.get("freshnessDays") or 30),
                "scheduleHours": max(1, int(raw.get("scheduleHours") or DEFAULT_SCAN_INTERVAL_HOURS)),
            }
            normalized.append(item)
            conn.execute(
                "INSERT OR REPLACE INTO watchlists (id, updated_at, payload) VALUES (?, ?, ?)",
                (item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
            )
        sync_scan_schedules(conn)
        conn.commit()
    write_json(TREND_WATCHLIST_FILE, {"updatedAt": utc_now(), "watchlists": normalized})
    return normalized


def scheduler_enabled():
    return os.environ.get("VIDEO_OS_SCHEDULED_SCANS", "1") != "0"


def normalize_schedule(watchlist, existing=None):
    existing = existing or {}
    interval = max(1, int(watchlist.get("scheduleHours") or existing.get("intervalHours") or DEFAULT_SCAN_INTERVAL_HOURS))
    next_run_at = existing.get("nextRunAt") or future_utc(interval)
    return {
        "id": watchlist.get("id") or slugify(watchlist.get("name") or watchlist.get("topic")),
        "watchlistId": watchlist.get("id") or slugify(watchlist.get("name") or watchlist.get("topic")),
        "watchlistName": watchlist.get("name") or watchlist.get("topic") or "Watchlist",
        "enabled": bool(existing.get("enabled", True)),
        "intervalHours": interval,
        "nextRunAt": next_run_at,
        "lastQueuedAt": existing.get("lastQueuedAt"),
        "lastJobId": existing.get("lastJobId"),
    }


def sync_scan_schedules(conn):
    rows = conn.execute("SELECT watchlist_id, payload FROM scan_schedules").fetchall()
    existing = {row["watchlist_id"]: json.loads(row["payload"]) for row in rows}
    watch_rows = conn.execute("SELECT payload FROM watchlists ORDER BY id").fetchall()
    active_ids = set()
    for row in watch_rows:
        watchlist = json.loads(row["payload"])
        watchlist_id = watchlist.get("id") or slugify(watchlist.get("name") or watchlist.get("topic"))
        active_ids.add(watchlist_id)
        schedule = normalize_schedule(watchlist, existing.get(watchlist_id))
        conn.execute(
            """
            INSERT OR REPLACE INTO scan_schedules
            (id, watchlist_id, enabled, interval_hours, next_run_at, last_queued_at, last_job_id, updated_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                schedule["id"],
                schedule["watchlistId"],
                1 if schedule["enabled"] else 0,
                schedule["intervalHours"],
                schedule["nextRunAt"],
                schedule.get("lastQueuedAt"),
                schedule.get("lastJobId"),
                utc_now(),
                json.dumps(schedule, ensure_ascii=False),
            ),
        )
    for watchlist_id, raw in existing.items():
        if watchlist_id not in active_ids and raw.get("enabled"):
            raw["enabled"] = False
            conn.execute(
                """
                UPDATE scan_schedules
                SET enabled = 0, updated_at = ?, payload = ?
                WHERE watchlist_id = ?
                """,
                (utc_now(), json.dumps(raw, ensure_ascii=False), watchlist_id),
            )


def load_scan_schedules():
    db_ready()
    with IO_LOCK, db_connect() as conn:
        sync_scan_schedules(conn)
        conn.commit()
        rows = conn.execute("SELECT payload FROM scan_schedules ORDER BY watchlist_id").fetchall()
    return [json.loads(row["payload"]) for row in rows]


def scheduled_job_pending(schedule_id):
    for job in list_jobs():
        payload = job.get("payload") or {}
        if (
            job.get("type") == "trend_discovery"
            and job.get("status") in {"queued", "running"}
            and payload.get("scheduleId") == schedule_id
        ):
            return job
    return None


def queue_due_scheduled_scans(force=False):
    db_ready()
    if not scheduler_enabled() and not force:
        return {"enabled": False, "queued": [], "skipped": ["scheduler disabled"]}
    now = datetime.now(timezone.utc)
    watchlists = {item.get("id"): item for item in load_watchlists()}
    queued = []
    skipped = []
    schedules = load_scan_schedules()
    for schedule in schedules:
        if not schedule.get("enabled"):
            skipped.append(f"{schedule.get('watchlistId')}: disabled")
            continue
        due_at = parse_utc(schedule.get("nextRunAt"))
        if not force and due_at and due_at > now:
            continue
        pending = scheduled_job_pending(schedule["id"])
        if pending:
            skipped.append(f"{schedule.get('watchlistId')}: pending {pending.get('id')}")
            continue
        watchlist = watchlists.get(schedule.get("watchlistId"))
        if not watchlist:
            skipped.append(f"{schedule.get('watchlistId')}: missing watchlist")
            continue
        payload = {
            "industry": watchlist.get("industry"),
            "demo": watchlist.get("demo"),
            "topic": watchlist.get("topic"),
            "region": watchlist.get("region") or "US",
            "platforms": watchlist.get("platforms") or ["reddit", "youtube"],
            "freshnessDays": int(watchlist.get("freshnessDays") or 30),
            "scheduled": True,
            "scheduleId": schedule["id"],
            "watchlistId": schedule.get("watchlistId"),
            "watchlistName": watchlist.get("name"),
        }
        job = create_job("trend_discovery", None, payload)
        next_run_at = future_utc(schedule.get("intervalHours") or DEFAULT_SCAN_INTERVAL_HOURS)
        schedule.update({"lastQueuedAt": utc_now(), "lastJobId": job["id"], "nextRunAt": next_run_at})
        with IO_LOCK, db_connect() as conn:
            conn.execute(
                """
                UPDATE scan_schedules
                SET next_run_at = ?, last_queued_at = ?, last_job_id = ?, updated_at = ?, payload = ?
                WHERE id = ?
                """,
                (
                    schedule["nextRunAt"],
                    schedule["lastQueuedAt"],
                    schedule["lastJobId"],
                    utc_now(),
                    json.dumps(schedule, ensure_ascii=False),
                    schedule["id"],
                ),
            )
            conn.commit()
        queued.append(job)
    if queued:
        publish_public_snapshot()
    return {"enabled": scheduler_enabled(), "queued": queued, "skipped": skipped}


def scheduler_status():
    schedules = load_scan_schedules()
    now = datetime.now(timezone.utc)
    due = [
        item for item in schedules
        if item.get("enabled") and (parse_utc(item.get("nextRunAt")) or now) <= now
    ]
    return {
        "status": "active" if scheduler_enabled() else "disabled",
        "detail": "Scheduled watchlist scans are queued by the local server." if scheduler_enabled() else "Set VIDEO_OS_SCHEDULED_SCANS=1 to enable recurring scans.",
        "scheduleCount": len(schedules),
        "enabledCount": len([item for item in schedules if item.get("enabled")]),
        "dueCount": len(due),
        "defaultIntervalHours": DEFAULT_SCAN_INTERVAL_HOURS,
        "schedules": schedules,
    }


def load_scan_recipes():
    db_ready()
    with db_connect() as conn:
        rows = conn.execute("SELECT payload FROM scan_recipes ORDER BY id").fetchall()
    recipes = [json.loads(row["payload"]) for row in rows]
    if not recipes:
        save_scan_recipes(DEFAULT_SCAN_RECIPES)
        return DEFAULT_SCAN_RECIPES
    return recipes


def save_scan_recipes(recipes):
    db_ready()
    normalized = []
    with IO_LOCK, db_connect() as conn:
        conn.execute("DELETE FROM scan_recipes")
        for raw in recipes:
            item = {
                **raw,
                "id": raw.get("id") or slugify(raw.get("name") or raw.get("topic")),
                "name": clamp_text(raw.get("name") or raw.get("topic") or "Scan Recipe", 180),
                "industry": clamp_text(raw.get("industry"), 120),
                "demo": clamp_text(raw.get("demo"), 180),
                "topic": clamp_text(raw.get("topic"), 180),
                "region": clamp_text(raw.get("region") or "US", 80),
                "platforms": [clamp_text(item, 40) for item in raw.get("platforms", []) if clamp_text(item, 40)],
                "freshnessDays": int(raw.get("freshnessDays") or 30),
            }
            normalized.append(item)
            conn.execute(
                "INSERT OR REPLACE INTO scan_recipes (id, updated_at, payload) VALUES (?, ?, ?)",
                (item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
            )
        conn.commit()
    return normalized


def load_discover_options():
    db_ready()
    result = {
        "industries": [],
        "audiences": [],
        "topics": [],
        "regions": [],
        "platforms": [],
        "limits": DISCOVER_OPTIONS["limits"],
        "scanRecipes": load_scan_recipes(),
    }
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT category, payload FROM discover_options ORDER BY category, id"
        ).fetchall()
    for row in rows:
        category = row["category"]
        if category in result:
            result[category].append(json.loads(row["payload"]))
    for category in ("industries", "audiences", "topics", "regions", "platforms"):
        if not result[category]:
            result[category] = DISCOVER_OPTIONS[category]
    return result


def update_discover_config(payload):
    if not isinstance(payload, dict):
        raise VideoOsError("Discover config payload must be an object.")
    db_ready()
    allowed = {"industries", "audiences", "topics", "regions", "platforms"}
    with IO_LOCK, db_connect() as conn:
        for category in allowed:
            if category not in payload:
                continue
            if not isinstance(payload[category], list):
                raise VideoOsError(f"{category} must be a list.")
            conn.execute("DELETE FROM discover_options WHERE category = ?", (category,))
            for raw in payload[category]:
                if not isinstance(raw, dict):
                    continue
                item = {**raw}
                item["id"] = clamp_text(item.get("id") or slugify(item.get("label") or item.get("value")), 120)
                item["label"] = clamp_text(item.get("label") or item.get("value") or item["id"], 180)
                if category != "platforms":
                    item["value"] = clamp_text(item.get("value") or item["label"], 240)
                else:
                    item["available"] = bool(item.get("available"))
                    item["note"] = clamp_text(item.get("note"), 500)
                conn.execute(
                    "INSERT OR REPLACE INTO discover_options (category, id, updated_at, payload) VALUES (?, ?, ?, ?)",
                    (category, item["id"], utc_now(), json.dumps(item, ensure_ascii=False)),
                )
        conn.commit()
    if "watchlists" in payload:
        save_watchlists(payload.get("watchlists") or [])
    if "scanRecipes" in payload:
        save_scan_recipes(payload.get("scanRecipes") or [])
    return {
        **load_discover_options(),
        "watchlists": load_watchlists(),
        "scanSchedules": load_scan_schedules(),
    }


def load_trend_opportunities():
    db_ready()
    with db_connect() as conn:
        rows = conn.execute("SELECT payload FROM trend_opportunities ORDER BY score DESC, updated_at DESC").fetchall()
    return [enrich_opportunity(json.loads(row["payload"])) for row in rows]


def save_trend_opportunities(opportunities):
    db_ready()
    with IO_LOCK, db_connect() as conn:
        for raw in opportunities:
            item = enrich_opportunity(raw)
            conn.execute(
                "INSERT OR REPLACE INTO trend_opportunities (id, score, status, updated_at, payload) VALUES (?, ?, ?, ?, ?)",
                (
                    item["id"],
                    float(item.get("videoOpportunityScore") or 0),
                    item.get("status") or "candidate",
                    item.get("updatedAt") or utc_now(),
                    json.dumps(item, ensure_ascii=False),
                ),
            )
        conn.commit()
    write_json(TREND_OPPORTUNITIES_FILE, {
        "updatedAt": utc_now(),
        "opportunities": opportunities,
    })


def trend_stats(opportunities=None):
    opportunities = opportunities if opportunities is not None else load_trend_opportunities()
    active = [item for item in opportunities if item.get("status") != "dismissed"]
    scores = [float(item.get("videoOpportunityScore") or 0) for item in active]
    pounce = [item for item in active if item.get("launchRecommendation") == "Pounce Now"]
    decisions = {}
    for item in active:
        key = item.get("launchRecommendation") or item.get("narrative", {}).get("decision") or "Watch"
        decisions[key] = decisions.get(key, 0) + 1
    return {
        "opportunities": len(active),
        "highScore": round(max(scores), 1) if scores else 0,
        "pounceNow": len(pounce),
        "topDecision": active[0].get("launchRecommendation") if active else None,
        "decisionMix": decisions,
        "watchlists": len(load_watchlists()),
        "lastRunAt": read_json(TREND_SOURCE_HEALTH_FILE, {}).get("lastRunAt"),
    }


def narrative_summary(opportunities=None):
    opportunities = opportunities if opportunities is not None else load_trend_opportunities()
    active = [item for item in opportunities if item.get("status") != "dismissed"]
    if not active:
        return {
            "headline": "No live narrative signal yet.",
            "recommendation": "Run Scan",
            "whyNow": "Run a trend scan to identify narrative movement.",
            "platformMove": "No platform strategy available.",
            "decay": "unknown",
        }
    top = active[0]
    narrative = top.get("narrative") or {}
    platform = narrative.get("platformStrategy") or {}
    decay = narrative.get("decay") or {}
    return {
        "headline": top.get("title"),
        "score": top.get("videoOpportunityScore"),
        "recommendation": top.get("launchRecommendation") or narrative.get("decision"),
        "whyNow": narrative.get("whyNow") or top.get("recommendedAngle"),
        "platformMove": platform.get("move"),
        "primaryPlatform": platform.get("primary"),
        "decay": decay.get("stage"),
        "window": decay.get("window"),
    }


def worker_health():
    queued = job_counts().get("queued", 0)
    heartbeat = read_json(WORKER_HEARTBEAT_FILE, {})
    last_seen = heartbeat.get("lastSeenAt")
    recent = False
    if last_seen:
        try:
            then = datetime.fromisoformat(last_seen)
            recent = (datetime.now(timezone.utc) - then).total_seconds() < 45
        except ValueError:
            recent = False
    if recent:
        return {
            "status": "online",
            "lastSeenAt": last_seen,
            "detail": heartbeat.get("detail") or "Worker heartbeat is recent.",
        }
    return {
        "status": "offline",
        "lastSeenAt": last_seen,
        "detail": f"{queued} queued job(s). Start scripts/video_os_worker.py or run one job manually.",
    }


def last30days_health():
    path = LAST30DAYS_SCRIPT
    if path.exists():
        return {
            "status": "ready",
            "path": str(path),
            "detail": f"Configured adapter found at {path}.",
        }
    return {
        "status": "missing",
        "path": str(path),
        "detail": "Set LAST30DAYS_SCRIPT_PATH to the local last30days.py script before running trend scans.",
    }


def normalize_talent_item(item, fallback_prefix):
    item = item if isinstance(item, dict) else {}
    source = clamp_text(item.get("source") or "heygen", 80)
    raw_style = item.get("style")
    safe_local_sources = {"local", "local-fallback", "seed", "featured"}
    safe_style = clamp_text(raw_style or "available", 120) if source.lower() in safe_local_sources and raw_style else "available"
    return {
        "id": clamp_text(item.get("id") or item.get("avatar_id") or item.get("voice_id") or item.get("avatarId") or item.get("voiceId") or f"{fallback_prefix}-{uuid4().hex[:8]}", 160),
        "name": clamp_text(
            item.get("name")
            or item.get("avatar_name")
            or item.get("voice_name")
            or item.get("display_name")
            or item.get("displayName")
            or item.get("id")
            or item.get("avatar_id")
            or item.get("voice_id")
            or "Unnamed",
            180,
        ),
        "source": source,
        # Provider inventory must not persist raw gender/language/style labels from upstream catalogs.
        "style": safe_style,
    }


def unique_talent_items(items):
    seen = set()
    result = []
    for item in items:
        item_id = item.get("id")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        result.append(item)
    return result


def merge_pinned_private_avatars(avatars):
    by_id = {item.get("id"): item for item in avatars if item.get("id")}
    for pinned in PINNED_PRIVATE_HEYGEN_AVATARS:
        existing = by_id.get(pinned["id"], {})
        by_id[pinned["id"]] = {**existing, **pinned}
    ordered = []
    for pinned in PINNED_PRIVATE_HEYGEN_AVATARS:
        ordered.append(by_id.pop(pinned["id"]))
    ordered.extend(by_id.values())
    return ordered


def fetch_heygen_collection(url):
    key = heygen_api_key()
    if not url or not key:
        return []
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "X-Api-Key": key, "x-api-key": key},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data", payload)
    if isinstance(data, dict):
        for key_name in ("avatars", "voices", "items", "list"):
            if isinstance(data.get(key_name), list):
                return data[key_name]
    if isinstance(data, list):
        return data
    return []


def talent_connection_status(inventory=None):
    inventory = inventory or read_json(TALENT_INVENTORY_FILE, {**DEFAULT_TALENT_INVENTORY, "source": "local-fallback"})
    avatar_count = len([item for item in inventory.get("avatars", []) if item.get("source") == "heygen"])
    voice_count = len([item for item in inventory.get("voices", []) if item.get("source") == "heygen"])
    private_avatar_count = len([item for item in inventory.get("avatars", []) if item.get("visibility") == "private"])
    missing = []
    if not heygen_api_key():
        missing.append("HEYGEN_API_KEY or HEYGEN_TOKEN")
    connected = inventory.get("source") == "heygen" and avatar_count > 0 and voice_count > 0
    return {
        "status": "connected" if connected else "fallback",
        "source": inventory.get("source") or "local-fallback",
        "avatarCount": avatar_count,
        "privateAvatarCount": private_avatar_count,
        "voiceCount": voice_count,
        "updatedAt": inventory.get("updatedAt"),
        "missing": missing,
        "keyFileConfigured": bool(heygen_api_key()),
        "keySource": "VIDEO HELPER/HeyGen.txt" if HEYGEN_KEY_FILE.exists() else "environment",
        "avatarsUrl": HEYGEN_AVATARS_URL,
        "voicesUrl": HEYGEN_VOICES_URL,
        "lastSyncError": inventory.get("lastSyncError"),
        "detail": (
            f"Connected to HeyGen inventory with {avatar_count} avatar(s) and {voice_count} voice(s)."
            if connected
            else "Using local fallback avatar/voice presets. Configure HeyGen talent sync before live render."
        ),
    }


def load_talent_inventory(refresh=False):
    ensure_dirs()
    inventory = read_json(TALENT_INVENTORY_FILE, {**DEFAULT_TALENT_INVENTORY, "source": "local-fallback"})
    inventory["avatars"] = unique_talent_items(
        [normalize_talent_item(item, "avatar") for item in inventory.get("avatars", [])]
    )
    inventory["voices"] = unique_talent_items(
        [normalize_talent_item(item, "voice") for item in inventory.get("voices", [])]
    )
    should_refresh = refresh or os.environ.get("HEYGEN_SYNC_TALENT") == "1"
    if should_refresh:
        try:
            missing = []
            if not heygen_api_key():
                missing.append("HEYGEN_API_KEY or HEYGEN_TOKEN")
            if missing:
                raise VideoOsError(f"HeyGen talent sync is not configured. Missing: {', '.join(missing)}")
            avatars = fetch_heygen_collection(HEYGEN_AVATARS_URL)
            voices = fetch_heygen_collection(HEYGEN_VOICES_URL)
            if avatars or voices:
                inventory = {
                    "source": "heygen",
                    "updatedAt": utc_now(),
                    "avatars": merge_pinned_private_avatars(unique_talent_items([normalize_talent_item(item, "avatar") for item in avatars]) or inventory.get("avatars", DEFAULT_TALENT_INVENTORY["avatars"])),
                    "voices": unique_talent_items([normalize_talent_item(item, "voice") for item in voices]) or inventory.get("voices", DEFAULT_TALENT_INVENTORY["voices"]),
                }
                write_json(TALENT_INVENTORY_FILE, inventory)
            else:
                raise VideoOsError("HeyGen talent sync returned no avatars or voices.")
        except Exception as exc:
            inventory["source"] = inventory.get("source") or "local-fallback"
            inventory["lastSyncError"] = str(exc)
            inventory["updatedAt"] = utc_now()
            write_json(TALENT_INVENTORY_FILE, inventory)
    if not inventory.get("avatars"):
        inventory["avatars"] = DEFAULT_TALENT_INVENTORY["avatars"]
    if not inventory.get("voices"):
        inventory["voices"] = DEFAULT_TALENT_INVENTORY["voices"]
    inventory["avatars"] = merge_pinned_private_avatars(inventory.get("avatars", []))
    inventory.setdefault("updatedAt", utc_now())
    inventory.setdefault("source", "local-fallback")
    write_json(TALENT_INVENTORY_FILE, inventory)
    return inventory


def validate_heygen_talent(project):
    inventory = load_talent_inventory()
    avatars = {item.get("id"): item for item in inventory.get("avatars", [])}
    voices = {item.get("id"): item for item in inventory.get("voices", [])}
    avatar = project.get("avatar") or {}
    voice = project.get("voice") or {}
    avatar_id = avatar.get("avatarId")
    voice_id = voice.get("voiceId")
    matched_avatar = avatars.get(avatar_id)
    matched_voice = voices.get(voice_id)
    problems = []
    if inventory.get("source") != "heygen":
        problems.append("talent inventory is local fallback, not HeyGen")
    if not matched_avatar or matched_avatar.get("source") != "heygen":
        problems.append(f"avatar is not a synced HeyGen avatar: {avatar_id or 'missing'}")
    if not matched_voice or matched_voice.get("source") != "heygen":
        problems.append(f"voice is not a synced HeyGen voice: {voice_id or 'missing'}")
    if problems:
        raise VideoOsError(
            "Live HeyGen submission blocked: "
            + "; ".join(problems)
            + ". Refresh HeyGen Talent after configuring HEYGEN_API_KEY or HEYGEN_TOKEN."
        )


def record_worker_heartbeat(detail="Worker active."):
    ensure_dirs()
    write_json(WORKER_HEARTBEAT_FILE, {
        "lastSeenAt": utc_now(),
        "detail": detail,
    })


def publish_public_snapshot(store=None):
    ensure_dirs()
    store = store or load_store()
    foundation = public_foundation()
    public_projects = []
    for project in store.get("projects", []):
        public_projects.append({
            key: project.get(key)
            for key in [
                "id",
                "name",
                "template",
                "scriptMode",
                "status",
                "owner",
                "audience",
                "goal",
                "topic",
                "tone",
                "aesthetic",
                "avatar",
                "voice",
                "provider",
                "providerJobId",
                "sessionId",
                "durationSeconds",
                "qualityScore",
                "reviewState",
                "cost",
                "telemetry",
                "versions",
                "feedbackCount",
                "nextActions",
                "createdAt",
                "updatedAt",
            ]
            if key in project
        })
    opportunities = load_trend_opportunities()
    foundation.update({
        "generatedAt": utc_now(),
        "persistence": {
            "mode": "sqlite",
            "privateRoot": str(PRIVATE_ROOT),
            "database": str(SQLITE_FILE),
            "jobCounts": job_counts(),
            "liveHeyGenRequires": "HEYGEN_API_KEY plus allowLive=true",
        },
        "systemHealth": {
            "worker": worker_health(),
            "last30days": last30days_health(),
            "scheduler": scheduler_status(),
        },
        "discoverOptions": {**load_discover_options(), "watchlists": load_watchlists(), "scanSchedules": load_scan_schedules()},
        "projects": public_projects,
        "trends": {
            "stats": trend_stats(opportunities),
            "narrativeSummary": narrative_summary(opportunities),
            "watchlists": load_watchlists(),
            "opportunities": [
                {
                    key: item.get(key)
                    for key in [
                        "id",
                        "title",
                        "industry",
                        "demo",
                        "topic",
                        "platform",
                        "region",
                        "freshnessDays",
                        "videoOpportunityScore",
                        "velocity",
                        "evidenceStrength",
                        "brandSafety",
                        "launchRecommendation",
                        "narrative",
                        "recommendedAngle",
                        "audienceFit",
                        "status",
                        "createdAt",
                        "updatedAt",
                        "evidence",
                        "nextActions",
                    ]
                    if key in item
                }
                for item in opportunities[:18]
            ],
        },
    })
    write_json(PUBLIC_VIDEO_OS, foundation)
    write_json(HOSTED_VIDEO_OS, foundation)
    return foundation


def create_project(payload):
    if not isinstance(payload, dict):
        raise VideoOsError("Project payload must be a JSON object.")
    name = clamp_text(payload.get("name") or payload.get("title") or payload.get("topic"), 160)
    if len(name) < 3:
        raise VideoOsError("Project name is required.")
    audience = clamp_text(payload.get("audience"), 500)
    goal = clamp_text(payload.get("goal"), 800)
    if len(audience) < 3 or len(goal) < 8:
        raise VideoOsError("Audience and goal are required.")

    store = load_store()
    base_id = slugify(payload.get("id") or name)
    project_id = base_id
    existing = {project["id"] for project in store.get("projects", [])}
    counter = 2
    while project_id in existing:
        project_id = f"{base_id}-{counter}"
        counter += 1

    project = normalize_project({
        **payload,
        "id": project_id,
        "name": name,
        "audience": audience,
        "goal": goal,
        "status": "draft",
        "reviewState": "brief_required",
    })
    store.setdefault("projects", []).insert(0, project)
    save_store(store)
    return project


def update_project(project_id, patch):
    store = load_store()
    project = find_project(store, project_id)
    if not project:
        raise VideoOsError(f"Project not found: {project_id}")
    protected = {"id", "createdAt"}
    for key, value in (patch or {}).items():
        if key in protected:
            continue
        if key in {"name", "audience", "goal", "topic", "tone", "aesthetic", "scriptInput", "sourceNotes", "scriptMode"}:
            project[key] = clamp_text(value)
        elif key in {"avatar", "voice"} and isinstance(value, dict):
            project[key] = value
        elif key == "status":
            if value not in STATE_MACHINE:
                raise VideoOsError(f"Invalid state: {value}")
            project[key] = value
        else:
            project[key] = value
    if len(clamp_text(project.get("audience"), 500)) < 3 or len(clamp_text(project.get("goal"), 800)) < 8:
        raise VideoOsError("Audience and goal are required.")
    project["updatedAt"] = utc_now()
    save_store(store)
    return project


def add_feedback(project_id, payload):
    store = load_store()
    project = find_project(store, project_id)
    if not project:
        raise VideoOsError(f"Project not found: {project_id}")
    item = {
        "id": f"feedback-{uuid4().hex[:12]}",
        "projectId": project_id,
        "createdAt": utc_now(),
        "reviewer": clamp_text(payload.get("reviewer") or "anonymous", 120),
        "persona": clamp_text(payload.get("persona") or "viewer", 80),
        "rating": payload.get("rating"),
        "clarityIssue": clamp_text(payload.get("clarityIssue"), 1200),
        "usefulness": clamp_text(payload.get("usefulness"), 1200),
        "requestedChange": clamp_text(payload.get("requestedChange"), 1200),
        "nextVideo": clamp_text(payload.get("nextVideo"), 1200),
    }
    ensure_dirs()
    with FEEDBACK_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False) + "\n")
    project["feedbackCount"] = int(project.get("feedbackCount") or 0) + 1
    project["updatedAt"] = utc_now()
    if project["status"] == "rendered":
        project["status"] = "qc_required"
    save_store(store)
    return item


def create_job(job_type, project_id, payload=None):
    if job_type not in JOB_TYPES:
        raise VideoOsError(f"Unsupported job type: {job_type}")
    store = load_store()
    project = find_project(store, project_id) if project_id else None
    if job_type not in TREND_JOB_TYPES and not project:
        raise VideoOsError(f"Project not found: {project_id}")
    if job_type == "heygen_submit":
        scripts = (project.get("versions", {}).get("scripts") or []) if project else []
        if project.get("status") != "approved":
            raise VideoOsError("Approve script and scene plan before HeyGen submission.")
        if not scripts and not project.get("scriptInput"):
            raise VideoOsError("Generate or paste a script before HeyGen submission.")
    if job_type == "heygen_poll" and project and not project.get("providerJobId"):
        raise VideoOsError("Cannot poll HeyGen without a provider job id.")
    if job_type == "post_production_handoff" and project and project.get("status") not in {"rendered", "qc_required"}:
        raise VideoOsError("Post-production handoff requires a rendered or QC-ready video.")
    if job_type == "trend_to_video_project":
        trend_id = (payload or {}).get("trendId")
        existing = next((item for item in load_trend_opportunities() if item.get("id") == trend_id), None)
        if existing and existing.get("convertedProjectId"):
            raise VideoOsError(f"Trend already converted to project: {existing.get('convertedProjectId')}")
    job = {
        "id": f"job-{int(time.time())}-{uuid4().hex[:8]}",
        "type": job_type,
        "projectId": project_id,
        "status": "queued",
        "payload": payload or {},
        "attempts": 0,
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "result": None,
        "error": None,
    }
    save_job(job)
    if job_type == "trend_discovery":
        pass
    elif job_type == "trend_scoring":
        pass
    elif job_type == "trend_to_video_project":
        pass
    elif job_type == "script_generation":
        project["status"] = "research_queued"
        project["reviewState"] = "brief_ready"
    elif job_type == "heygen_submit":
        project["status"] = "render_queued"
        project["reviewState"] = "render_gate"
    elif job_type == "heygen_poll":
        project["status"] = "rendering"
    elif job_type == "post_production_handoff":
        project["reviewState"] = "post_production"
    if project:
        project["updatedAt"] = utc_now()
        save_store(store)
    else:
        publish_public_snapshot(store=store)
    return job


def list_jobs(status=None):
    db_ready()
    with db_connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT payload FROM jobs WHERE status = ? ORDER BY created_at",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT payload FROM jobs ORDER BY created_at").fetchall()
    jobs = [json.loads(row["payload"]) for row in rows]
    return sorted(jobs, key=lambda item: item.get("createdAt") or "")


def save_job(job):
    job["updatedAt"] = utc_now()
    db_ready()
    with IO_LOCK, db_connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO jobs (id, type, project_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                job["id"],
                job.get("type") or "",
                job.get("projectId"),
                job.get("status") or "queued",
                job.get("createdAt") or utc_now(),
                job["updatedAt"],
                json.dumps(job, ensure_ascii=False),
            ),
        )
        conn.commit()
    write_json(JOBS_DIR / f"{job['id']}.json", job)


def next_queued_job():
    db_ready()
    with IO_LOCK, db_connect() as conn:
        row = conn.execute(
            "SELECT id, payload FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if not row:
            return None
        job = json.loads(row["payload"])
        job["status"] = "running"
        job["attempts"] = int(job.get("attempts") or 0) + 1
        job["leasedAt"] = utc_now()
        job["updatedAt"] = utc_now()
        conn.execute(
            "UPDATE jobs SET status = 'running', updated_at = ?, payload = ? WHERE id = ? AND status = 'queued'",
            (job["updatedAt"], json.dumps(job, ensure_ascii=False), row["id"]),
        )
        conn.commit()
    write_json(JOBS_DIR / f"{job['id']}.json", job)
    return job


def append_version(project, kind, payload):
    versions = project.setdefault("versions", {"scripts": [], "sceneManifests": [], "renders": [], "postProduction": []})
    bucket = {
        "script": "scripts",
        "scene": "sceneManifests",
        "render": "renders",
        "post": "postProduction",
    }[kind]
    versions.setdefault(bucket, []).append(payload)


def run_last30days(topic, platforms=None, lookback_days=30):
    if not LAST30DAYS_SCRIPT.exists():
        raise VideoOsError(f"last30days script not found: {LAST30DAYS_SCRIPT}. Set LAST30DAYS_SCRIPT_PATH to override.")
    command = [
        os.environ.get("LAST30DAYS_PYTHON") or "python",
        str(LAST30DAYS_SCRIPT),
        topic,
        "--emit=json",
        "--quick",
        "--lookback-days",
        str(int(lookback_days or 30)),
    ]
    if platforms:
        command.extend(["--search", ",".join(platforms)])
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run(
        command,
        cwd=str(LAST30DAYS_SCRIPT.parents[2]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=int(os.environ.get("LAST30DAYS_TIMEOUT_SECONDS", "300")),
        check=False,
    )
    if result.returncode != 0:
        raise VideoOsError(f"last30days failed: {result.stderr[-900:] or result.stdout[-900:]}")
    return json.loads(result.stdout.lstrip())


def score_opportunity(seed, cluster, source_counts):
    raw_score = float(cluster.get("score") or 0)
    source_count = len(cluster.get("sources") or [])
    evidence_count = len(cluster.get("representative_ids") or cluster.get("candidate_ids") or [])
    base = min(100, raw_score)
    source_bonus = min(12, source_count * 4)
    proof_bonus = min(10, evidence_count * 2)
    audience_bonus = 8 if seed.get("demo") else 0
    return round(min(99, base + source_bonus + proof_bonus + audience_bonus), 1)


def narrative_recommendation(score, brand_safety):
    if brand_safety == "review":
        return "Human Review"
    if score >= 78:
        return "Pounce Now"
    if score >= 62:
        return "Prepare Brief"
    if score >= 45:
        return "Watch"
    return "Nurture"


def narrative_decay(score, freshness_days):
    if score >= 78 and freshness_days <= 14:
        return {"stage": "accelerating", "window": "24-48 hours", "urgency": "high"}
    if score >= 70:
        return {"stage": "fresh", "window": "48-72 hours", "urgency": "high"}
    if score >= 55:
        return {"stage": "forming", "window": "3-5 days", "urgency": "medium"}
    if score >= 40:
        return {"stage": "monitor", "window": "1-2 weeks", "urgency": "low"}
    return {"stage": "weak signal", "window": "nurture only", "urgency": "low"}


def narrative_dimensions(seed, title, score, evidence_count, source_count, brand_safety):
    saturation = "low" if evidence_count <= 2 else "moderate" if evidence_count <= 5 else "rising"
    return {
        "trafficPotential": min(99, round(score + min(10, source_count * 2), 1)),
        "buyerIntent": 82 if re.search(r"\b(best|tool|recommend|how|service|dashboard|cost|free|need)\b", title, re.I) else 64,
        "narrativeVelocity": min(99, round(score + min(12, evidence_count * 2), 1)),
        "contentSaturation": saturation,
        "brandFit": 88 if seed.get("demo") else 72,
        "productionDifficulty": "low" if score >= 70 else "medium",
        "risk": 38 if brand_safety == "review" else 12,
        "shelfLife": "short" if score >= 75 else "medium" if score >= 50 else "long-tail",
    }


def angle_recommendations(seed, title):
    audience = seed.get("demo") or "the target audience"
    industry = seed.get("industry") or "market"
    return [
        {
            "type": "Pain Spike",
            "hook": clamp_text(f"Why {audience} are suddenly asking: {title}", 180),
            "format": "90-second explainer",
        },
        {
            "type": "Executive Decode",
            "hook": clamp_text(f"What this {industry} signal means before the market gets crowded", 180),
            "format": "executive briefing",
        },
        {
            "type": "Contrarian",
            "hook": clamp_text(f"The wrong way to react to this trend, and the smarter LUX play", 180),
            "format": "short-form opinion clip",
        },
        {
            "type": "Sales Enablement",
            "hook": clamp_text(f"How reps and managers should turn this market question into a better conversation", 180),
            "format": "rep + manager coaching video",
        },
    ]


def platform_strategy(platform):
    platforms = [part.strip().lower() for part in str(platform or "").split(",") if part.strip()]
    primary = platforms[0] if platforms else "mixed"
    playbook = {
        "reddit": ("validate the pain language", "direct, specific, no polish-first claims"),
        "youtube": ("package as a searchable explainer", "clear hook, chapters, proof-heavy visuals"),
        "tiktok": ("compress into a fast pattern interrupt", "plain-language hook, rapid cutaways"),
        "instagram": ("turn into visual carousel/reel logic", "bold captions, proof snippets"),
        "linkedin": ("frame as executive market intelligence", "authority, restraint, business outcome"),
        "hackernews": ("lead with technical credibility", "specific evidence, low hype"),
    }
    move, tone = playbook.get(primary, ("turn the strongest question into a platform-native video", "clear, useful, evidence-led"))
    return {
        "primary": primary,
        "move": move,
        "tone": tone,
        "recommendedFormats": ["short clip", "90-sec explainer"] if primary in {"tiktok", "instagram"} else ["executive briefing", "search explainer"],
    }


def enrich_opportunity(item):
    score = float(item.get("videoOpportunityScore") or 0)
    seed = {
        "industry": item.get("industry") or "market",
        "demo": item.get("demo") or "target audience",
        "freshnessDays": item.get("freshnessDays") or 30,
    }
    title = item.get("title") or item.get("topic") or "Trend opportunity"
    evidence_count = len(item.get("evidence") or [])
    source_count = len([part for part in str(item.get("platform") or "").split(",") if part.strip()])
    brand_safety = item.get("brandSafety") or "clear"
    item["launchRecommendation"] = item.get("launchRecommendation") or narrative_recommendation(score, brand_safety)
    narrative = item.setdefault("narrative", {})
    narrative.setdefault("core", title)
    narrative.setdefault("whyNow", clamp_text(
        f"The signal is active on {item.get('platform') or 'mixed platforms'}; LUX can answer before the angle gets crowded.",
        260,
    ))
    narrative.setdefault("decision", item["launchRecommendation"])
    narrative.setdefault("dimensions", narrative_dimensions(seed, title, score, evidence_count, source_count, brand_safety))
    narrative.setdefault("decay", narrative_decay(score, int(item.get("freshnessDays") or 30)))
    narrative.setdefault("competitiveGap", competitive_gap(seed, title))
    narrative.setdefault("angles", angle_recommendations(seed, title))
    narrative.setdefault("platformStrategy", platform_strategy(item.get("platform")))
    return item


def competitive_gap(seed, title):
    audience = seed.get("demo") or "the audience"
    return clamp_text(
        f"Demand is visible around '{title}', but the gap is a clear, trustworthy answer that translates the trend into action for {audience}.",
        320,
    )


def opportunity_from_cluster(seed, report, cluster, rank):
    sources = cluster.get("sources") or []
    platform = ", ".join(sources) if sources else "mixed"
    evidence_urls = cluster.get("representative_ids") or cluster.get("candidate_ids") or []
    source_counts = {key: len(value or []) for key, value in (report.get("items_by_source") or {}).items()}
    score = score_opportunity(seed, cluster, source_counts)
    title = clamp_text(cluster.get("title") or seed.get("topic") or "Trend opportunity", 180)
    freshness_days = int(seed.get("freshnessDays") or 30)
    evidence_count = len(evidence_urls)
    source_count = len(sources)
    brand_safety = "review" if re.search(r"\b(deepfake|disinformation|politic|war|violence)\b", title, re.I) else "clear"
    decision = narrative_recommendation(score, brand_safety)
    return {
        "id": slugify(f"{seed.get('industry')} {title}")[:90],
        "title": title,
        "industry": clamp_text(seed.get("industry") or "general", 120),
        "demo": clamp_text(seed.get("demo") or "market audience", 180),
        "topic": clamp_text(seed.get("topic") or title, 180),
        "platform": platform,
        "region": clamp_text(seed.get("region") or "US", 40),
        "freshnessDays": freshness_days,
        "videoOpportunityScore": score,
        "velocity": "high" if score >= 75 else "medium" if score >= 50 else "watch",
        "evidenceStrength": "strong" if len(evidence_urls) >= 2 or score >= 70 else "developing",
        "brandSafety": brand_safety,
        "launchRecommendation": decision,
        "narrative": {
            "core": clamp_text(title, 180),
            "whyNow": clamp_text(
                f"The signal is moving across {platform}; the current window favors a fast, evidence-led LUX response.",
                260,
            ),
            "decision": decision,
            "dimensions": narrative_dimensions(seed, title, score, evidence_count, source_count, brand_safety),
            "decay": narrative_decay(score, freshness_days),
            "competitiveGap": competitive_gap(seed, title),
            "angles": angle_recommendations(seed, title),
            "platformStrategy": platform_strategy(platform),
        },
        "recommendedAngle": clamp_text(
            f"Turn this into a timely {seed.get('industry') or 'market'} explainer for {seed.get('demo') or 'the target audience'}.",
            260,
        ),
        "audienceFit": "direct" if seed.get("demo") else "inferred",
        "status": "candidate",
        "rank": rank,
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "evidence": [
            {"source": platform, "url": clamp_text(url, 500)}
            for url in evidence_urls[:5]
        ],
        "nextActions": [
            "Review source evidence.",
            f"Confirm the {decision.lower()} recommendation.",
            "Select angle, platform, CTA, and proof points.",
            "Create a Video OS project from this trend.",
        ],
    }


def merge_opportunities(existing, incoming):
    by_id = {item["id"]: item for item in existing if item.get("id")}
    for item in incoming:
        current = by_id.get(item["id"], {})
        item["createdAt"] = current.get("createdAt") or item["createdAt"]
        item["status"] = current.get("status") or item["status"]
        by_id[item["id"]] = enrich_opportunity({**current, **item, "updatedAt": utc_now()})
    return sorted(by_id.values(), key=lambda item: item.get("videoOpportunityScore") or 0, reverse=True)


def process_trend_discovery(job, project=None):
    payload = job.get("payload") or {}
    seed = {
        "industry": clamp_text(payload.get("industry") or "AI video", 120),
        "demo": clamp_text(payload.get("demo") or "founders, marketers, sales leaders", 180),
        "topic": clamp_text(payload.get("topic") or "AI video tools and avatar production", 180),
        "region": clamp_text(payload.get("region") or "US", 40),
        "platforms": payload.get("platforms") or ["reddit", "youtube"],
        "freshnessDays": int(payload.get("freshnessDays") or 30),
    }
    run_id = f"trend-run-{int(time.time())}-{uuid4().hex[:8]}"
    report = run_last30days(seed["topic"], platforms=seed["platforms"], lookback_days=seed["freshnessDays"])
    clusters = report.get("clusters") or []
    opportunities = [
        opportunity_from_cluster(seed, report, cluster, rank + 1)
        for rank, cluster in enumerate(clusters[:8])
    ]
    run_dir = TREND_RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / "request.json", seed)
    write_json(run_dir / "last30days-report.json", report)
    write_json(run_dir / "opportunities.json", {"opportunities": opportunities})
    save_trend_opportunities(merge_opportunities(load_trend_opportunities(), opportunities))
    write_json(TREND_SOURCE_HEALTH_FILE, {
        "lastRunAt": utc_now(),
        "lastRunId": run_id,
        "adapter": "last30days",
        "topic": seed["topic"],
        "opportunityCount": len(opportunities),
    })
    return {"runId": run_id, "opportunityCount": len(opportunities), "artifactDir": str(run_dir)}


def process_trend_scoring(job, project=None):
    opportunities = load_trend_opportunities()
    for item in opportunities:
        evidence_bonus = min(10, len(item.get("evidence") or []) * 2)
        safety_penalty = 12 if item.get("brandSafety") == "review" else 0
        item["videoOpportunityScore"] = round(max(0, min(99, float(item.get("videoOpportunityScore") or 0) + evidence_bonus - safety_penalty)), 1)
        item["launchRecommendation"] = narrative_recommendation(item["videoOpportunityScore"], item.get("brandSafety"))
        narrative = item.setdefault("narrative", {})
        narrative["decision"] = item["launchRecommendation"]
        narrative["decay"] = narrative_decay(item["videoOpportunityScore"], int(item.get("freshnessDays") or 30))
        item["updatedAt"] = utc_now()
    save_trend_opportunities(sorted(opportunities, key=lambda item: item.get("videoOpportunityScore") or 0, reverse=True))
    return {"scored": len(opportunities)}


def process_trend_to_video_project(job, project=None):
    payload = job.get("payload") or {}
    trend_id = payload.get("trendId")
    opportunities = load_trend_opportunities()
    trend = next((item for item in opportunities if item.get("id") == trend_id), None)
    if not trend:
        raise VideoOsError(f"Trend opportunity not found: {trend_id}")
    if trend.get("convertedProjectId"):
        return {"projectId": trend["convertedProjectId"], "trendId": trend_id, "alreadyConverted": True}
    evidence = "\n".join([f"- {item.get('source')}: {item.get('url')}" for item in trend.get("evidence", [])])
    created = create_project({
        "template": payload.get("template") or "marketing-launch",
        "name": payload.get("name") or f"Trend Explainer - {trend.get('title')}",
        "audience": payload.get("audience") or trend.get("demo"),
        "topic": trend.get("topic"),
        "goal": payload.get("goal") or f"Capitalize on the current trend: {trend.get('title')}. Explain why it matters and what the audience should do next.",
        "tone": payload.get("tone") or "timely, intelligent, authoritative, useful",
        "aesthetic": payload.get("aesthetic") or "LUX command-center trend briefing with cinematic data overlays",
        "sourceNotes": "\n\n".join([
            f"Trend opportunity score: {trend.get('videoOpportunityScore')}",
            f"Launch recommendation: {trend.get('launchRecommendation') or trend.get('narrative', {}).get('decision')}",
            f"Recommended angle: {trend.get('recommendedAngle')}",
            f"Why now: {trend.get('narrative', {}).get('whyNow')}",
            f"Competitive gap: {trend.get('narrative', {}).get('competitiveGap')}",
            "Evidence:",
            evidence or "No evidence URLs captured.",
        ]),
        "trend": trend,
    })
    trend["status"] = "converted"
    trend["convertedProjectId"] = created["id"]
    trend["updatedAt"] = utc_now()
    save_trend_opportunities(opportunities)
    return {"projectId": created["id"], "trendId": trend_id}


def render_script(project):
    topic = project.get("topic") or project.get("name")
    audience = project.get("audience")
    goal = clamp_text(project.get("goal")) or "Create clarity for the viewer"
    tone = project.get("tone")
    source = project.get("scriptInput") or project.get("sourceNotes")
    script_mode = project.get("scriptMode") or "generate"
    intro = f"This video is for {audience}. The goal is to {goal[0].lower() + goal[1:]}."
    if script_mode == "paste_exact" and source:
        return {
            "id": f"script-{uuid4().hex[:10]}",
            "createdAt": utc_now(),
            "tone": tone,
            "mode": script_mode,
            "script": source,
        }
    if source:
        body = source
    else:
        body = (
            f"Open with the practical problem: {topic}. Explain what changes for the viewer, show the workflow in plain language, "
            "then translate the data into action. Keep the tone direct, premium, and useful."
        )
    return {
        "id": f"script-{uuid4().hex[:10]}",
        "createdAt": utc_now(),
        "tone": tone,
        "mode": script_mode,
        "script": "\n\n".join([
            "Scene 1 - Set the expectation.",
            intro,
            "Scene 2 - Show the system.",
            body,
            "Scene 3 - Explain how to use it.",
            "For reps, focus on what the email means and what action to take next. For managers, focus on patterns, coaching moments, objections, wins, and execution quality.",
            "Scene 4 - Invite feedback.",
            "Ask viewers what was unclear, what should be improved, and what they want the next Video OS project to explain.",
        ]),
    }


def render_scene_manifest(project, script_version):
    scenes = [
        {
            "id": "s1",
            "purpose": "cold_open",
            "timecode": "00:00-00:18",
            "visual": "Avatar presenter in LUX command-center frame",
            "gesture": "calm open-hand setup",
            "cutaway": "pipeline title card",
        },
        {
            "id": "s2",
            "purpose": "transcript_flow",
            "timecode": "00:18-00:45",
            "visual": "Fathom transcript into n8n orchestration map",
            "gesture": "slight turn toward workflow overlay",
            "cutaway": "Fathom -> n8n -> email -> dashboard",
        },
        {
            "id": "s3",
            "purpose": "kpi_proof",
            "timecode": "00:45-01:15",
            "visual": "Email output and manager dashboard KPI panels",
            "gesture": "measured emphasis on decisions",
            "cutaway": "rep email plus dashboard quality cards",
        },
        {
            "id": "s4",
            "purpose": "cta",
            "timecode": "01:15-01:35",
            "visual": "Feedback and next-project prompt",
            "gesture": "direct camera close",
            "cutaway": "feedback form and review room",
        },
    ]
    if re.search(r"\bn8n|orchestration|workflow|automation\b", str(project.get("topic") or project.get("goal") or ""), re.I):
        scenes.insert(2, {
            "id": "s2b",
            "purpose": "n8n_logic",
            "timecode": "00:45-01:00",
            "visual": "n8n orchestration logic with node path animation",
            "gesture": "presenter points toward automation path",
            "cutaway": "Fathom webhook -> n8n enrichment -> email/dashboard outputs",
        })
    if re.search(r"\bmanager|coach|coaching|quality\b", str(project.get("audience") or project.get("goal") or ""), re.I):
        scenes.insert(-1, {
            "id": "s3b",
            "purpose": "manager_coaching",
            "timecode": "01:15-01:28",
            "visual": "Manager coaching insight with rep-quality interpretation",
            "gesture": "slower direct-camera emphasis",
            "cutaway": "coaching notes and execution pattern summary",
        })
    for index, scene in enumerate(scenes, start=1):
        scene["sequence"] = index
        scene["assetRoute"] = choose_assets_for_scene(scene, project, scene.get("purpose"))
    return {
        "id": f"scene-{uuid4().hex[:10]}",
        "createdAt": utc_now(),
        "scriptVersionId": script_version["id"],
        "assetRoutingVersion": "lux-scene-purpose-v1",
        "routingPrinciple": "Choose media by scene purpose first, then by brand fit, readability, and platform derivative rules.",
        "scenes": scenes,
    }


def process_script_generation(job, project):
    script = render_script(project)
    scene = render_scene_manifest(project, script)
    artifact_dir = ARTIFACTS_DIR / project["id"] / script["id"]
    artifact_dir.mkdir(parents=True, exist_ok=True)
    write_json(artifact_dir / "script.json", script)
    write_json(artifact_dir / "scene-manifest.json", scene)
    append_version(project, "script", {**script, "artifact": str(artifact_dir / "script.json")})
    append_version(project, "scene", {**scene, "artifact": str(artifact_dir / "scene-manifest.json")})
    project["status"] = "review_required"
    project["reviewState"] = "script_scene_review"
    project["nextActions"] = [
        "Review generated script.",
        "Approve scene timing and cutaway plan.",
        "Confirm avatar, voice, latency fallback, and cost cap before HeyGen submission.",
    ]
    return {"scriptId": script["id"], "sceneManifestId": scene["id"], "artifactDir": str(artifact_dir)}


def heygen_api_key():
    key = os.environ.get("HEYGEN_API_KEY") or os.environ.get("HEYGEN_TOKEN")
    if key:
        return key.strip()
    try:
        text = HEYGEN_KEY_FILE.read_text(encoding="utf-8-sig")
    except OSError:
        return None
    match = re.search(r"\bsk_[A-Za-z0-9_=-]+\b", text)
    return match.group(0) if match else None


def submit_heygen(project, allow_live=False):
    if not allow_live:
        return {
            "dryRun": True,
            "message": "HeyGen live submission skipped. Set allowLive=true for the job and provide HEYGEN_API_KEY in the server/worker environment.",
        }
    validate_heygen_talent(project)
    key = heygen_api_key()
    if not key:
        raise VideoOsError("HEYGEN_API_KEY is not configured in the worker environment.")
    latest_script = (project.get("versions", {}).get("scripts") or [{}])[-1].get("script") or project.get("scriptInput")
    avatar_id = project.get("avatar", {}).get("avatarId")
    voice_id = project.get("voice", {}).get("voiceId")
    if not avatar_id or not voice_id:
        raise VideoOsError("HeyGen avatar video requires both avatar_id and voice_id.")
    aspect_ratio = {
        "vertical": "9:16",
        "portrait": "9:16",
        "landscape": "16:9",
        "square": "1:1",
    }.get(str(project.get("renderFormat") or "").lower(), "auto")
    body = {
        "type": "avatar",
        "avatar_id": avatar_id,
        "script": latest_script or "",
        "voice_id": voice_id,
        "title": project.get("name") or "Video OS Lite",
        "resolution": "1080p",
        "aspect_ratio": aspect_ratio,
    }
    locale = (project.get("language") or project.get("voice", {}).get("locale") or "").strip()
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
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise VideoOsError(f"HeyGen avatar video submission failed: HTTP {exc.code} {detail}") from exc
    submission = {
        "submittedAt": utc_now(),
        "endpoint": "/v3/videos",
        "projectId": project.get("id"),
        "avatarId": avatar_id,
        "voiceId": voice_id,
        "aspectRatio": aspect_ratio,
        "title": body.get("title"),
        "result": result,
    }
    try:
        HEYGEN_SUBMISSIONS_DIR.mkdir(parents=True, exist_ok=True)
        write_json(HEYGEN_SUBMISSIONS_DIR / f"{project.get('id')}-{int(time.time())}-request.json", submission)
    except Exception:
        pass
    return result
def process_heygen_submit(job, project):
    result = submit_heygen(project, allow_live=bool(job.get("payload", {}).get("allowLive")))
    project["cost"]["renderAttempts"] = int(project["cost"].get("renderAttempts") or 0) + 1
    if result.get("dryRun"):
        project["status"] = "review_required"
        project["reviewState"] = "render_gate_blocked"
        project["telemetry"]["providerStatus"] = "dry_run_not_submitted"
    else:
        video_id = result.get("data", {}).get("video_id") or result.get("video_id") or result.get("id")
        project["providerJobId"] = video_id
        project["status"] = "rendering"
        project["reviewState"] = "provider_rendering"
        project["telemetry"]["providerStatus"] = "submitted"
        append_version(project, "render", {"id": video_id, "submittedAt": utc_now(), "provider": project.get("provider"), "raw": result})
    return result


def process_heygen_poll(job, project):
    provider_id = job.get("payload", {}).get("providerJobId") or project.get("providerJobId")
    if not provider_id:
        raise VideoOsError("No provider job id is available for polling.")
    key = heygen_api_key()
    if not key:
        project["telemetry"]["providerStatus"] = "poll_blocked_missing_key"
        return {"dryRun": True, "message": "Polling skipped because HEYGEN_API_KEY is not configured.", "providerJobId": provider_id}
    req = urllib.request.Request(
        f"https://api.heygen.com/v3/videos/{provider_id}",
        headers={"X-Api-Key": key, "x-api-key": key},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise VideoOsError(f"HeyGen poll failed: HTTP {exc.code} {detail}") from exc
    data = result.get("data") or {}
    status = data.get("status") or result.get("status") or "unknown"
    project["telemetry"]["providerStatus"] = status
    if status in {"completed", "success"}:
        project["status"] = "rendered"
        project["reviewState"] = "qc_required"
        video_url = data.get("video_url") or result.get("video_url")
        append_version(project, "render", {"id": provider_id, "polledAt": utc_now(), "status": status, "videoUrlPresent": bool(video_url), "raw": result})
    elif status in {"failed", "error"}:
        project["status"] = "quarantined"
        project["reviewState"] = "provider_failed"
    else:
        project["status"] = "rendering"
    return result
def process_artifact_archive(job, project):
    source = job.get("payload", {}).get("source")
    archive_dir = ARTIFACTS_DIR / project["id"] / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    candidates = []
    if source:
        candidates.append(Path(source))
    if HEYGEN_SUBMISSIONS_DIR.exists():
        candidates.extend(sorted(HEYGEN_SUBMISSIONS_DIR.glob(f"*{project.get('providerJobId') or project['id']}*")))
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            target = archive_dir / candidate.name
            shutil.copy2(candidate, target)
            copied.append(str(target))
    manifest = {"id": f"archive-{uuid4().hex[:10]}", "createdAt": utc_now(), "copied": copied}
    write_json(archive_dir / "archive-manifest.json", manifest)
    project["reviewState"] = "artifact_archived" if copied else "archive_empty"
    return manifest


def process_post_production_handoff(job, project):
    latest_scene = (project.get("versions", {}).get("sceneManifests") or [{}])[-1]
    scene_routes = latest_scene.get("scenes") or []
    handoff = {
        "id": f"post-{uuid4().hex[:10]}",
        "createdAt": utc_now(),
        "projectId": project["id"],
        "projectName": project["name"],
        "goal": project.get("goal"),
        "layers": [
            "dashboard insert",
            "transcript flow",
            "n8n orchestration map",
            "email output",
            "KPI analysis view",
            "Strategy Decode output",
            "captions",
            "music/SFX/LUT/export preset",
        ],
        "assetRouting": scene_routes,
        "instructions": job.get("payload", {}).get("instructions") or "Prepare a premium post-production pass with subtle motion, dashboard cutaways, caption polish, and feedback CTA.",
    }
    target = POST_DIR / f"{project['id']}-{handoff['id']}.md"
    target.write_text(
        "\n".join([
            f"# Post-Production Handoff - {project['name']}",
            "",
            f"Created: {handoff['createdAt']}",
            f"Project ID: `{project['id']}`",
            "",
            "## Goal",
            handoff["goal"] or "Not recorded.",
            "",
            "## Layers",
            *[f"- {layer}" for layer in handoff["layers"]],
            "",
            "## Scene Asset Routing",
            *[
                "\n".join([
                    f"### {scene.get('sequence', index + 1)}. {scene.get('assetRoute', {}).get('label') or scene.get('purpose')}",
                    f"- Timecode: {scene.get('timecode')}",
                    f"- Background: {scene.get('assetRoute', {}).get('background')}",
                    f"- LUT: {scene.get('assetRoute', {}).get('lut')}",
                    f"- Music: {scene.get('assetRoute', {}).get('music')}",
                    f"- SFX: {', '.join(scene.get('assetRoute', {}).get('sfx') or [])}",
                    f"- Overlay: {scene.get('assetRoute', {}).get('overlay')}",
                    f"- Transition In: {scene.get('assetRoute', {}).get('transitionIn')}",
                    f"- Transition Out: {scene.get('assetRoute', {}).get('transitionOut')}",
                    f"- Motion: {scene.get('assetRoute', {}).get('motion')}",
                    f"- Technique: {scene.get('assetRoute', {}).get('technique')}",
                    f"- Rule: {scene.get('assetRoute', {}).get('rule')}",
                ])
                for index, scene in enumerate(scene_routes)
            ],
            "",
            "## Instructions",
            handoff["instructions"],
        ]),
        encoding="utf-8",
    )
    append_version(project, "post", {**handoff, "artifact": str(target)})
    project["reviewState"] = "post_production_handoff_ready"
    project["nextActions"] = ["Open the handoff, assemble visual inserts, then return final export to QC."]
    return {"handoff": str(target)}


def process_job(job):
    job["status"] = "running"
    if not job.get("leasedAt"):
        job["attempts"] = int(job.get("attempts") or 0) + 1
    save_job(job)
    store = load_store()
    project = find_project(store, job.get("projectId")) if job.get("projectId") else None
    if job["type"] not in TREND_JOB_TYPES and not project:
        raise VideoOsError(f"Project not found: {job['projectId']}")
    processors = {
        "script_generation": process_script_generation,
        "heygen_submit": process_heygen_submit,
        "heygen_poll": process_heygen_poll,
        "artifact_archive": process_artifact_archive,
        "post_production_handoff": process_post_production_handoff,
        "trend_discovery": process_trend_discovery,
        "trend_scoring": process_trend_scoring,
        "trend_to_video_project": process_trend_to_video_project,
    }
    try:
        result = processors[job["type"]](job, project)
        job["status"] = "completed"
        job["result"] = result
        job["error"] = None
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
        if project:
            project["status"] = "quarantined"
            project["reviewState"] = f"{job['type']}_failed"
        result = None
    if project:
        project["updatedAt"] = utc_now()
        save_store(store)
    else:
        publish_public_snapshot()
    save_job(job)
    return job


def process_next_job():
    job = next_queued_job()
    if not job:
        publish_public_snapshot()
        return None
    return process_job(job)



