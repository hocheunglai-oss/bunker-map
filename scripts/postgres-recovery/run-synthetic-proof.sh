#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
proof_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fcuno-recovery-image-proof.XXXXXX")"
container_name="fcuno-recovery-proof-$(basename "$proof_root" | tr '[:upper:]' '[:lower:]')"
image_name="fcuno-recovery-compatibility:$(git rev-parse --short=12 HEAD)"
mkdir -m 700 "$proof_root/scratch" "$proof_root/output"
# A Docker-created file owner must equal the fixed non-root uid inside the image.
sudo chown 1000:1000 "$proof_root/scratch" "$proof_root/output"
cleanup() {
  docker inspect --format '{{json .HostConfig}}' "$container_name" > "$proof_root/host-config.json" 2>/dev/null || true
  docker image inspect --format '{{json .}}' "$image_name" > "$proof_root/image.json" 2>/dev/null || true
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  sudo chown -R "$(id -u):$(id -g)" "$proof_root/output" || true
}
trap cleanup EXIT
git rev-parse HEAD HEAD^{tree} > "$proof_root/source.txt"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'evidence=%s\n' "$proof_root" >> "$GITHUB_OUTPUT"; fi
docker build --platform linux/amd64 --file scripts/postgres-recovery/Dockerfile --target compatibility --tag "$image_name" .
docker run --name "$container_name" --platform linux/amd64 --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 96 --shm-size 128m \
  --mount "type=bind,src=$proof_root/scratch,dst=/recovery" \
  --mount "type=bind,src=$proof_root/output,dst=/output" \
  "$image_name"
docker inspect --format '{{json .HostConfig}}' "$container_name" > "$proof_root/host-config.json"
docker image inspect --format '{{json .}}' "$image_name" > "$proof_root/image.json"
sudo chown -R "$(id -u):$(id -g)" "$proof_root/output"
test -s "$proof_root/output/compatibility-proof.json"
printf '%s\n' "Synthetic proof evidence: $proof_root"
