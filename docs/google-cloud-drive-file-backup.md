# Google Cloud Drive File Backup

This copies supported CCINFO file contents under `GOOGLE_DRIVE_COMPANY_FOLDER_ID` to Google Cloud Storage without relying on a local workstation. Root-level backup output and Drive shortcuts are excluded; unsupported Workspace file types fail the run. This job does not copy Supabase Storage media or the daily database JSON. See the [2026-09-24 backup assessment](backup-evaluation-2026-09-24.md) for recovery gaps and verification scope.

## Architecture

- Source: the complete Google Drive folder identified by `GOOGLE_DRIVE_COMPANY_FOLDER_ID`
- Backup target: Google Cloud Storage bucket
- Runner: Cloud Run Job
- Region: `us-central1` by default
- Backup bucket: `US-CENTRAL1` by default, so the first 5 GB-months of Standard storage are eligible for the Google Cloud Storage Always Free limit
- Schedule: primary attempt daily at **02:00 Hong Kong time**, with retry opportunities at **03:00, 04:00, and 05:00** (`0 2-5 * * *`, `Asia/Hong_Kong`). Once a completed, verified backup has been published, later attempts that morning exit without rescanning or uploading.
- Manifest copy: Google Drive folder `Bunker Map Backups / Drive File Backup Manifests`
- Deadline: scheduled attempts stop by **06:00 Hong Kong time**; each attempt is limited to 55 minutes.
- Health check: `/admin/systemhealth` reads recent Drive manifests; the existing daily email check remains at **08:30 Hong Kong time**, after the retry window.

## Required local setup for deployment

Install and authenticate the Google Cloud CLI on the machine used for deployment:

```bash
gcloud auth login
gcloud auth list
```

For initial deployment, the deploy helper reads these values from environment variables, `.env.local`, or `.google-drive-oauth-token.json`:

```bash
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_DRIVE_REFRESH_TOKEN
GOOGLE_DRIVE_COMPANY_FOLDER_ID
GOOGLE_OAUTH_REDIRECT_URI
GOOGLE_DRIVE_BACKUP_FOLDER_ID
GOOGLE_DRIVE_SHARED_DRIVE_ID
```

After the secrets exist in Google Secret Manager, local environment and OAuth token files may be deleted. They are not needed by the scheduled Cloud Run job.

Each stored object name includes the Google Drive file ID. This preserves distinct Drive files even when they have the same folder path and filename.

The source traversal excludes the root-level `Bunker Map Backups` folder so the job does not recursively back up its own manifests.

## Deploy or update

```bash
GCP_PROJECT_ID=YOUR_VERIFIED_FCUNO_GCP_PROJECT_ID \
GCP_DEPLOY_ACCOUNT=YOUR_VERIFIED_ACTIVE_GOOGLE_ACCOUNT \
./scripts/deploy-google-cloud-drive-backup.sh
```

Defaults:

```bash
GCP_REGION=us-central1
GCS_BUCKET_LOCATION=US-CENTRAL1
GCS_BACKUP_BUCKET=YOUR_PROJECT_ID-bunker-map-drive-file-backups
GCS_BACKUP_PREFIX=ccinfo-drive
DRIVE_FILE_BACKUP_SCHEDULE="0 2-5 * * *"
DRIVE_FILE_BACKUP_TIME_ZONE=Asia/Hong_Kong
DRIVE_FILE_BACKUP_TASK_TIMEOUT=3300s
EXECUTE_NOW=0
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
- preserve the existing scheduler name (`bunker-map-drive-file-backup-weekly` by default) and update its schedule, avoiding a second competing schedule
- leave immediate execution off unless `EXECUTE_NOW=1` is explicitly supplied

The helper requires an explicit verified project and account, refuses redacted secrets, and does not change the active machine-wide project. This is a full infrastructure deploy: it updates Secret Manager versions using valid local credentials. Do not use migrated placeholder `.env` files to update production. An existing deployment can instead be updated using its existing Secret Manager references after checking its exact project, bucket, service account, and job configuration.

Cloud Scheduler invokes `jobs:run`, whose acknowledgement means only that an execution was accepted. It does **not** certify backup completion. Scheduler HTTP retries and Cloud Run task retries are disabled; the four scheduled opportunities supply bounded retry attempts instead. A generation-conditional GCS lease prevents overlapping or duplicated deliveries from copying files concurrently. A crashed execution's lease expires after 56 minutes.

The runner rejects scheduled starts outside 02:00–06:00 and enforces an absolute 06:00 cutoff even if an invocation was delayed. Changing the schedule/time zone requires coordinating the health-check policy; the deploy helper rejects a mismatched schedule.

For an explicitly authorized manual recovery outside this window, use an execution-only override (this does not change the next scheduled run):

```bash
gcloud run jobs execute bunker-map-drive-file-backup \
  --project YOUR_VERIFIED_FCUNO_GCP_PROJECT_ID \
  --account YOUR_VERIFIED_ACTIVE_GOOGLE_ACCOUNT --region us-central1 \
  --update-env-vars DRIVE_FILE_BACKUP_ALLOW_OUTSIDE_WINDOW=1 --wait
```

## Verify

After the Cloud Run **execution** completes successfully (not merely the scheduler request):

1. Open Google Cloud Storage and confirm objects exist under `gs://BUCKET/ccinfo-drive/files/`.
2. Confirm the GCS bucket has Object Versioning enabled.
3. Open Google Drive and confirm a new manifest exists under `Bunker Map Backups / Drive File Backup Manifests`. Check `status: succeeded`, a real `finishedAt`, `verification.status: verified`, `verification.checkedFiles` equal to `counts.totalFiles`, and `counts.failed: 0`. Every covered file must have a GCS object name and generation.
4. Confirm `ccinfo-drive/manifests/latest-successful.json` in GCS identifies this run and includes a verified Drive publication receipt. A failed or running attempt must not advance this pointer.
5. Open `/admin/systemhealth`; confirm current eligible files are covered. A newly uploaded file after the scheduled snapshot can legitimately remain **pending backup** until its next scheduled deadline.

## Operational notes

The backup job skips unchanged files by comparing Drive metadata with GCS object metadata, an existing generation and checksum, and (for ordinary files) size and source MD5. New uploads use CRC32C stream validation and must pass the same metadata checks afterward. Unsupported Workspace types are recorded as failures, not treated as backed-up files. When a file changes, uploading to the same GCS object name creates a new generation; versioning must be enabled.

Before scanning, the job publishes a `running` manifest to Google Drive; it updates that same manifest to `succeeded` or `failed`. Interruption leaves an unverified running marker. Caught enumeration, object, and publication errors are recorded when the destination is reachable. If Google Drive itself is unavailable, health falls back to the overdue last success rather than inventing a successful run.

The job writes timestamped manifests and `ccinfo-drive/manifests/latest.json` for the latest completed attempt in GCS. `latest-successful.json` advances only after all object checks pass and the completed Drive manifest is read back and verified. It retains the previous success after a failed attempt. These are file-content backup manifests, not the database backup retention policy: the existing two verified database backups are unchanged, and this job does not delete file objects or older generations.

The live bucket policy checked on 2026-09-24 has Object Versioning enabled,
a lifecycle `Delete` rule with `age: 30` and `isLive: false`, and a seven-day
soft-delete duration (`604800` seconds). The lifecycle age is measured from a
generation's creation, not when it is replaced. A generation already over 30
days old can therefore become eligible for deletion as soon as it becomes
noncurrent; this is not a promise of 30 days' history after every replacement.
Soft delete provides a separate seven-day recovery interval after an eligible
generation is deleted. Lifecycle execution is asynchronous, not an exact
deletion-time guarantee. See Google's [lifecycle conditions](https://docs.cloud.google.com/storage/docs/lifecycle#age)
and [soft-delete documentation](https://docs.cloud.google.com/storage/docs/soft-delete).
The deploy helper enables versioning but does not encode this live lifecycle
or soft-delete policy; check both explicitly during recovery or redeployment.

System Health reads the latest manifest and shows estimated current backup size against the 5 GB Cloud Storage Always Free storage limit. It warns at 80% usage. Google Cloud Billing has a separate budget alert; inspect its live amount and scope rather than treating the storage indicator or an alert as a hard spending limit.

The size in a manifest estimates current source bytes, not billable usage including older or soft-deleted GCS generations, manifests, or abandoned live paths after renames. Verify actual bucket storage and billing before concluding a project is under the free allocation. Noncurrent-only lifecycle cleanup does not remove those abandoned live objects.

Scheduler retry semantics and task timeout behavior are documented by Google: [Cloud Scheduler retries](https://docs.cloud.google.com/scheduler/docs/configuring/retry-jobs), [Cloud Run task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout), and [GCS generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).
