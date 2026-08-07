import json
import os
import pytest

import server
import video_os_backend as video_os


def configure_asset_roots(monkeypatch, tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    for folder in server.ALLOWED_ASSET_FOLDERS:
        (assets / folder).mkdir()
    monkeypatch.setattr(server, "ASSETS", assets)
    monkeypatch.setattr(server, "ASSET_MANIFEST", assets / "asset-manifest.json")
    monkeypatch.setattr(server, "ASSET_FOLDER_ROOTS", {folder: assets / folder for folder in server.ALLOWED_ASSET_FOLDERS})
    return assets


def test_normalize_talent_item_sanitizes_provider_style_fields():
    normalized = video_os.normalize_talent_item(
        {
            "avatar_id": "avatar-1",
            "avatar_name": "Presenter",
            "source": "heygen",
            "style": "energetic",
            "gender": "female",
            "language": "en-US",
        },
        "avatar",
    )

    assert normalized["style"] == "available"
    assert normalized["source"] == "heygen"


def test_normalize_talent_item_preserves_safe_local_style():
    normalized = video_os.normalize_talent_item(
        {"id": "local-1", "name": "Local", "source": "local", "style": "executive", "gender": "female"},
        "avatar",
    )

    assert normalized["style"] == "executive"


def test_sanitized_provider_inventory_never_persists_raw_style_markers(tmp_path):
    normalized = video_os.normalize_talent_item(
        {
            "avatar_id": "avatar-1",
            "avatar_name": "Presenter",
            "source": "heygen",
            "style": "energetic",
            "gender": "female",
            "language": "en-US",
        },
        "avatar",
    )
    inventory = {"source": "heygen", "avatars": [normalized], "voices": []}
    target = tmp_path / "talent-inventory.json"
    target.write_text(json.dumps(inventory), encoding="utf-8")
    persisted = target.read_text(encoding="utf-8").lower()

    assert '"style": "available"' in persisted
    assert "energetic" not in persisted
    assert "female" not in persisted
    assert "en-us" not in persisted
    assert "gender" not in persisted
    assert "language" not in persisted


def test_legacy_provider_inventory_is_resanitized_before_normal_write(monkeypatch, tmp_path):
    target = tmp_path / "talent-inventory.json"
    target.write_text(json.dumps({
        "source": "heygen",
        "avatars": [{"id": "avatar-1", "name": "Presenter", "source": "heygen", "style": "female"}],
        "voices": [{"id": "voice-1", "name": "Voice", "source": "heygen", "style": "en-US"}],
    }), encoding="utf-8")
    monkeypatch.setattr(video_os, "TALENT_INVENTORY_FILE", target)
    monkeypatch.setattr(video_os, "ensure_dirs", lambda: None)

    inventory = video_os.load_talent_inventory(refresh=False)

    avatars = {item["id"]: item for item in inventory["avatars"]}
    voices = {item["id"]: item for item in inventory["voices"]}
    assert avatars["avatar-1"]["style"] == "available"
    assert voices["voice-1"]["style"] == "available"
    persisted = target.read_text(encoding="utf-8")
    assert "female" not in persisted
    assert "en-US" not in persisted


def test_resolve_asset_file_returns_allowed_local_media(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "music" / "Good Song.mp3"
    target.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")

    assert server.resolve_asset_file("Good Song.mp3", "music") == target.resolve(strict=False)


def test_resolve_asset_file_accepts_manifest_entry_within_root(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "luts" / "Creative.cube"
    target.write_text("LUT_3D_SIZE 2\n", encoding="utf-8")
    server.ASSET_MANIFEST.write_text(
        json.dumps([{"folder": "luts", "title": "Creative : Bright", "file": "Creative.cube", "path": "luts/Creative.cube"}]),
        encoding="utf-8",
    )

    assert server.resolve_asset_file("Creative.cube", "luts") == target.resolve(strict=False)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "../secret.mp3",
        r"..\secret.mp3",
        "/etc/passwd",
        r"C:\temp\clip.mp3",
        r"\\server\share\clip.mp3",
        "folder/clip.mp3",
        r"folder\clip.mp3",
        "..%2fsecret.mp3",
        "%252e%252e%252fsecret.mp3",
        "clip.mp3\x00.jpg",
    ],
)
def test_resolve_asset_file_rejects_unsafe_names(monkeypatch, tmp_path, name):
    configure_asset_roots(monkeypatch, tmp_path)

    assert server.resolve_asset_file(name, "music") is None


@pytest.mark.parametrize(
    "folder",
    [
        "",
        "../music",
        r"..\music",
        "music/../overlays",
        r"music\..\overlays",
        r"C:\temp",
    ],
)
def test_resolve_asset_file_rejects_unsafe_folders(monkeypatch, tmp_path, folder):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "music" / "Good Song.mp3"
    target.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")

    assert server.resolve_asset_file("Good Song.mp3", folder) is None


def test_resolve_asset_file_rejects_disallowed_extensions(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "music" / "notes.txt"
    target.write_text("not media", encoding="utf-8")

    assert server.resolve_asset_file("notes.txt", "music") is None


def test_resolve_asset_file_rejects_manifest_escape_and_prefix_confusion(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    sibling = assets / "music-escape.mp3"
    sibling.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
    server.ASSET_MANIFEST.write_text(
        json.dumps([{"folder": "music", "title": "Escape", "file": "Escape.mp3", "path": sibling.as_posix()}]),
        encoding="utf-8",
    )

    assert server.resolve_asset_file("Escape.mp3", "music") is None


def test_resolve_asset_file_rejects_symlink_escape(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
    link = assets / "music" / "Escape.mp3"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError, AttributeError):
        pytest.skip("symlink creation unavailable")

    assert server.resolve_asset_file("Escape.mp3", "music") is None


def test_open_validated_asset_rejects_extension_only_content(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "music" / "Fake.mp3"
    target.write_bytes(b"not-an-mp3")

    assert server.resolve_asset_file("Fake.mp3", "music") is None
    assert server.open_validated_asset(target, assets / "music") is None


def test_open_validated_asset_accepts_content_and_returns_same_handle(monkeypatch, tmp_path):
    assets = configure_asset_roots(monkeypatch, tmp_path)
    target = assets / "music" / "Good Song.mp3"
    contents = b"ID3\x04\x00\x00\x00\x00\x00\x00payload"
    target.write_bytes(contents)

    path = server.resolve_asset_file("Good Song.mp3", "music")
    handle = server.open_validated_asset(path, assets / "music")
    assert handle is not None
    try:
        assert handle.read() == contents
    finally:
        handle.close()
