# China Access Plan (Practical)

This app can work in Mainland China, but reliability is not controlled by code alone when hosted only on Vercel.

## What actually works

1. Keep Vercel for global traffic.
2. Add a China-friendly mirror deployment (Hong Kong / Singapore edge first, or Mainland hosting).
3. Point a China-facing domain to the mirror.

## Fastest route (no full re-architecture)

1. Create a second deployment target for this same repo:
   - Option A: Hong Kong/Singapore VM + Docker (fastest to start)
   - Option B: Mainland cloud + ICP filing (most reliable long term)
2. Use a China CDN in front of that target.
3. Use a separate China-facing hostname (for example `cn.yourdomain.com`).
4. Keep existing Vercel hostname for global users.

## Important notes

- If you need stable Mainland performance, ICP filing is usually required for Mainland-hosted public web.
- `*.vercel.app` can be unstable/inaccessible in some Mainland networks.
- This project itself is already compatible with dual-host deployment.

## Suggested next actions

1. Decide mirror target:
   - `HK/SG VM now` (fast)
   - `Mainland + ICP` (best long-term)
2. I can add Docker + Nginx production files in this repo next, then push.
3. I can also add an environment-based banner/redirect so China users are routed to the CN hostname automatically.
