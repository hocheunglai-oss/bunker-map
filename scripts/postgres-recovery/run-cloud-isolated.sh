#!/usr/bin/env bash
set -euo pipefail
umask 077
# The downloader creates these exact private build-owned directories. No user
# path, database URI, environment forwarding, Docker socket, or source key.
work=/workspace/.fcuno-postgres-recovery
name=fcuno-private-recovery
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --name "$name" --platform linux/amd64 --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 96 --shm-size 128m \
  --mount "type=bind,src=$work/input,dst=/input,readonly" \
  --mount "type=bind,src=$work/scratch,dst=/recovery" \
  --mount "type=bind,src=$work/output,dst=/output" \
  fcuno-private-recovery
docker inspect --format '{{json .}}' "$name" > "$work/host-inspection.json"
