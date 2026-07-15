import http.cookiejar
import json
import sys
import time
import urllib.request


BASE = "http://127.0.0.1:8789"
COOKIE_JAR = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIE_JAR))

def request(path, payload=None):
    return request_with_opener(OPENER, path, payload)


def request_without_session(path, payload=None):
    return request_with_opener(urllib.request.build_opener(), path, payload)


def request_with_opener(opener, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with opener.open(req, timeout=10) as response:
        body = json.loads(response.read().decode("utf-8"))
    if body.get("ok") is False:
        raise RuntimeError(body.get("error") or f"{path} failed")
    return body


def main():
    health = request("/health")
    assert health["ok"] is True

    no_session_project = request_without_session("/api/video-os/projects", {
        "accountId": "spoofed-client",
        "name": f"QA No Session {int(time.time())}",
        "audience": "first-time creators",
        "goal": "prove server-owned account scoping prevents browser account spoofing",
        "topic": "Security smoke",
        "scriptMode": "paste_exact",
        "scriptInput": "Short smoke test script for account scoping.",
    })["project"]
    assert no_session_project["accountId"] != "spoofed-client"

    request("/api/video-os/talent")
    account = request("/api/video-os-lite/account")
    assert account["account"]["accountId"]
    providers = request("/api/video-os-lite/providers")
    assert providers["accountId"] == account["account"]["accountId"]
    script_payload = {
        "title": f"QA Smoke {int(time.time())}",
        "audience": "first-time creators",
        "goalType": "Explainer",
        "objective": "create and export a short AI video",
        "tone": "Warm and clear",
    }
    script = request("/api/video-os-lite/script", script_payload)["script"]
    assert "Scene 1" in script

    project = request("/api/video-os/projects", {
        "accountId": "spoofed-client",
        "name": script_payload["title"],
        "audience": script_payload["audience"],
        "goal": script_payload["objective"],
        "topic": script_payload["goalType"],
        "scriptMode": "paste_exact",
        "scriptInput": script,
    })["project"]
    assert project["status"] == "draft"
    assert project["accountId"] == account["account"]["accountId"]

    export = request("/api/video-os-lite/export", {**script_payload, "accountId": "spoofed-client", "script": script, "format": "square"})
    assert export["url"].endswith(".mp4")
    print(json.dumps({"ok": True, "projectId": project["id"], "export": export["url"]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        sys.exit(1)




