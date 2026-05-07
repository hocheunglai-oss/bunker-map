#!/usr/bin/env sh
set -eu

if [ ! -f ".env.cn" ]; then
  echo "Missing .env.cn. Copy .env.cn.example to .env.cn and fill values."
  exit 1
fi

echo "Building and starting CN stack..."
docker compose -f docker-compose.cn.yml up -d --build

echo "Done. Containers:"
docker compose -f docker-compose.cn.yml ps
