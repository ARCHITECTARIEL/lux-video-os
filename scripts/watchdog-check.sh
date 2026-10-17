#!/usr/bin/env bash

set -euo pipefail

error() {
  printf '::error::%s\n' "$*" >&2
}

warning() {
  printf '::warning::%s\n' "$*" >&2
}

base_url="${VIDEO_OS_BASE_URL:-}"
cron_secret="${VIDEO_OS_CRON_SECRET:-}"
expected_git_sha="${EXPECTED_GIT_SHA:-}"
curl_bin="${CURL_BIN:-curl}"
source "$(dirname "${BASH_SOURCE[0]}")/main-head-grace.sh"

if [[ -z "$base_url" || -z "$cron_secret" ]]; then
  error 'Watchdog configuration is incomplete. Configure VIDEO_OS_BASE_URL and VIDEO_OS_CRON_SECRET.'
  exit 1
fi

if [[ -z "$expected_git_sha" ]]; then
  error 'EXPECTED_GIT_SHA is required to bind the sweep to the current main commit.'
  exit 1
fi

base_url="${base_url%/}"
work_dir="$(mktemp -d)" || {
  error 'Could not create temporary storage for watchdog response validation.'
  exit 1
}
trap 'rm -rf "$work_dir"' EXIT

HTTP_STATUS=''

request() {
  local method="$1"
  local label="$2"
  local url="$3"
  local prefix="$4"
  shift 4

  local status
  if ! status=$("$curl_bin" \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 60 \
    --request "$method" \
    --output "$work_dir/$prefix.body" \
    --dump-header "$work_dir/$prefix.headers" \
    --write-out '%{http_code}' \
    "$@" \
    "$url"); then
    error "$label request could not reach the configured endpoint."
    return 1
  fi

  if [[ ! "$status" =~ ^[0-9]{3}$ ]]; then
    error "$label request returned an invalid HTTP status."
    return 1
  fi

  HTTP_STATUS="$status"
}

content_type() {
  awk 'tolower($1) == "content-type:" { value = tolower($2) } END { gsub(/\r/, "", value); print value }' "$1"
}

require_json_content_type() {
  local label="$1"
  local headers="$2"
  local reported_type
  reported_type="$(content_type "$headers")"
  if [[ "$reported_type" != application/json* ]]; then
    error "$label response must use an application/json content type."
    return 1
  fi
}

# Health is intentionally first: do not invoke a mutating admin operation on
# an unhealthy deployment or on a deployment that is not the current main SHA.
request GET 'Health' "$base_url/api/health" health || exit 1
if [[ "$HTTP_STATUS" != '200' ]]; then
  error "Health request failed with HTTP $HTTP_STATUS."
  exit 1
fi
health_type="$(content_type "$work_dir/health.headers")"
if [[ "$health_type" == text/html* ]] && legacy_spa_fallback "$work_dir/health.body"; then
  grace_age=''
  if grace_age="$(main_head_age_seconds)" && (( grace_age <= 1200 )); then
    warning 'Legacy HTML health response during the 20-minute deployment grace period; skipping this sweep.'
    exit 0
  fi
fi
require_json_content_type 'Health' "$work_dir/health.headers" || exit 1

health_fields=''
if ! health_fields=$(node - "$work_dir/health.body" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value)) process.exit(1);
if (typeof value.status !== 'string' || typeof value.gitSha !== 'string') process.exit(1);
if (!/^[0-9a-f]{7,40}$/i.test(value.gitSha)) process.exit(1);
const staleOnly = value.status === 'degraded'
  && value.checks?.watchdog?.ok === false
  && value.checks?.db?.ok === true
  && value.checks?.blob?.ok === true
  && value.checks?.provider?.ok === true;
const sweepAt = Date.parse(value.checks?.watchdog?.lastSweepAt);
const nowEpoch = Number(process.env.NOW_EPOCH || Math.floor(Date.now() / 1000));
const sweepAgeSeconds = nowEpoch - Math.floor(sweepAt / 1000);
// Leave 20 minutes to recover before the 45-minute heartbeat contract expires.
const fallbackNotNeeded = value.checks?.watchdog?.ok === true
  && Number.isFinite(sweepAgeSeconds) && sweepAgeSeconds >= 0 && sweepAgeSeconds <= 25 * 60;
process.stdout.write(`${value.status}\n${value.gitSha}\n${fallbackNotNeeded}\n${staleOnly}\n`);
NODE
); then
  error 'Health response was not valid JSON with status and gitSha fields.'
  exit 1
fi

health_status="$(printf '%s\n' "$health_fields" | sed -n '1p')"
deployed_git_sha="$(printf '%s\n' "$health_fields" | sed -n '2p')"
fallback_not_needed="$(printf '%s\n' "$health_fields" | sed -n '3p')"
stale_only="$(printf '%s\n' "$health_fields" | sed -n '4p')"

if [[ "$health_status" != 'ok' && "$stale_only" != 'true' ]]; then
  error "Health response reported status '$health_status'; status must be ok before a watchdog sweep."
  exit 1
fi

if [[ "$deployed_git_sha" != "$expected_git_sha" ]]; then
  age_seconds=''
  if ! age_seconds="$(main_head_age_seconds)"; then
    error 'The deployed SHA differs from main and MAIN_HEAD_EPOCH is missing or invalid.'
    exit 1
  fi

  if (( age_seconds <= 1200 )); then
    warning "Production is still on $deployed_git_sha while main is $expected_git_sha; allowing the 20-minute deployment grace period and skipping this sweep."
    exit 0
  fi

  error "Production SHA $deployed_git_sha does not match main SHA $expected_git_sha after the 20-minute deployment grace period."
  exit 1
fi

# Native Vercel Cron is the primary 15-minute clock. GitHub's delayed
# schedule is a fallback; do not run a second sweep while the first is fresh.
if [[ "${WATCHDOG_FALLBACK_ONLY:-false}" == 'true' && "$fallback_not_needed" == 'true' ]]; then
  printf 'Watchdog heartbeat is current; GitHub fallback skipped.\n'
  exit 0
fi

request POST 'Watchdog sweep' "$base_url/api/video-os-lite/admin?operation=watchdog-sweep" sweep \
  --header "Authorization: Bearer $cron_secret" \
  --header 'Content-Type: application/json' \
  --data '{}' || exit 1
if [[ "$HTTP_STATUS" != '200' ]]; then
  error "Watchdog sweep request failed with HTTP $HTTP_STATUS."
  exit 1
fi
require_json_content_type 'Watchdog sweep' "$work_dir/sweep.headers" || exit 1
if ! node - "$work_dir/sweep.body" >/dev/null 2>&1 <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value || value.ok !== true || !value.sweep || typeof value.sweep !== 'object' || Array.isArray(value.sweep)) process.exit(1);
NODE
then
  error 'Watchdog sweep returned HTTP 200 without a valid successful JSON result.'
  exit 1
fi

request GET 'Hosted caption route' "$base_url/assets/showcase/owner-kristian.vtt" caption || exit 1
caption_type="$(content_type "$work_dir/caption.headers")"
caption_body="$(cat "$work_dir/caption.body")"
caption_body="${caption_body#$'\357\273\277'}"
if [[ "$HTTP_STATUS" != '200' || "$caption_type" != text/vtt* || "$caption_body" != WEBVTT* ]]; then
  error 'Hosted caption route failed strict status, content-type, or WEBVTT validation.'
  exit 1
fi

request GET 'Hosted workspace route' "$base_url/api/video-os-lite/workspace" workspace || exit 1
if [[ "$HTTP_STATUS" != '401' ]]; then
  error "Hosted workspace route returned HTTP $HTTP_STATUS; expected 401."
  exit 1
fi
require_json_content_type 'Hosted workspace route' "$work_dir/workspace.headers" || exit 1
if ! node - "$work_dir/workspace.body" >/dev/null 2>&1 <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value || value.ok !== false || value.code !== 'sign_in_required') process.exit(1);
NODE
then
  error 'Hosted workspace route did not return the strict unauthenticated JSON contract.'
  exit 1
fi

request GET 'Unknown API route' "$base_url/api/zz-unknown" unknown || exit 1
if [[ "$HTTP_STATUS" != '404' ]]; then
  error "Unknown API route returned HTTP $HTTP_STATUS; expected 404."
  exit 1
fi
require_json_content_type 'Unknown API route' "$work_dir/unknown.headers" || exit 1
if ! node - "$work_dir/unknown.body" >/dev/null 2>&1 <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value || value.ok !== false || value.code !== 'not_found' || value.path !== '/api/zz-unknown') process.exit(1);
NODE
then
  error 'Unknown API route did not return the strict JSON 404 contract.'
  exit 1
fi

printf 'Watchdog check passed for main SHA %s.\n' "$expected_git_sha"
