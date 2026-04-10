#!/bin/sh

set -eu

PORT="${1:-3000}"

PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"

if [ -n "$PIDS" ]; then
  echo "Stopping process on port $PORT: $PIDS"
  kill $PIDS
  sleep 1
fi

echo "Starting Next.js dev server on port $PORT"
exec npm run dev -- --port "$PORT"
