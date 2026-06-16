# China Deploy Runbook

This runbook adds a China-facing mirror deployment while keeping Vercel for global traffic.

## 1) Prepare env file

```bash
cp .env.cn.example .env.cn
```

Edit `.env.cn` and set:

- `NEXT_PUBLIC_SITE_URL` to your China-facing domain
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 2) Deploy to your China-friendly server

On your server (Hong Kong, Singapore, or Mainland cloud):

```bash
sh scripts/deploy-cn.sh
```

The deploy script now refuses to publish unless the server checkout is exactly
the latest pushed `origin/main`. It runs the release check, rebuilds the app
image without Docker cache, and recreates the running containers so only one
fresh app version is served.

This starts:

- `bunker-map-cn` (Next.js app on port 3000)
- `bunker-map-nginx` (public port 80 reverse proxy)

After deployment, confirm the live commit:

```bash
curl https://cn.yourdomain.com/api/deploy-info
```

The `commit` value should match:

```bash
git rev-parse origin/main
```

## 3) DNS

Point `cn.yourdomain.com` to this server.

## 4) Optional auto redirect for China users

Enable in your global environment (for Vercel/global app):

```bash
ENABLE_CN_REDIRECT=true
NEXT_PUBLIC_CN_SITE_URL=https://cn.yourdomain.com
```

The middleware uses `x-vercel-ip-country=CN` and redirects to the CN host.

## 5) TLS

Terminate TLS at your preferred layer:

- Nginx + certbot, or
- cloud load balancer, or
- China CDN edge certificate.

## Notes

- Mainland reliability is highest with ICP-compliant setup.
- This repo change does not remove your existing Vercel flow.
