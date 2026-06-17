import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"

export type HealthStatus = "ok" | "warning" | "error"

export type HealthCheck = {
  id: string
  label: string
  status: HealthStatus
  message: string
  checkedAt: string
  details?: Record<string, string | number | boolean | null>
}

export type HealthCheckResult = Omit<HealthCheck, "id" | "label" | "checkedAt">

export type SystemHealth = {
  status: HealthStatus
  checkedAt: string
  deployment: {
    commit: string
    shortCommit: string
    branch: string
    deployedAt: string
    environment: string
  }
  checks: HealthCheck[]
}

const BACKUP_FOLDER_NAME = "Bunker Map Backups"
const WEEKLY_FOLDER_NAME = "Weekly Supabase Backups"
const BACKUP_WARNING_AGE_HOURS = 8 * 24
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Request failed.")
  }
  return String(error || "Request failed.")
}

function getDeployment() {
  const commit =
    process.env.DEPLOY_COMMIT ||
    process.env.NEXT_PUBLIC_DEPLOY_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "unknown"

  return {
    commit,
    shortCommit: commit === "unknown" ? commit : commit.slice(0, 7),
    branch:
      process.env.DEPLOY_BRANCH ||
      process.env.VERCEL_GIT_COMMIT_REF ||
      "unknown",
    deployedAt:
      process.env.DEPLOYED_AT ||
      (process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_ENV ? "vercel" : "unknown"),
    environment:
      process.env.VERCEL_ENV ||
      process.env.NODE_ENV ||
      "unknown",
  }
}

function getOAuthClient(refreshTokenEnv: string) {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )
  auth.setCredentials({ refresh_token: requireEnv(refreshTokenEnv) })
  return auth
}

function combineStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === "error")) return "error"
  if (checks.some((check) => check.status === "warning")) return "warning"
  return "ok"
}

async function runCheck(
  id: string,
  label: string,
  fn: () => Promise<HealthCheckResult>
): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const result = await fn()
    return { id, label, checkedAt, ...result }
  } catch (error) {
    return {
      id,
      label,
      checkedAt,
      status: "error",
      message: getErrorMessage(error),
    }
  }
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

async function checkSupabase(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const { count, error } = await supabase
    .from("ports")
    .select("id", { count: "exact", head: true })

  if (error) throw error

  return {
    status: "ok",
    message: "Supabase reachable",
    details: {
      ports: count || 0,
    },
  }
}

async function checkOptionalSchema(): Promise<HealthCheckResult> {
  const supabase = getSupabaseClient()
  const { error } = await supabase
    .from("admin_role_defaults")
    .select("role", { count: "exact", head: true })

  if (!error) {
    return {
      status: "ok",
      message: "Optional admin role defaults table present",
    }
  }

  const message = getErrorMessage(error)
  if (message.toLowerCase().includes("could not find the table") || message.toLowerCase().includes("does not exist")) {
    return {
      status: "warning",
      message: "Optional admin role defaults table is not present",
      details: {
        table: "admin_role_defaults",
      },
    }
  }

  throw error
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function findDriveFolder(drive: ReturnType<typeof google.drive>, parentId: string, name: string, sharedDriveId: string | null) {
  const lookup = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(name)}' and '${parentId}' in parents`,
    fields: "files(id,name,createdTime)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })

  return lookup.data.files?.[0] || null
}

async function checkDriveBackup(): Promise<HealthCheckResult> {
  const auth = getOAuthClient("GOOGLE_DRIVE_REFRESH_TOKEN")
  const drive = google.drive({ version: "v3", auth })
  const rootFolderId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const sharedDriveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID || null
  const backupRoot = await findDriveFolder(drive, rootFolderId, BACKUP_FOLDER_NAME, sharedDriveId)
  if (!backupRoot?.id) {
    return {
      status: "warning",
      message: "Backup root folder has not been created yet",
      details: {
        folder: BACKUP_FOLDER_NAME,
      },
    }
  }

  const weeklyFolder = await findDriveFolder(drive, backupRoot.id, WEEKLY_FOLDER_NAME, sharedDriveId)
  if (!weeklyFolder?.id) {
    return {
      status: "warning",
      message: "Weekly backup folder has not been created yet",
      details: {
        folder: WEEKLY_FOLDER_NAME,
      },
    }
  }

  const list = await drive.files.list({
    q: `trashed = false and '${weeklyFolder.id}' in parents and name contains 'bunker-map-backup-'`,
    fields: "files(id,name,createdTime,webViewLink)",
    orderBy: "createdTime desc",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })
  const latest = list.data.files?.[0]

  if (!latest?.createdTime) {
    return {
      status: "warning",
      message: "No weekly backup file found yet",
    }
  }

  const ageHours = Math.round((Date.now() - new Date(latest.createdTime).getTime()) / 36_000) / 100
  return {
    status: ageHours > BACKUP_WARNING_AGE_HOURS ? "warning" : "ok",
    message: ageHours > BACKUP_WARNING_AGE_HOURS ? "Latest backup is older than expected" : "Latest backup found",
    details: {
      name: latest.name || "",
      createdTime: latest.createdTime,
      ageHours,
      webViewLink: latest.webViewLink || "",
    },
  }
}

async function checkGoogleCalendar(): Promise<HealthCheckResult> {
  const calendar = google.calendar({ version: "v3", auth: getOAuthClient("GOOGLE_CALENDAR_REFRESH_TOKEN") })
  const calendarId = process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
  await calendar.events.list({
    calendarId,
    maxResults: 1,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  })

  return {
    status: "ok",
    message: "Google Calendar reachable",
    details: {
      calendarId,
    },
  }
}

async function checkGoogleContacts(): Promise<HealthCheckResult> {
  const people = google.people({ version: "v1", auth: getOAuthClient("GOOGLE_OAUTH_REFRESH_TOKEN") })
  await people.people.connections.list({
    resourceName: "people/me",
    pageSize: 1,
    personFields: "names,emailAddresses",
  })

  return {
    status: "ok",
    message: "Google Contacts reachable",
  }
}

async function checkExchangeConfig(): Promise<HealthCheckResult> {
  const names = [
    "EXCHANGE_SYNC_WEBHOOK_URL",
    "EXCHANGE_APP_ID",
    "EXCHANGE_TENANT_ID",
    "EXCHANGE_ORGANIZATION",
    "EXCHANGE_CERT_PFX_BASE64",
    "EXCHANGE_CERT_PASSWORD",
  ]
  const missing = names.filter((name) => !process.env[name])

  return {
    status: missing.length ? "warning" : "ok",
    message: missing.length ? "Exchange sync configuration incomplete" : "Exchange sync configuration present",
    details: {
      missing: missing.join(", "),
    },
  }
}

async function checkCronConfig(): Promise<HealthCheckResult> {
  const missing = !process.env.CRON_SECRET

  return {
    status: missing ? "warning" : "ok",
    message: missing ? "CRON_SECRET is not configured" : "Cron secret configured",
    details: {
      weeklyBackupSchedule: "0 19 * * 6 UTC",
      hongKongTime: "Sunday 03:00",
    },
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const checks = await Promise.all([
    runCheck("supabase", "Supabase", checkSupabase),
    runCheck("schema", "Optional Schema", checkOptionalSchema),
    runCheck("backup", "Weekly Backup", checkDriveBackup),
    runCheck("calendar", "Google Calendar", checkGoogleCalendar),
    runCheck("contacts", "Google Contacts", checkGoogleContacts),
    runCheck("exchange", "Exchange Sync", checkExchangeConfig),
    runCheck("cron", "Vercel Cron", checkCronConfig),
  ])

  return {
    status: combineStatus(checks),
    checkedAt: new Date().toISOString(),
    deployment: getDeployment(),
    checks,
  }
}
