#!/usr/bin/env bash

# Return the age of the current main commit in seconds, or fail closed when
# the workflow did not supply a usable commit time.
main_head_age_seconds() {
  local main_head_epoch="${MAIN_HEAD_EPOCH:-}"
  local now_epoch="${NOW_EPOCH:-$(date +%s)}"
  [[ "$now_epoch" =~ ^[0-9]+$ ]] || return 1

  local push_epoch
  if ! push_epoch=$(node - "$main_head_epoch" 2>/dev/null <<'NODE'
const raw = process.argv[2] || '';
let seconds;
if (/^[0-9]+$/.test(raw)) seconds = Number(raw);
else seconds = Date.parse(raw) / 1000;
if (!Number.isFinite(seconds) || seconds < 0) process.exit(1);
process.stdout.write(String(Math.floor(seconds)));
NODE
  ); then
    return 1
  fi

  if (( push_epoch > now_epoch )); then return 1; fi
  local age_seconds=$((now_epoch - push_epoch))
  printf '%s' "$age_seconds"
}

# The pre-health-route deployment served its SPA for /api/health. Only the
# tracked shell may receive grace. Ignore CRLF versus LF line endings, which
# can differ between a checked-out workflow file and the hosted response.
legacy_spa_fallback() {
  local index_file
  index_file="$(dirname "${BASH_SOURCE[0]}")/../public/index.html"
  [[ -f "$index_file" && -f "$1" ]] || return 1
  cmp -s -- "$1" "$index_file" && return 0
  diff -q --strip-trailing-cr -- "$1" "$index_file" >/dev/null 2>&1 && return 0

  # Log only a fingerprint, never the response body. This distinguishes an
  # unexpected app version from a proxy/login page on the next failed run.
  local body_sha body_bytes
  body_sha="$(sha256sum "$1")" || return 1
  body_bytes="$(wc -c < "$1")" || return 1
  printf '::warning::Unrecognized HTML health response (sha256=%s, bytes=%s); grace denied.\n' "${body_sha%% *}" "$body_bytes" >&2
  return 1
}
