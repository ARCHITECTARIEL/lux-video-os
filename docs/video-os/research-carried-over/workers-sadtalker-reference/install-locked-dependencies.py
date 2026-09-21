#!/usr/bin/env python3
"""Install the pinned SadTalker runtime through a verified offline boundary."""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit


RUNTIME_LOCK_SHA256 = "ef43a717381cf3207405317a18919f57704aec3c6cc5a7206e3234fa9703d2a0"
EXPECTED_PYTHON = (3, 8)
EXPECTED_EXTRA_INDEX = "--extra-index-url https://download.pytorch.org/whl/cu113"
BOOTSTRAP_NAMES = ("cffi", "pycparser", "numpy", "typing-extensions", "torch")
DIRECT_URL_NAMES = ("torch", "torchaudio", "torchvision")
TOOL_VERSIONS = {
    "pip": "24.3.1",
    "setuptools": "75.3.4",
    "wheel": "0.45.1",
    "patch-ng": "1.19.1",
    "cython": "3.0.12",
}
MANIFEST_NAME = "_artifact-manifest.json"
PROJECTION_NAME = "_offline-requirements.lock"
LOCAL_TOOL_LOCATION = "/usr/local/lib/python3.8/dist-packages"

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.!+_-]*$")
HASH_RE = re.compile(r"^--hash=sha256:([0-9a-fA-F]{64})$")


class ToolchainError(RuntimeError):
    pass


class RequirementRecord:
    def __init__(self, name, display_name, version, url, hashes, raw):
        self.name = name
        self.display_name = display_name
        self.version = version
        self.url = url
        self.hashes = tuple(hashes)
        self.raw = raw

    def identity(self):
        return self.name, self.version, self.hashes


def canonical_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def sha256_path(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _wheel_version(name, url):
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "file"} or parsed.query or parsed.fragment:
        raise ToolchainError("direct requirements must use an unqualified HTTPS or file URL")
    filename = unquote(parsed.path.rsplit("/", 1)[-1])
    if not filename.endswith(".whl"):
        raise ToolchainError("direct requirement must identify a wheel: {}".format(name))
    parts = filename[:-4].split("-")
    if len(parts) < 5 or canonical_name(parts[0]) != name or not VERSION_RE.fullmatch(parts[1]):
        raise ToolchainError("direct wheel identity does not match requirement: {}".format(name))
    return parts[1]


def _parse_logical_requirement(logical, raw):
    try:
        tokens = shlex.split(logical, posix=True)
    except ValueError as error:
        raise ToolchainError("malformed requirement record: {}".format(error))
    if not tokens:
        raise ToolchainError("empty requirement record")

    url = None
    direct = len(tokens) >= 3 and tokens[1] == "@"
    if direct:
        display_name, _, url = tokens[:3]
        option_tokens = tokens[3:]
        if not NAME_RE.fullmatch(display_name):
            raise ToolchainError("invalid package name: {}".format(display_name))
        name = canonical_name(display_name)
        version = _wheel_version(name, url)
    else:
        match = re.fullmatch(
            r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)",
            tokens[0],
        )
        if not match:
            raise ToolchainError("requirement is not an exact pin: {}".format(tokens[0]))
        display_name, version = match.groups()
        name = canonical_name(display_name)
        option_tokens = tokens[1:]

    if not option_tokens:
        raise ToolchainError("requirement has no SHA-256 hash: {}".format(name))
    hashes = []
    for token in option_tokens:
        match = HASH_RE.fullmatch(token)
        if not match:
            raise ToolchainError("unsupported requirement option for {}: {}".format(name, token))
        value = match.group(1).lower()
        if value in hashes:
            raise ToolchainError("duplicate hash for requirement: {}".format(name))
        hashes.append(value)
    return RequirementRecord(name, display_name, version, url, hashes, raw)


def parse_lock_bytes(content):
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ToolchainError("requirements lock is not UTF-8: {}".format(error))

    lines = text.splitlines(keepends=True)
    records = []
    options = []
    seen = set()
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        if stripped.startswith("--"):
            if stripped != EXPECTED_EXTRA_INDEX or stripped in options:
                raise ToolchainError("unsupported or duplicate global lock option: {}".format(stripped))
            options.append(stripped)
            index += 1
            continue

        start = index
        logical_parts = []
        while True:
            physical = lines[index].rstrip("\r\n").strip()
            if not physical or physical.startswith("#"):
                raise ToolchainError("comment or blank line inside requirement record")
            continued = physical.endswith("\\")
            if continued:
                physical = physical[:-1].rstrip()
            logical_parts.append(physical)
            index += 1
            if not continued:
                break
            if index >= len(lines):
                raise ToolchainError("unterminated requirement continuation")
        raw = "".join(lines[start:index])
        record = _parse_logical_requirement(" ".join(logical_parts), raw)
        if record.name in seen:
            raise ToolchainError("duplicate requirement: {}".format(record.name))
        seen.add(record.name)
        records.append(record)

    if not records:
        raise ToolchainError("requirements lock contains no records")
    return text, tuple(options), tuple(records)


def load_runtime_lock(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ToolchainError("runtime lock must be a regular file")
    content = path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != RUNTIME_LOCK_SHA256:
        raise ToolchainError(
            "runtime lock trust-anchor mismatch: expected {}, got {}".format(
                RUNTIME_LOCK_SHA256, actual
            )
        )
    text, options, records = parse_lock_bytes(content)
    if options != (EXPECTED_EXTRA_INDEX,):
        raise ToolchainError("runtime lock index declaration is missing")
    direct_names = tuple(record.name for record in records if record.url is not None)
    if direct_names != DIRECT_URL_NAMES:
        raise ToolchainError("runtime lock direct-URL inventory changed")
    return text, records


def _record_map(records):
    return {record.name: record for record in records}


def derive_bootstrap(records):
    by_name = _record_map(records)
    missing = [name for name in BOOTSTRAP_NAMES if name not in by_name]
    if missing:
        raise ToolchainError("bootstrap requirements missing: {}".format(", ".join(missing)))
    selected = [by_name[name] for name in BOOTSTRAP_NAMES]
    return (EXPECTED_EXTRA_INDEX + "\n\n" + "".join(record.raw for record in selected)).encode(
        "utf-8"
    )


def installed_distribution_records():
    inventory = {}
    for distribution in importlib.metadata.distributions():
        display_name = distribution.metadata.get("Name")
        if not display_name or not NAME_RE.fullmatch(display_name):
            raise ToolchainError("installed distribution has invalid or missing Name metadata")
        name = canonical_name(display_name)
        record = {
            "version": distribution.version,
            "location": os.path.realpath(os.fspath(distribution.locate_file(""))),
        }
        inventory.setdefault(name, []).append(record)
    for records in inventory.values():
        records.sort(key=lambda record: (record["location"], record["version"]))
    return dict(sorted(inventory.items()))


def _effective_distribution_record(name):
    try:
        distribution = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        raise ToolchainError("effective distribution is missing: {}".format(name))
    display_name = distribution.metadata.get("Name")
    if not display_name or canonical_name(display_name) != name:
        raise ToolchainError("effective distribution identity mismatch: {}".format(name))
    return {
        "version": distribution.version,
        "location": os.path.realpath(os.fspath(distribution.locate_file(""))),
    }


def _local_install_location():
    return os.path.realpath(LOCAL_TOOL_LOCATION)


def _is_apt_location(location):
    root = Path("/usr/lib/python3/dist-packages")
    candidate = Path(location)
    return candidate == root or root in candidate.parents


def _require_python():
    actual = sys.version_info[:2]
    if actual != EXPECTED_PYTHON:
        raise ToolchainError(
            "expected Python {}.{}, got {}.{}".format(
                EXPECTED_PYTHON[0], EXPECTED_PYTHON[1], actual[0], actual[1]
            )
        )


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(dir=str(path.parent), delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def snapshot(baseline_path):
    _require_python()
    baseline_path = Path(baseline_path)
    if baseline_path.exists() or baseline_path.is_symlink():
        raise ToolchainError("baseline path already exists")
    inventory = installed_distribution_records()
    duplicates = sorted(name for name, records in inventory.items() if len(records) != 1)
    if duplicates:
        raise ToolchainError(
            "pre-bootstrap baseline contains duplicate distributions: {}".format(
                ", ".join(duplicates)
            )
        )
    baseline = {name: records[0] for name, records in inventory.items()}
    _write_json(
        baseline_path,
        {
            "schema": 2,
            "python": "{}.{}".format(*EXPECTED_PYTHON),
            "distributions": baseline,
        },
    )
    print(json.dumps({"phase": "snapshot", "distributions": len(baseline)}, sort_keys=True))


def load_baseline(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ToolchainError("baseline must be a regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ToolchainError("invalid baseline JSON: {}".format(error))
    if not isinstance(value, dict) or set(value) != {"schema", "python", "distributions"}:
        raise ToolchainError("baseline schema mismatch")
    if value["schema"] != 2 or value["python"] != "3.8":
        raise ToolchainError("baseline runtime mismatch")
    inventory = value["distributions"]
    if not isinstance(inventory, dict):
        raise ToolchainError("baseline distributions must be an object")
    checked = {}
    for name, record in inventory.items():
        if canonical_name(name) != name or not isinstance(record, dict):
            raise ToolchainError("invalid baseline distribution entry")
        if set(record) != {"version", "location"}:
            raise ToolchainError("invalid baseline distribution record")
        version = record["version"]
        location = record["location"]
        if (
            not isinstance(version, str)
            or not version
            or not isinstance(location, str)
            or not Path(location).is_absolute()
            or os.path.realpath(location) != location
        ):
            raise ToolchainError("invalid baseline distribution record")
        checked[name] = {"version": version, "location": location}
    return checked


def expected_inventory(baseline, records=(), include_tools=True):
    expected = {name: record["version"] for name, record in baseline.items()}
    if include_tools:
        expected.update(TOOL_VERSIONS)
    for record in records:
        expected[record.name] = record.version
    return dict(sorted(expected.items()))


def assert_inventory(expected, baseline, phase, overridden_names=()):
    actual = installed_distribution_records()
    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    if missing or unexpected:
        raise ToolchainError(
            "{} inventory mismatch; missing={}; unexpected={}".format(
                phase, missing, unexpected
            )
        )
    overridden_names = set(overridden_names)
    local_location = _local_install_location()
    for name, expected_version in expected.items():
        observed = actual[name]
        if len(observed) == 1:
            record = observed[0]
            if record["version"] != expected_version:
                raise ToolchainError(
                    "{} version mismatch for {}: {} != {}".format(
                        phase, name, record["version"], expected_version
                    )
                )
            if name in baseline and name not in overridden_names and record != baseline[name]:
                raise ToolchainError("{} baseline location changed for {}".format(phase, name))
            if name in TOOL_VERSIONS:
                if expected_version != TOOL_VERSIONS[name] or record["location"] != local_location:
                    raise ToolchainError("{} tool is not the approved local install: {}".format(phase, name))
                if _effective_distribution_record(name) != record:
                    raise ToolchainError("{} tool does not resolve to its local install: {}".format(phase, name))
            continue

        if name not in TOOL_VERSIONS or name not in baseline or len(observed) != 2:
            raise ToolchainError("{} unexpected duplicate distribution: {}".format(phase, name))
        old = baseline[name]
        if not _is_apt_location(old["location"]):
            raise ToolchainError("{} duplicate tool baseline is not apt-owned: {}".format(phase, name))
        matching_old = [record for record in observed if record == old]
        replacements = [record for record in observed if record != old]
        if len(matching_old) != 1 or len(replacements) != 1:
            raise ToolchainError("{} duplicate tool does not preserve baseline: {}".format(phase, name))
        replacement = replacements[0]
        if (
            expected_version != TOOL_VERSIONS[name]
            or replacement["version"] != expected_version
            or replacement["location"] != local_location
        ):
            raise ToolchainError("{} duplicate tool replacement is not approved: {}".format(phase, name))
        if _effective_distribution_record(name) != replacement:
            raise ToolchainError("{} apt metadata shadows approved tool: {}".format(phase, name))


def _pip(arguments):
    environment = dict(os.environ)
    for name in tuple(environment):
        if name.upper().startswith("PIP_"):
            del environment[name]
    environment.update(
        {
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INPUT": "1",
        }
    )
    command = [sys.executable, "-m", "pip"] + list(arguments)
    try:
        subprocess.run(command, check=True, env=environment)
    except subprocess.CalledProcessError as error:
        raise ToolchainError("pip command failed with exit code {}".format(error.returncode))


def _new_artifact_directory(path):
    path = Path(path)
    if path.exists():
        if path.is_symlink() or not path.is_dir():
            raise ToolchainError("artifact path must be a directory")
        if any(path.iterdir()):
            raise ToolchainError("artifact directory must start empty")
    else:
        path.mkdir(parents=True)
    return path.resolve()


def _index_downloads(artifact_dir, records):
    entries = []
    matched_names = set()
    paths = sorted(artifact_dir.iterdir(), key=lambda item: item.name)
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise ToolchainError("artifact directory contains a non-regular file: {}".format(path.name))
        digest = sha256_path(path)
        matches = [record for record in records if digest in record.hashes]
        if len(matches) != 1:
            raise ToolchainError("artifact hash has {} lock matches: {}".format(len(matches), path.name))
        record = matches[0]
        if record.name in matched_names:
            raise ToolchainError("multiple artifacts selected for requirement: {}".format(record.name))
        matched_names.add(record.name)
        entries.append(
            {
                "bytes": path.stat().st_size,
                "file": path.name,
                "name": record.name,
                "sha256": digest,
                "version": record.version,
            }
        )
    missing = sorted(set(_record_map(records)) - matched_names)
    if missing:
        raise ToolchainError("runtime artifacts missing: {}".format(", ".join(missing)))
    return sorted(entries, key=lambda entry: entry["name"])


def build_projection(lock_text, records, artifact_dir, entries):
    by_name = {entry["name"]: entry for entry in entries}
    projection = lock_text
    mappings = []
    for record in records:
        if record.url is None:
            continue
        if record.name not in DIRECT_URL_NAMES:
            raise ToolchainError("unapproved direct URL in runtime lock: {}".format(record.name))
        entry = by_name.get(record.name)
        if entry is None or entry["sha256"] not in record.hashes:
            raise ToolchainError("direct artifact does not preserve lock hash: {}".format(record.name))
        if projection.count(record.url) != 1:
            raise ToolchainError("direct URL occurrence is not unique: {}".format(record.name))
        local_url = (artifact_dir / entry["file"]).resolve().as_uri()
        projection = projection.replace(record.url, local_url, 1)
        mappings.append(
            {
                "name": record.name,
                "originalUrl": record.url,
                "localUrl": local_url,
                "sha256": entry["sha256"],
            }
        )

    _, projected_options, projected_records = parse_lock_bytes(projection.encode("utf-8"))
    if projected_options != (EXPECTED_EXTRA_INDEX,):
        raise ToolchainError("offline projection changed lock options")
    if tuple(record.identity() for record in projected_records) != tuple(
        record.identity() for record in records
    ):
        raise ToolchainError("offline projection changed requirement identity, version, or hashes")
    changed = tuple(record.name for record in projected_records if record.url is not None)
    if changed != DIRECT_URL_NAMES or any(
        urlsplit(record.url).scheme != "file"
        for record in projected_records
        if record.url is not None
    ):
        raise ToolchainError("offline projection did not localize exactly the Torch URLs")
    return projection.encode("utf-8"), mappings


def _load_manifest(artifact_dir):
    manifest_path = artifact_dir / MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ToolchainError("artifact manifest is missing")
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ToolchainError("invalid artifact manifest: {}".format(error))
    required = {
        "schema",
        "runtimeLockSha256",
        "artifacts",
        "offlineProjectionSha256",
        "transportMappings",
    }
    if not isinstance(value, dict) or set(value) != required or value["schema"] != 1:
        raise ToolchainError("artifact manifest schema mismatch")
    return value


def verify_artifacts(artifact_dir, lock_text, records):
    artifact_dir = Path(artifact_dir)
    if artifact_dir.is_symlink() or not artifact_dir.is_dir():
        raise ToolchainError("artifact directory is missing")
    artifact_dir = artifact_dir.resolve()
    manifest = _load_manifest(artifact_dir)
    if manifest["runtimeLockSha256"] != RUNTIME_LOCK_SHA256:
        raise ToolchainError("artifact manifest runtime-lock binding mismatch")
    listed = manifest["artifacts"]
    if not isinstance(listed, list):
        raise ToolchainError("artifact manifest inventory must be a list")
    filenames = []
    for entry in listed:
        if not isinstance(entry, dict) or set(entry) != {"bytes", "file", "name", "sha256", "version"}:
            raise ToolchainError("artifact manifest entry schema mismatch")
        filename = entry["file"]
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ToolchainError("artifact manifest filename is unsafe")
        filenames.append(filename)
    expected_items = set(filenames) | {MANIFEST_NAME, PROJECTION_NAME}
    actual_items = {path.name for path in artifact_dir.iterdir()}
    if actual_items != expected_items:
        raise ToolchainError("artifact directory inventory differs from manifest")
    for filename in filenames:
        path = artifact_dir / filename
        if path.is_symlink() or not path.is_file():
            raise ToolchainError("artifact is not a regular file: {}".format(filename))

    actual_entries = _index_downloads_for_manifest(artifact_dir, records, filenames)
    if actual_entries != listed:
        raise ToolchainError("artifact manifest does not match downloaded files")
    projection, mappings = build_projection(lock_text, records, artifact_dir, actual_entries)
    projection_path = artifact_dir / PROJECTION_NAME
    if projection_path.is_symlink() or not projection_path.is_file():
        raise ToolchainError("offline projection is missing")
    if projection_path.read_bytes() != projection:
        raise ToolchainError("offline projection content mismatch")
    if sha256_path(projection_path) != manifest["offlineProjectionSha256"]:
        raise ToolchainError("offline projection digest mismatch")
    if mappings != manifest["transportMappings"]:
        raise ToolchainError("offline transport mapping mismatch")
    return projection_path


def _index_downloads_for_manifest(artifact_dir, records, filenames):
    staging = []
    matched_names = set()
    for filename in sorted(filenames):
        path = artifact_dir / filename
        digest = sha256_path(path)
        matches = [record for record in records if digest in record.hashes]
        if len(matches) != 1:
            raise ToolchainError("artifact hash has {} lock matches: {}".format(len(matches), filename))
        record = matches[0]
        if record.name in matched_names:
            raise ToolchainError("multiple artifacts selected for requirement: {}".format(record.name))
        matched_names.add(record.name)
        staging.append(
            {
                "bytes": path.stat().st_size,
                "file": filename,
                "name": record.name,
                "sha256": digest,
                "version": record.version,
            }
        )
    missing = sorted(set(_record_map(records)) - matched_names)
    if missing:
        raise ToolchainError("runtime artifacts missing: {}".format(", ".join(missing)))
    return sorted(staging, key=lambda entry: entry["name"])


def acquire(lock_path, artifact_path, baseline_path):
    _require_python()
    lock_text, records = load_runtime_lock(lock_path)
    baseline = load_baseline(baseline_path)
    tool_names = set(TOOL_VERSIONS)
    assert_inventory(expected_inventory(baseline), baseline, "tool bootstrap", tool_names)
    artifact_dir = _new_artifact_directory(artifact_path)

    bootstrap_records = [_record_map(records)[name] for name in BOOTSTRAP_NAMES]
    bootstrap_content = derive_bootstrap(records)
    with tempfile.NamedTemporaryFile(suffix=".lock", delete=False) as handle:
        bootstrap_path = Path(handle.name)
        handle.write(bootstrap_content)
    try:
        _pip(
            [
                "install",
                "--no-cache-dir",
                "--no-deps",
                "--no-build-isolation",
                "--require-hashes",
                "-r",
                str(bootstrap_path),
            ]
        )
    finally:
        if bootstrap_path.exists():
            bootstrap_path.unlink()
    bootstrap_inventory = expected_inventory(baseline, bootstrap_records)
    bootstrap_overrides = tool_names | set(BOOTSTRAP_NAMES)
    assert_inventory(bootstrap_inventory, baseline, "runtime bootstrap", bootstrap_overrides)

    _pip(
        [
            "download",
            "--dest",
            str(artifact_dir),
            "--no-deps",
            "--no-build-isolation",
            "--require-hashes",
            "-r",
            str(Path(lock_path).resolve()),
        ]
    )
    assert_inventory(bootstrap_inventory, baseline, "artifact acquisition", bootstrap_overrides)
    entries = _index_downloads(artifact_dir, records)
    projection, mappings = build_projection(lock_text, records, artifact_dir, entries)
    projection_path = artifact_dir / PROJECTION_NAME
    projection_path.write_bytes(projection)
    _write_json(
        artifact_dir / MANIFEST_NAME,
        {
            "schema": 1,
            "runtimeLockSha256": RUNTIME_LOCK_SHA256,
            "artifacts": entries,
            "offlineProjectionSha256": sha256_path(projection_path),
            "transportMappings": mappings,
        },
    )
    verify_artifacts(artifact_dir, lock_text, records)
    print(json.dumps({"phase": "acquire", "artifacts": len(entries)}, sort_keys=True))


def install(lock_path, artifact_path, baseline_path):
    _require_python()
    lock_text, records = load_runtime_lock(lock_path)
    baseline = load_baseline(baseline_path)
    by_name = _record_map(records)
    bootstrap_records = [by_name[name] for name in BOOTSTRAP_NAMES]
    assert_inventory(
        expected_inventory(baseline, bootstrap_records),
        baseline,
        "pre-install",
        set(TOOL_VERSIONS) | set(BOOTSTRAP_NAMES),
    )
    artifact_dir = Path(artifact_path)
    projection_path = verify_artifacts(artifact_dir, lock_text, records)
    artifact_dir = artifact_dir.resolve()
    _pip(
        [
            "install",
            "--no-cache-dir",
            "--no-index",
            "--find-links={}".format(artifact_dir),
            "--no-deps",
            "--no-build-isolation",
            "--require-hashes",
            "-r",
            str(projection_path),
        ]
    )
    assert_inventory(
        expected_inventory(baseline, records),
        baseline,
        "offline install",
        set(TOOL_VERSIONS) | set(_record_map(records)),
    )
    print(json.dumps({"phase": "install", "requirements": len(records)}, sort_keys=True))


def verify(lock_path, artifact_path, baseline_path):
    _require_python()
    lock_text, records = load_runtime_lock(lock_path)
    baseline = load_baseline(baseline_path)
    verify_artifacts(artifact_path, lock_text, records)
    final_inventory = expected_inventory(baseline, records)
    final_overrides = set(TOOL_VERSIONS) | set(_record_map(records))
    assert_inventory(final_inventory, baseline, "final", final_overrides)
    _pip(["check"])
    assert_inventory(final_inventory, baseline, "post-pip-check", final_overrides)
    print(json.dumps({"phase": "verify", "status": "PASS"}, sort_keys=True))


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="phase", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--baseline", required=True)
    for phase in ("acquire", "install", "verify"):
        phase_parser = subparsers.add_parser(phase)
        phase_parser.add_argument("--lock", required=True)
        phase_parser.add_argument("--artifacts", required=True)
        phase_parser.add_argument("--baseline", required=True)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.phase == "snapshot":
        snapshot(args.baseline)
    elif args.phase == "acquire":
        acquire(args.lock, args.artifacts, args.baseline)
    elif args.phase == "install":
        install(args.lock, args.artifacts, args.baseline)
    else:
        verify(args.lock, args.artifacts, args.baseline)


if __name__ == "__main__":
    try:
        main()
    except ToolchainError as error:
        print("toolchain error: {}".format(error), file=sys.stderr)
        raise SystemExit(1)
