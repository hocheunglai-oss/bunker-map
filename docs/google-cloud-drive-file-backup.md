# Google Cloud Drive File Backup

This backs up Google Drive `Manual Uploads` file contents to Google Cloud Storage. It replaces the local `npm run backup:ccinfo-files` workflow as the dependable business backup.

## Architecture

- Source: Google Drive folder `Manual Uploads` under `GOOGLE_DRIVE_COMPANY_FOLDER_ID`
- Backup target: Google Cloud Storage bucket
- Runner: Cloud Run Job
- Schedule: Cloud Scheduler, weekly at `0 20 * * 6` UTC by default, which is Sunday 04:00 in Hong Kong
- Manifest copy: Google Drive folder `Bunker Map Backups / Drive File Backup Manifests`
- Health check: `/admin/systemhealth` reads the latest Drive manifest

## Required local setup for deployment

Install and authenticate the Google Cloud CLI on the machine used for deployment:

```bash
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID
```

The deploy helper reads these values from environment variables, `.env.local`, or `.google-drive-oauth-token.json`:

```bash
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_DRIVE_REFRESH_TOKEN
GOOGLE_DRIVE_COMPANY_FOLDER_ID
GOOGLE_OAUTH_REDIRECT_URI
GOOGLE_DRIVE_BACKUP_FOLDER_ID
GOOGLE_DRIVE_SHARED_DRIVE_ID
```

If `GOOGLE_DRIVE_REFRESH_TOKEN` is not in `.env.local`, the helper can read it from `.google-drive-oauth-token.json`.

## Deploy or update

```bash
GCP_PROJECT_ID=YOUR_GCP_PROJECT_ID ./scripts/deploy-google-cloud-drive-backup.sh
```

Defaults:

```bash
GCP_REGION=asia-east2
GCS_BUCKET_LOCATION=ASIA-EAST2
GCS_BACKUP_BUCKET=YOUR_PROJECT_ID-bunker-map-drive-file-backups
GCS_BACKUP_PREFIX=ccinfo-drive
DRIVE_FILE_BACKUP_SCHEDULE="0 20 * * 6"
EXECUTE_NOW=1
```

The helper will:

- enable required Google Cloud APIs
- create an Artifact Registry repository
- create a versioned GCS bucket if missing
- create a Cloud Run service account
- create or update Secret Manager secrets
- build the backup container with Cloud Build
- deploy the Cloud Run Job
- create or update the Cloud Scheduler job
- execute the job immediately by default

## Verify

After the first run succeeds:

1. Open Google Cloud Storage and confirm objects exist under `gs://BUCKET/ccinfo-drive/files/`.
2. Confirm the GCS bucket has Object Versioning enabled.
3. Open Google Drive and confirm a new manifest exists under `Bunker Map Backups / Drive File Backup Manifests`.
4. Open `/admin/systemhealth`; `Drive File Content Backup` should become `ok`.

## Operational notes

The backup job skips unchanged files by comparing Drive metadata with GCS object metadata. When a file changes, uploading to the same GCS object name creates a new generation if bucket versioning is enabled.

The job writes `ccinfo-drive/manifests/latest.json` in GCS and also writes a timestamped manifest to Google Drive so the Vercel app can check backup freshness without needing GCS credentials.
