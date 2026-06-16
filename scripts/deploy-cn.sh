#!/usr/bin/env sh
set -eu

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"

if [ ! -f ".env.cn" ]; then
  echo "Missing .env.cn. Copy .env.cn.example to .env.cn and fill values."
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
  echo "Deploy refused: current branch is '$current_branch', expected '$BRANCH'."
  exit 1
fi

echo "Fetching latest $REMOTE/$BRANCH..."
git fetch "$REMOTE" "$BRANCH"

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "$REMOTE/$BRANCH")"
if [ "$local_sha" != "$remote_sha" ]; then
  echo "Deploy refused: local HEAD is not the latest pushed $REMOTE/$BRANCH."
  echo "Local:  $local_sha"
  echo "Remote: $remote_sha"
  echo "Run: git pull --ff-only $REMOTE $BRANCH"
  exit 1
fi

echo "Running release check..."
npm run release:check

export DEPLOY_COMMIT="$local_sha"
export DEPLOY_BRANCH="$BRANCH"
export DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Building CN image for $DEPLOY_BRANCH@$DEPLOY_COMMIT..."
docker compose -f docker-compose.cn.yml build --pull --no-cache bunker-map-cn

echo "Starting one fresh CN stack..."
docker compose -f docker-compose.cn.yml up -d --force-recreate --remove-orphans

echo "Done. Containers:"
docker compose -f docker-compose.cn.yml ps

echo "Deployed commit: $DEPLOY_COMMIT"
