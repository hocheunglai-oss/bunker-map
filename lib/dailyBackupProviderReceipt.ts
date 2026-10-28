import type { drive_v3 } from "googleapis"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { loadGoogleApis } from "@/lib/googleApis"
import { parseAttendanceBackupSchemaVersion } from "@/lib/backupAttendanceSchema.mjs"
import { parsePricingBackupSchemaVersion } from "@/lib/backupPricingSchema.mjs"

// This deliberately does not import System Health, the exporter, a database
// client or a media reader. It compares provider metadata with an upload receipt;
// it is NOT an independent byte read, schema proof, full-chain or restore test.
const POLICY = fcunoConnectionPolicy.dailyBackupReceipt
const FOLDER_MIME = "application/vnd.google-apps.folder"
const FILE_NAME = /^bunker-map-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/
const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELDS = "id,name,mimeType,trashed,parents,createdTime,modifiedTime,size,version,headRevisionId,md5Checksum,sha256Checksum,appProperties"
const MAX_FILES = 100

export class BackupReceiptUnknown extends Error {
  constructor(readonly code: string) { super("Backup receipt could not be verified.") }
}
function fail(code: string): never { throw new BackupReceiptUnknown(code) }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) fail("invalid_identity")
  return value as string
}
function integer(value: unknown, positive = true): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail("invalid_receipt")
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) fail("invalid_receipt")
  return number
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("invalid_receipt")
  return value as string
}
function samePlacement(file: drive_v3.Schema$File, parent: string, mime: string) {
  if (file.trashed !== false || file.mimeType !== mime || !Array.isArray(file.parents) ||
      file.parents.length !== 1 || file.parents[0] !== parent) fail("wrong_backup_folder")
  identifier(file.id)
}
function properties(file: drive_v3.Schema$File) {
  const value = file.appProperties
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100 ||
      Object.values(value).some(item => typeof item !== "string" || item.length > 4096)) fail("invalid_receipt")
  return value!
}
function receipt(file: drive_v3.Schema$File) {
  const p = properties(file)
  if (p.backupSchema !== "bunker-map-backup/v2" || p.verificationStatus !== "complete" ||
      p.verificationContract !== "bunker-map-backup-stream-verification/v1") fail("unsupported_receipt")
  for (const key of ["artifactSha256", "uploadedFileSha256", "truthHeadSha256", "inventorySha256", "catalogSha256", "latestProjectionSnapshotSha256"]) {
    if (!SHA256.test(p[key] || "")) fail("invalid_receipt")
  }
  const fileByteLength = integer(p.fileByteLength), liveTableCount = integer(p.liveTableCount)
  integer(p.truthHeadSequence); integer(p.databaseEpoch, false); integer(p.sectionCount); integer(p.totalRecordCount, false)
  if (!/^\d{14}$/.test(p.migrationHead || "") || !UUID.test(p.backupRunId || "") || !UUID.test(p.latestCertificationRunId || "") ||
      !["vercel-cron", "admin-manual"].includes(p.source) || !/^(?:[0-9a-f]{7,64}|none)$/i.test(p.deploymentCommit || "")) fail("invalid_receipt")
  timestamp(p.generatedAt)
  const attendanceSchemaVersion = parseAttendanceBackupSchemaVersion(p.attendanceSchemaVersion)
  parsePricingBackupSchemaVersion(p.pricingSchemaVersion)
  const previous = ["previousFileId", "previousFileName", "previousCreatedTime", "previousArtifactSha256", "previousUploadedFileSha256"]
  if (!previous.every(key => p[key] === "none")) {
    identifier(p.previousFileId)
    if (!FILE_NAME.test(p.previousFileName || "") || !SHA256.test(p.previousArtifactSha256 || "") || !SHA256.test(p.previousUploadedFileSha256 || "")) fail("invalid_receipt")
    timestamp(p.previousCreatedTime)
  }
  return { fileByteLength, sha256: p.uploadedFileSha256, migrationHead: p.migrationHead, liveTableCount, attendanceSchemaVersion }
}
function runtimeConfig() {
  // No caller may redirect this reader to a preview, another project or folder.
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production" ||
      process.env.VERCEL_PROJECT_ID !== fcunoConnectionPolicy.vercel.projectId ||
      process.env.NEXT_PUBLIC_SUPABASE_URL !== `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`) fail("wrong_source")
  const rootFolderId = identifier(process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || process.env.GOOGLE_DRIVE_COMPANY_FOLDER_ID)
  const sharedDriveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID ? identifier(process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID) : undefined
  const required = (name: string) => { const value = process.env[name]; if (!value) fail("not_configured"); return value! }
  return { rootFolderId, sharedDriveId, clientId: required("GOOGLE_OAUTH_CLIENT_ID"), clientSecret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
    refreshToken: required("GOOGLE_DRIVE_REFRESH_TOKEN"), redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1" }
}

export async function readDailyBackupProviderReceipt() {
  const config = runtimeConfig(), signal = AbortSignal.timeout(15_000)
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
    transporterOptions: { signal, maxRedirects: 0, retry: false } })
  auth.setCredentials({ refresh_token: config.refreshToken })
  const drive = google.drive({ version: "v3", auth })
  const options = { signal, timeout: 15_000, retry: false, maxRedirects: 0 }
  const identity = await drive.about.get({ fields: "user(emailAddress)" }, options)
  if (identity.data.user?.emailAddress !== POLICY.googleAccount) fail("wrong_account")
  const listOptions = { supportsAllDrives: true, includeItemsFromAllDrives: true,
    corpora: config.sharedDriveId ? "drive" : "user", driveId: config.sharedDriveId }
  async function folder(parent: string, name: string) {
    const result = await drive.files.list({ ...listOptions,
      q: `trashed = false and mimeType = '${FOLDER_MIME}' and '${identifier(parent)}' in parents and name = '${name}'`,
      fields: "files(id,name,mimeType,trashed,parents),nextPageToken,incompleteSearch", pageSize: 2,
    }, options)
    const files = result.data.files
    if (result.data.nextPageToken || result.data.incompleteSearch || !Array.isArray(files) || files.length !== 1) fail("ambiguous_backup_folder")
    samePlacement(files[0], parent, FOLDER_MIME)
    if (files[0].name !== name) fail("wrong_backup_folder")
    return identifier(files[0].id)
  }
  const backupRoot = await folder(config.rootFolderId, "Bunker Map Backups")
  const dailyFolder = await folder(backupRoot, "Daily Supabase Backups")
  if (dailyFolder !== POLICY.dailyFolderId) fail("wrong_backup_folder")
  async function latest() {
    const result = await drive.files.list({ ...listOptions,
      q: `trashed = false and mimeType = 'application/json' and '${dailyFolder}' in parents and name contains 'bunker-map-backup-'`,
      fields: `files(${FIELDS}),nextPageToken,incompleteSearch`, orderBy: "createdTime desc", pageSize: MAX_FILES,
    }, options)
    const files = result.data.files
    if (result.data.nextPageToken || result.data.incompleteSearch || !Array.isArray(files) || files.length > MAX_FILES) fail("incomplete_listing")
    const complete = files.filter(file => FILE_NAME.test(file.name || "") && file.appProperties?.verificationStatus === "complete")
    for (const file of complete) { samePlacement(file, dailyFolder, "application/json"); timestamp(file.createdTime) }
    complete.sort((a, b) => Date.parse(b.createdTime!) - Date.parse(a.createdTime!))
    if (!complete.length) fail("no_complete_backup")
    if (complete.length > 1 && complete[0].createdTime === complete[1].createdTime) fail("ambiguous_backup")
    return complete[0]
  }
  const selected = await latest()
  const current = (await drive.files.get({ fileId: identifier(selected.id), fields: FIELDS, supportsAllDrives: true }, options)).data
  samePlacement(current, dailyFolder, "application/json")
  if (current.id !== selected.id || current.name !== selected.name || current.createdTime !== selected.createdTime ||
      current.version !== selected.version || !FILE_NAME.test(current.name || "")) fail("backup_changed")
  const recorded = receipt(current), sizeBytes = integer(current.size)
  // Drive's provider-computed SHA256 is required. MD5 alone is never a fallback.
  if (typeof current.sha256Checksum !== "string" || !SHA256.test(current.sha256Checksum)) fail("provider_sha256_unavailable")
  if (typeof current.md5Checksum !== "string" || !/^[0-9a-f]{32}$/.test(current.md5Checksum)) fail("invalid_provider_metadata")
  if (current.sha256Checksum !== recorded.sha256 || sizeBytes !== recorded.fileByteLength) fail("checksum_mismatch")
  integer(current.version)
  const revisionId = identifier(current.headRevisionId), createdAt = timestamp(current.createdTime), modifiedAt = timestamp(current.modifiedTime)
  if (Date.parse(createdAt) > Date.now() || Date.parse(modifiedAt) < Date.parse(createdAt) || Date.parse(modifiedAt) > Date.now()) fail("invalid_provider_metadata")
  // Confirm selection still refers to the same provider generation and receipt.
  const after = await latest()
  if (after.id !== current.id || after.version !== current.version || after.headRevisionId !== revisionId ||
      after.sha256Checksum !== current.sha256Checksum || after.size !== current.size ||
      JSON.stringify(Object.entries(properties(after)).sort()) !== JSON.stringify(Object.entries(properties(current)).sort())) fail("backup_changed")
  signal.throwIfAborted()
  return { status: "matched" as const, verification: "google-drive-checksum-correspondence" as const,
    checkedAt: new Date().toISOString(), independentByteRead: false, restoreTest: false,
    backup: { fileId: current.id!, name: current.name!, createdAt, sizeBytes, sha256: current.sha256Checksum,
      version: current.version!, revisionId, migrationHead: recorded.migrationHead, liveTableCount: recorded.liveTableCount,
      attendanceSchemaVersion: recorded.attendanceSchemaVersion } }
}
