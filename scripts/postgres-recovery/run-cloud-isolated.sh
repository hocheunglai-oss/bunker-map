#!/usr/bin/env bash
set -euo pipefail
umask 077
# The downloader creates these exact private build-owned directories. No user
# path, database URI, environment forwarding, Docker socket, or source key.
work=/workspace/.fcuno-postgres-recovery
name=fcuno-private-recovery
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
result=0
docker run --name "$name" --platform linux/amd64 --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 96 --shm-size 128m \
  --mount "type=bind,src=$work/input,dst=/input,readonly" \
  --mount "type=bind,src=$work/scratch,dst=/recovery" \
  --mount "type=bind,src=$work/output,dst=/output" \
  fcuno-private-recovery || result=$?
# Capture only these fixed primitives on failure, never .Error, environment,
# command arguments or logs. Inspection happens BEFORE the cleanup trap.
state=null
if inspected=$(docker inspect --format '{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}}' "$name" 2>/dev/null); then
  state=$inspected
fi
printf '{"schema":"fcuno.private-recovery-host-outcome/v1","dockerRunExitCode":%d,"state":%s}\n' "$result" "$state" > "$work/host-outcome.json"
# Full inspection is private success-only containment input, as before.
if [ "$result" -eq 0 ]; then
  docker inspect --format '{{json .}}' "$name" > "$work/host-inspection.json"
fi
exit "$result"
