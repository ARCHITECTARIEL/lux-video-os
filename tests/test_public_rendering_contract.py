from pathlib import Path
from unittest.mock import patch

import vercel_api_shared


ROOT = Path(__file__).resolve().parents[1]


def test_responsive_overrides_follow_desktop_layout_declarations():
    css = (ROOT / "public" / "lite.css").read_text(encoding="utf-8")

    marker = "/* Rendering integrity: keep late desktop overrides responsive. */"
    assert marker in css
    responsive_tail = css.split(marker, 1)[1]
    assert ".preview-zone" in responsive_tail
    assert "width: min(1180px, calc(100% - 28px));" in responsive_tail
    assert ".quick-start" in responsive_tail
    assert ".pricing-hero" in responsive_tail
    assert "grid-template-columns: 1fr;" in responsive_tail


def test_mobile_viewport_is_horizontally_contained():
    css = (ROOT / "public" / "lite.css").read_text(encoding="utf-8")

    marker = "/* Mobile stability: contain the visual viewport and touch flow. */"
    assert marker in css
    mobile_tail = css.split(marker, 1)[1]
    assert "overflow-x: clip;" in mobile_tail
    assert "overscroll-behavior-x: none;" in mobile_tail
    assert "min-width: 0;" in mobile_tail
    assert ".hero-logo-lockup" in mobile_tail
    assert "width: min(330px, 100%);" in mobile_tail
    assert ".topbar nav" in mobile_tail
    assert "overflow-x: auto;" in mobile_tail
    assert ".auth-panel" in mobile_tail
    assert "max-height: calc(100dvh - 24px);" in mobile_tail


def test_password_login_uses_a_real_form():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "lite.js").read_text(encoding="utf-8")

    assert '<form class="auth-method" id="password-login-form"' in html
    assert 'id="password-login" type="submit"' in html
    assert "document.querySelector('#password-login-form').addEventListener('submit'" in javascript


def test_account_modal_exposes_explicit_access_and_magic_link_states():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "lite.js").read_text(encoding="utf-8")

    assert 'name="access-type"' in html
    assert 'value="demo"' in html
    assert 'value="owner"' in html
    assert 'id="magic-link-hint"' in html
    assert "accessType" in javascript
    assert "setAuthPending" in javascript
    assert "dataset.state" in javascript
    assert "Check your inbox" in javascript


def test_vercel_payload_excludes_local_visual_qa():
    ignored = (ROOT / ".vercelignore").read_text(encoding="utf-8").splitlines()

    assert ".lazyweb/" in ignored


def test_auth_modal_has_recovery_and_session_aware_controls():
    html = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')
    javascript = (ROOT / 'public' / 'lite.js').read_text(encoding='utf-8')

    assert 'id="magic-link-form"' in html
    assert 'id="auth-retry"' in html
    assert 'id="auth-session-summary"' in html
    assert 'data-auth-signed-out' in html
    assert 'aria-controls="auth-modal"' in html
    assert 'syncAuthUi' in javascript
    assert 'consumeAuthReturn' in javascript
    assert "credentials: 'same-origin'" in javascript
    assert 'We couldn’t reach Video OS' in javascript
    assert "document.querySelector('#magic-link-form').addEventListener('submit'" in javascript
    assert 'authOpener?.focus' in javascript


def test_latest_thirty_gallery_has_progressive_disclosure():
    # public/index.html loads public/studio.js (see its closing <script> tag),
    # not public/lite.js -- lite.js/lite.css are an earlier, now-unloaded
    # frontend kept in the tree but not referenced by any HTML page. This
    # test was written against that earlier frontend, before it was replaced;
    # updated here to check the page that's actually served, where the same
    # progressive-disclosure behavior now lives under the "My Videos" heading.
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "studio.js").read_text(encoding="utf-8")

    assert 'id="results-title">My Videos<' in html
    assert 'id="result-gallery-toggle"' in html
    assert ".slice(0, 30);" in javascript
    assert "state.resultLimit = state.resultLimit > 6 ? 6 : 30;" in javascript


def test_hosted_talent_inventory_returns_partial_data_when_one_provider_call_times_out(monkeypatch):
    monkeypatch.setenv("HEYGEN_API_KEY", "test-key")
    avatars = [{"avatar_id": "avatar-1", "avatar_name": "Presenter", "supported_api_engines": ["avatar_iv"]}]

    def fake_fetch(url, timeout=vercel_api_shared.TALENT_REQUEST_TIMEOUT_SECONDS):
        if "avatars" in url:
            return avatars
        raise TimeoutError("voice inventory timed out")

    with patch.object(vercel_api_shared, "fetch_heygen_collection", side_effect=fake_fetch):
        result = vercel_api_shared.hosted_talent_inventory()

    assert result["talent"]["avatars"][0]["id"] == "avatar-1"
    assert result["talent"]["voices"] == []
    assert result["connection"]["connected"] is False
    assert result["connection"]["status"] == "degraded"
    assert "voices" in result["connection"]["failed"]


def test_hosted_talent_inventory_fails_closed_when_avatar_catalog_times_out(monkeypatch):
    monkeypatch.setenv("HEYGEN_API_KEY", "test-key")
    voices = [{"voice_id": "voice-1", "name": "Narrator"}]

    def fake_fetch(url, timeout=vercel_api_shared.TALENT_REQUEST_TIMEOUT_SECONDS):
        if "avatars" in url:
            raise TimeoutError("avatar inventory timed out")
        return voices

    with patch.object(vercel_api_shared, "fetch_heygen_collection", side_effect=fake_fetch):
        result = vercel_api_shared.hosted_talent_inventory()

    assert result["talent"]["avatars"] == []
    assert result["talent"]["voices"][0]["id"] == "voice-1"
    assert result["connection"]["status"] == "degraded"
    assert "avatars" in result["connection"]["failed"]


def test_hosted_talent_inventory_uses_v3_public_avatar_iv_looks(monkeypatch):
    monkeypatch.setenv("HEYGEN_API_KEY", "test-key")
    monkeypatch.delenv("HEYGEN_AVATARS_URL", raising=False)
    requested_urls = []

    def fake_fetch(url, timeout=vercel_api_shared.TALENT_REQUEST_TIMEOUT_SECONDS):
        requested_urls.append(url)
        if "avatars" in url:
            return [
                {"id": "avatar-iv", "name": "Compatible", "supported_api_engines": ["avatar_iv"]},
                {"id": "avatar-v-only", "name": "Incompatible", "supported_api_engines": ["avatar_v"]},
            ]
        return [{"voice_id": "voice-1", "name": "Narrator"}]

    with patch.object(vercel_api_shared, "fetch_heygen_collection", side_effect=fake_fetch):
        result = vercel_api_shared.hosted_talent_inventory()

    assert any("/v3/avatars/looks?ownership=public" in url for url in requested_urls)
    assert [item["id"] for item in result["talent"]["avatars"]] == ["avatar-iv"]


def test_local_python_upload_route_is_explicitly_fail_closed():
    source = (ROOT / 'server.py').read_text(encoding='utf-8')
    guard = source.index('/api/video-os-lite/uploads')
    block = source[guard:source.index('return', guard) + len('return')]

    assert 'HTTPStatus.SERVICE_UNAVAILABLE' in block
    assert 'upload_unavailable' in block
    assert 'save_lite_upload(payload)' not in block


def test_legacy_local_talent_routes_fail_closed_before_provider_access():
    source = (ROOT / "server.py").read_text(encoding="utf-8")
    get_guard = source.index('if self.path == "/api/video-os/talent":')
    refresh_guard = source.index('if self.path == "/api/video-os/talent/refresh":')
    get_block = source[get_guard:source.index("return", get_guard) + len("return")]
    refresh_block = source[refresh_guard:source.index("return", refresh_guard) + len("return")]

    assert "HTTPStatus.UNAUTHORIZED" in get_block
    assert "HTTPStatus.UNAUTHORIZED" in refresh_block
    assert "hosted_talent_inventory" not in get_block
    assert "refresh_talent" not in refresh_block
