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

if [[ "$status" == '503' ]]; then
  error 'Heartbeat health returned HTTP 503.'
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

health_status=''
if ! health_status=$(node - "$work_dir/health.body" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!['ok', 'degraded'].includes(value?.status)) process.exit(1);
process.stdout.write(value.status);
NODE
); then
  error 'Heartbeat health response has no valid non-failing status.'
  exit 1
fi
printf 'Heartbeat health is %s.\n' "$health_status"
