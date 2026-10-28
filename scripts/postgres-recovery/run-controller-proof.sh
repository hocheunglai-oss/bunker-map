#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(git rev-parse --show-toplevel)"
proof_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fcuno-recovery-controller-proof.XXXXXX")"
proof_id="$(basename "$proof_root" | tr '[:upper:]' '[:lower:]')"
source_name="fcuno-source-$proof_id"
recovery_name="fcuno-restore-$proof_id"
mkdir -m 700 "$proof_root/source" "$proof_root/input" "$proof_root/scratch" "$proof_root/output" "$proof_root/tls"
# Synthetic one-use key only, never a production credential or uploaded artifact.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=db.gglyugbrnyvyfktgwert.supabase.co' \
  -addext 'subjectAltName=DNS:db.gglyugbrnyvyfktgwert.supabase.co' \
  -keyout "$proof_root/tls/server.key" -out "$proof_root/tls/server.crt" >/dev/null 2>&1
sudo chown -R 1000:1000 "$proof_root/source" "$proof_root/input" "$proof_root/scratch" "$proof_root/output" "$proof_root/tls"
cleanup() {
  docker inspect --format '{{json .}}' "$recovery_name" > "$proof_root/host-inspection.json" 2>/dev/null || true
  docker rm -f "$source_name" "$recovery_name" >/dev/null 2>&1 || true
  sudo chown -R "$(id -u):$(id -g)" "$proof_root/output" || true
}
trap cleanup EXIT
git rev-parse HEAD HEAD^{tree} > "$proof_root/source.txt"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'evidence=%s\n' "$proof_root" >> "$GITHUB_OUTPUT"; fi
docker build --platform linux/amd64 --file scripts/postgres-recovery/Dockerfile --target native-controller-proof --tag "fcuno-native-proof:$proof_id" .
docker build --platform linux/amd64 --file scripts/postgres-recovery/Dockerfile --target recovery --tag "fcuno-recovery:$proof_id" .
docker run --name "$source_name" --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --memory 2g --memory-swap 2g --cpus 2 --pids-limit 96 --shm-size 128m \
  --mount "type=bind,src=$proof_root/source,dst=/recovery" --mount "type=bind,src=$proof_root/input,dst=/output" \
  --mount "type=bind,src=$proof_root/tls,dst=/fixture-tls,readonly" "fcuno-native-proof:$proof_id"
docker run --name "$recovery_name" --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --memory 2g --memory-swap 2g --cpus 2 --pids-limit 96 --shm-size 128m \
  --mount "type=bind,src=$proof_root/input,dst=/input,readonly" --mount "type=bind,src=$proof_root/scratch,dst=/recovery" \
  --mount "type=bind,src=$proof_root/output,dst=/output" "fcuno-recovery:$proof_id"
test -s "$proof_root/output/recovery.json"
docker inspect --format '{{json .}}' "$recovery_name" > "$proof_root/host-inspection.json"
sudo chown -R "$(id -u):$(id -g)" "$proof_root/output"
