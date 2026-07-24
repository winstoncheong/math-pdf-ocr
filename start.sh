#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

# Kill any existing uvicorn/server processes on this port
existing=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$existing" ]; then
  echo "Killing existing server on port $PORT (PID: $existing)"
  kill $existing 2>/dev/null || true
  sleep 1
  # Force kill if still alive
  kill -9 $(lsof -ti :"$PORT" 2>/dev/null) 2>/dev/null || true
fi

cd "$(dirname "$0")"
exec uv run python run.py --reload --host "$HOST" --port "$PORT" "$@"
