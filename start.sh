#!/usr/bin/env bash
# WALLSPECTRUM LIVE launcher for macOS / Linux
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node 18+ from https://nodejs.org" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --omit=dev || { echo "[ERROR] npm install failed" >&2; exit 1; }
fi

PORT="${PORT:-3000}"
export PORT
echo "Starting WALLSPECTRUM on http://localhost:$PORT  (Ctrl+C to stop)"

# open browser after the server has had a moment to start
( sleep 3
  if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"
  fi ) >/dev/null 2>&1 &

exec node server.js
