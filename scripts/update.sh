#!/usr/bin/env bash
# Get the latest code, install packages and restart the site (for Codespaces or a dev machine).
set -e
cd "$(dirname "$0")/.."
echo "Stopping the running site..."
pkill -f "node .*src/server.js" || true
# npm can rewrite the lockfile; discard that so the pull isn't blocked.
git checkout -- package-lock.json 2>/dev/null || true
echo "Getting the latest code..."
git pull --ff-only
echo "Installing packages..."
npm ci --no-audit --no-fund
echo "Starting the site..."
npm start
