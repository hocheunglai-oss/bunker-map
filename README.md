# Bunker Map

A Next.js app for viewing bunker fuel prices on a map, managing port prices, and generating a Taiwan price report.

## Main Pages

- `/` - bunker map homepage
- `/reports/taiwan` - Taiwan posted price report
- `/admin/pricesetter` - admin page for updating port prices
- `/admin/taiwanremarks` - admin page for Taiwan report remarks

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000)

## Build

To create a production build:

```bash
npm run build
```

## Environment Variables

Create a `.env.local` file with:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Tech Stack

- Next.js
- React
- TypeScript
- Supabase
- Leaflet / React Leaflet

## Deployment

This project can be deployed on Vercel. Pushing to the connected GitHub repository will trigger a new deployment.

## Hosted Backups

Vercel runs `/api/backups/bunker-map-drive` weekly at `0 19 * * 6` UTC, which is Sunday 03:00 in Hong Kong. The route uploads a database, Google Contacts, and Google Calendar JSON backup to Google Drive and keeps the latest 2 files. Administrators can also use `BACK UP NOW` from System Health.

The backup covers Supabase app data and CCINFO file metadata. Uploaded CCINFO file contents are handled by the Google Cloud Drive file backup job once deployed. See [docs/backup-restore-runbook.md](docs/backup-restore-runbook.md) and [docs/google-cloud-drive-file-backup.md](docs/google-cloud-drive-file-backup.md).

Required production environment variables:

```bash
CRON_SECRET=your_cron_secret
GOOGLE_OAUTH_CLIENT_ID=your_google_oauth_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_DRIVE_REFRESH_TOKEN=your_google_drive_refresh_token
GOOGLE_DRIVE_COMPANY_FOLDER_ID=your_google_drive_folder_id
# Optional override:
GOOGLE_DRIVE_BACKUP_FOLDER_ID=your_backup_root_folder_id
GOOGLE_DRIVE_SHARED_DRIVE_ID=your_shared_drive_id
```

## System Health Alerts

Vercel runs `/api/admin/system-health/notify` daily at `30 0 * * *` UTC, which is 08:30 in Hong Kong. It sends an email only when the System Health status is `warning` or `error`.

Recipients come from `SYSTEM_HEALTH_EMAIL_RECIPIENTS`; if that is not set, the app falls back to `EVENT_CALENDAR_EMAIL_RECIPIENTS`.

Before relying on production, run:

```bash
npm run release:check
```

The live app exposes `/api/deploy-info` so the deployed commit can be compared
with `git rev-parse origin/main`.
