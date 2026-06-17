#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

read_env() {
  local key="$1"
  node - "$key" <<'NODE'
const fs = require("fs")
const key = process.argv[2]

function parseEnvFile(path) {
  if (!fs.existsSync(path)) return {}
  return Object.fromEntries(
    fs.readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=")
        if (index === -1) return ["", ""]
        return [
          line.slice(0, index).trim(),
          line.slice(index + 1).trim().replace(/^['"]|['"]$/g, ""),
        ]
      })
      .filter(([name]) => name)
  )
}

let value = process.env[key] || parseEnvFile(".env.local")[key] || ""
if (!value && key === "GOOGLE_DRIVE_REFRESH_TOKEN" && fs.existsSync(".google-drive-oauth-token.json")) {
  value = JSON.parse(fs.readFileSync(".google-drive-oauth-token.json", "utf8")).refresh_token || ""
}
process.stdout.write(value)
NODE
}

require_value() {
  local key="$1"
  local value
  value="$(read_env "$key")"
  if [[ -z "$value" ]]; then
    echo "Missing required value: $key" >&2
    exit 1
  fi
  printf "%s" "$value"
}

upsert_secret() {
  local secret_name="$1"
  local secret_value="$2"

  if [[ -z "$secret_value" ]]; then
    echo "Refusing to create empty secret: $secret_name" >&2
    exit 1
  fi

  if gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    printf "%s" "$secret_value" | gcloud secrets versions add "$secret_name" --project "$PROJECT_ID" --data-file=- >/dev/null
  else
    printf "%s" "$secret_value" | gcloud secrets create "$secret_name" --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
  fi
}

append_env_var() {
  local key="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    return
  fi

  if [[ -z "$JOB_ENV_VARS" ]]; then
    JOB_ENV_VARS="${key}=${value}"
  else
    JOB_ENV_VARS="${JOB_ENV_VARS},${key}=${value}"
  fi
}

require_command gcloud
require_command git
require_command node

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

REGION="${GCP_REGION:-us-central1}"
SCHEDULER_LOCATION="${GCP_SCHEDULER_LOCATION:-$REGION}"
BUCKET_LOCATION="${GCS_BUCKET_LOCATION:-US-CENTRAL1}"
GCS_BACKUP_BUCKET="${GCS_BACKUP_BUCKET:-${PROJECT_ID}-bunker-map-drive-file-backups}"
GCS_BACKUP_PREFIX="${GCS_BACKUP_PREFIX:-ccinfo-drive}"
ARTIFACT_REPO="${GCP_ARTIFACT_REPO:-bunker-map}"
JOB_NAME="${DRIVE_FILE_BACKUP_JOB_NAME:-bunker-map-drive-file-backup}"
SCHEDULER_NAME="${DRIVE_FILE_BACKUP_SCHEDULER_NAME:-${JOB_NAME}-weekly}"
SCHEDULE="${DRIVE_FILE_BACKUP_SCHEDULE:-0 20 * * 6}"
TIME_ZONE="${DRIVE_FILE_BACKUP_TIME_ZONE:-Etc/UTC}"
SERVICE_ACCOUNT_NAME="${DRIVE_FILE_BACKUP_SERVICE_ACCOUNT:-bunker-map-drive-backup}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_PREFIX="${DRIVE_FILE_BACKUP_SECRET_PREFIX:-bunker-map-drive-backup}"
TASK_TIMEOUT="${DRIVE_FILE_BACKUP_TASK_TIMEOUT:-3600s}"
MEMORY="${DRIVE_FILE_BACKUP_MEMORY:-1Gi}"
CPU="${DRIVE_FILE_BACKUP_CPU:-1}"
SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/drive-file-backup:${SHORT_SHA}"

GOOGLE_OAUTH_CLIENT_ID="$(require_value GOOGLE_OAUTH_CLIENT_ID)"
GOOGLE_OAUTH_CLIENT_SECRET="$(require_value GOOGLE_OAUTH_CLIENT_SECRET)"
GOOGLE_DRIVE_REFRESH_TOKEN="$(require_value GOOGLE_DRIVE_REFRESH_TOKEN)"
GOOGLE_DRIVE_COMPANY_FOLDER_ID="$(require_value GOOGLE_DRIVE_COMPANY_FOLDER_ID)"
GOOGLE_OAUTH_REDIRECT_URI="$(read_env GOOGLE_OAUTH_REDIRECT_URI)"
GOOGLE_DRIVE_BACKUP_FOLDER_ID="$(read_env GOOGLE_DRIVE_BACKUP_FOLDER_ID)"
GOOGLE_DRIVE_SHARED_DRIVE_ID="$(read_env GOOGLE_DRIVE_SHARED_DRIVE_ID)"

echo "Using project: $PROJECT_ID"
echo "Using region: $REGION"
echo "Using bucket: gs://$GCS_BACKUP_BUCKET"
echo "Using job: $JOB_NAME"

gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project "$PROJECT_ID"

if ! gcloud artifacts repositories describe "$ARTIFACT_REPO" --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$ARTIFACT_REPO" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --repository-format=docker \
    --description="Bunker Map containers"
fi

if ! gcloud storage buckets describe "gs://${GCS_BACKUP_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${GCS_BACKUP_BUCKET}" \
    --project "$PROJECT_ID" \
    --location "$BUCKET_LOCATION" \
    --uniform-bucket-level-access
fi
gcloud storage buckets update "gs://${GCS_BACKUP_BUCKET}" --versioning --project "$PROJECT_ID"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --project "$PROJECT_ID" \
    --display-name="Bunker Map Drive file backup"
fi

gcloud storage buckets add-iam-policy-binding "gs://${GCS_BACKUP_BUCKET}" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectAdmin >/dev/null

gcloud storage buckets add-iam-policy-binding "gs://${GCS_BACKUP_BUCKET}" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.legacyBucketReader >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/secretmanager.secretAccessor >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/run.invoker >/dev/null

upsert_secret "${SECRET_PREFIX}-google-oauth-client-id" "$GOOGLE_OAUTH_CLIENT_ID"
upsert_secret "${SECRET_PREFIX}-google-oauth-client-secret" "$GOOGLE_OAUTH_CLIENT_SECRET"
upsert_secret "${SECRET_PREFIX}-google-drive-refresh-token" "$GOOGLE_DRIVE_REFRESH_TOKEN"

gcloud builds submit \
  --project "$PROJECT_ID" \
  --config cloudbuild.drive-backup.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  .

JOB_ENV_VARS=""
append_env_var GCS_BACKUP_BUCKET "$GCS_BACKUP_BUCKET"
append_env_var GCS_BACKUP_PREFIX "$GCS_BACKUP_PREFIX"
append_env_var GOOGLE_DRIVE_COMPANY_FOLDER_ID "$GOOGLE_DRIVE_COMPANY_FOLDER_ID"
append_env_var GOOGLE_OAUTH_REDIRECT_URI "$GOOGLE_OAUTH_REDIRECT_URI"
append_env_var GOOGLE_DRIVE_BACKUP_FOLDER_ID "$GOOGLE_DRIVE_BACKUP_FOLDER_ID"
append_env_var GOOGLE_DRIVE_SHARED_DRIVE_ID "$GOOGLE_DRIVE_SHARED_DRIVE_ID"

gcloud run jobs deploy "$JOB_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 1 \
  --task-timeout "$TASK_TIMEOUT" \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --set-env-vars "$JOB_ENV_VARS" \
  --set-secrets "GOOGLE_OAUTH_CLIENT_ID=${SECRET_PREFIX}-google-oauth-client-id:latest,GOOGLE_OAUTH_CLIENT_SECRET=${SECRET_PREFIX}-google-oauth-client-secret:latest,GOOGLE_DRIVE_REFRESH_TOKEN=${SECRET_PREFIX}-google-drive-refresh-token:latest"

RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"
if gcloud scheduler jobs describe "$SCHEDULER_NAME" --project "$PROJECT_ID" --location "$SCHEDULER_LOCATION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHEDULER_NAME" \
    --project "$PROJECT_ID" \
    --location "$SCHEDULER_LOCATION" \
    --schedule "$SCHEDULE" \
    --time-zone "$TIME_ZONE" \
    --uri "$RUN_URI" \
    --http-method POST \
    --oauth-service-account-email "$SERVICE_ACCOUNT_EMAIL" \
    --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
else
  gcloud scheduler jobs create http "$SCHEDULER_NAME" \
    --project "$PROJECT_ID" \
    --location "$SCHEDULER_LOCATION" \
    --schedule "$SCHEDULE" \
    --time-zone "$TIME_ZONE" \
    --uri "$RUN_URI" \
    --http-method POST \
    --oauth-service-account-email "$SERVICE_ACCOUNT_EMAIL" \
    --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
fi

if [[ "${EXECUTE_NOW:-1}" == "1" ]]; then
  gcloud run jobs execute "$JOB_NAME" --project "$PROJECT_ID" --region "$REGION" --wait
fi

echo "Google Cloud Drive file backup is configured."
echo "Bucket: gs://${GCS_BACKUP_BUCKET}/${GCS_BACKUP_PREFIX}"
echo "Cloud Run Job: ${JOB_NAME}"
echo "Cloud Scheduler Job: ${SCHEDULER_NAME}"
