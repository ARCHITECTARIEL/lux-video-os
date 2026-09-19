#!/usr/bin/env bash
# Run on the VPS itself (as the deploy user, with sudo for the systemctl
# calls) to pull the latest main and restart both services. Not run from
# CI in this setup -- see the header comment for why once a GitHub Actions
# deploy workflow exists, it should just SSH in and invoke this script
# rather than reimplementing these steps.
set -euo pipefail

REPO_DIR="${VIDEO_OS_REPO_DIR:-/opt/video-os}"
BRANCH="${VIDEO_OS_DEPLOY_BRANCH:-main}"

cd "$REPO_DIR"

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Installing dependencies"
# Not --omit=dev: drizzle-kit (used below for migrations) is a devDependency,
# and this is a private single-tenant box where the extra install size isn't
# worth the complexity of a separate migration-only install step.
npm ci

# ffmpeg-static's postinstall script downloads the real ffmpeg binary for
# this host's OS/arch. If it was skipped (npm config with scripts disabled,
# a partial install, etc.), the render worker would fail on its first real
# job instead of at deploy time -- so verify it here instead.
FFMPEG_BIN="$(node -p "require('ffmpeg-static')" 2>/dev/null || true)"
if [ -z "$FFMPEG_BIN" ] || [ ! -s "$FFMPEG_BIN" ]; then
  echo "==> ffmpeg-static binary missing, running its installer directly"
  node node_modules/ffmpeg-static/install.js
fi

echo "==> Applying database migrations"
npm run db:migrate

echo "==> Restarting services"
sudo systemctl restart video-os-server.service
sudo systemctl restart video-os-worker.service

echo "==> Status"
sudo systemctl --no-pager status video-os-server.service video-os-worker.service
