#!/usr/bin/env bash

set -euo pipefail

error() {
  printf '::error::%s\n' "$*" >&2
}

warning() {
  printf '::warning::%s\n' "$*" >&2
}

base_url="${VIDEO_OS_BASE_URL:-}"
curl_bin="${CURL_BIN:-curl}"
source "$(dirname "${BASH_SOURCE[0]}")/main-head-grace.sh"

max_age_seconds=2700

if [[ -z "$base_url" ]]; then
  error 'Heartbeat configuration is incomplete. Configure VIDEO_OS_BASE_URL.'
  exit 1
fi

base_url="${base_url%/}"
work_dir="$(mktemp -d)" || {
  error 'Could not create temporary storage for heartbeat response validation.'
  exit 1
}
trap 'rm -rf "$work_dir"' EXIT

if ! status=$("$curl_bin" \
  --silent \
  --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --request GET \
  --output "$work_dir/health.body" \
  --dump-header "$work_dir/health.headers" \
  --write-out '%{http_code}' \
  "$base_url/api/health"); then
  error 'Heartbeat request could not reach the configured health endpoint.'
  exit 1
fi

if [[ "$status" != '200' ]]; then
  error "Heartbeat health request failed with HTTP $status."
  exit 1
fi

content_type="$(awk 'tolower($1) == "content-type:" { value = tolower($2) } END { gsub(/\r/, "", value); print value }' "$work_dir/health.headers")"
if [[ "$content_type" == text/html* ]] && legacy_spa_fallback "$work_dir/health.body"; then
  grace_age=''
  if grace_age="$(main_head_age_seconds)" && (( grace_age <= 1200 )); then
    warning 'Legacy HTML health response during the 20-minute deployment grace period; skipping this heartbeat check.'
    exit 0
  fi
fi
if [[ "$content_type" != application/json* ]]; then
  error 'Heartbeat health response must use an application/json content type.'
  exit 1
fi

last_sweep_epoch=''
if ! last_sweep_epoch=$(node - "$work_dir/health.body" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lastSweepAt = value?.checks?.watchdog?.lastSweepAt;
if (typeof lastSweepAt !== 'string' || lastSweepAt.length === 0) process.exit(1);
const milliseconds = Date.parse(lastSweepAt);
if (!Number.isFinite(milliseconds)) process.exit(1);
process.stdout.write(String(Math.floor(milliseconds / 1000)));
NODE
); then
  error 'Watchdog heartbeat is unconfigured or missing from checks.watchdog.lastSweepAt.'
  exit 1
fi

now_epoch="${NOW_EPOCH:-$(date +%s)}"
if [[ ! "$now_epoch" =~ ^[0-9]+$ ]]; then
  error 'NOW_EPOCH must be Unix seconds when supplied.'
  exit 1
fi

age_seconds=$((now_epoch - last_sweep_epoch))
if (( age_seconds < 0 )); then
  error 'Watchdog heartbeat timestamp is in the future.'
  exit 1
fi

if (( age_seconds > max_age_seconds )); then
  age_minutes=$((age_seconds / 60))
  error "Watchdog heartbeat is stale (${age_minutes} minutes old; maximum is 45 minutes)."
  exit 1
fi

age_minutes=$((age_seconds / 60))
printf 'Watchdog heartbeat is current (%s minutes old).\n' "$age_minutes"
