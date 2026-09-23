#!/usr/bin/env node

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Storage } from "@google-cloud/storage"
import { google } from "googleapis"

const PROJECT_ROOT = process.cwd()
const LOCAL_ENV_PATH = path.join(PROJECT_ROOT, ".env.local")
const LOCAL_DRIVE_TOKEN_PATH = path.join(PROJECT_ROOT, ".google-drive-oauth-token.json")

const BACKUP_ROOT_FOLDER_NAME = "Bunker Map Backups"
const DRIVE_MANIFEST_FOLDER_NAME = "Drive File Backup Manifests"
const MANIFEST_FILE_PREFIX = "drive-file-backup-manifest"
const DEFAULT_GCS_PREFIX = "ccinfo-drive"
const FREE_TIER_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024
const FREE_TIER_STORAGE_REGIONS = new Set(["US-WEST1", "US-CENTRAL1", "US-EAST1"])
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const MAX_ATTEMPT_MS = 55 * 60 * 1000

export function getBackupWindow(now = new Date()) {
  const localDate = new Date(now.getTime() + HONG_KONG_OFFSET_MS).toISOString().slice(0, 10)
  const startsAt = Date.parse(`${localDate}T02:00:00+08:00`)
  const deadlineAt = Date.parse(`${localDate}T06:00:00+08:00`)
  return { localDate, startsAt, deadlineAt, open: now.getTime() >= startsAt && now.getTime() < deadlineAt }
}

export function isVerifiedManifest(manifest, now = Date.now()) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.status !== "succeeded") return false
  const startedAt = typeof manifest.generatedAt === "string" ? Date.parse(manifest.generatedAt) : NaN
  const finishedAt = typeof manifest.finishedAt === "string" ? Date.parse(manifest.finishedAt) : NaN
  const verifiedAt = typeof manifest.verification?.completedAt === "string" ? Date.parse(manifest.verification.completedAt) : NaN
  const counts = manifest.counts
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && Number.isFinite(verifiedAt) &&
    startedAt <= verifiedAt && verifiedAt <= finishedAt && finishedAt <= now &&
    manifest.verification?.status === "verified" && counts?.failed === 0 &&
    [counts.totalFiles, counts.uploaded, counts.skipped].every((count) => Number.isSafeInteger(count) && count >= 0) &&
    counts.uploaded + counts.skipped === counts.totalFiles &&
    manifest.verification.checkedFiles === counts.totalFiles &&
    Array.isArray(manifest.failures) && manifest.failures.length === 0 &&
    Array.isArray(manifest.files) && manifest.files.length === counts.totalFiles &&
    new Set(manifest.files.map((file) => file?.id)).size === counts.totalFiles &&
    manifest.files.every((file) => file && typeof file.id === "string" && file.id.length > 0 &&
      (file.status === "uploaded" || (file.status === "skipped" && file.reason === "Unchanged")) &&
      typeof file.objectName === "string" && file.objectName.trim().length > 0 &&
      typeof file.generation === "string" && /^\d+$/.test(file.generation))
}

export function alreadyCompletedWindow(manifest, window, now = new Date()) {
  const publishedAt = typeof manifest?.driveManifest?.verifiedAt === "string" ? Date.parse(manifest.driveManifest.verifiedAt) : NaN
  return isVerifiedManifest(manifest, now.getTime()) && typeof manifest.driveManifest?.id === "string" &&
    manifest.driveManifest.id.length > 0 && Number.isFinite(publishedAt) &&
    publishedAt >= Date.parse(manifest.finishedAt) && publishedAt <= now.getTime() &&
    Date.parse(manifest.generatedAt) >= window.startsAt
}

async function readGcsJson(gcsFile) {
  try {
    const [content] = await gcsFile.download()
    return JSON.parse(content.toString("utf8"))
  } catch (error) {
    if (error?.code === 404) return null
    throw error
  }
}

// Cloud Run's parallelism only limits tasks inside one execution, not duplicate executions.
// Generation preconditions make this lease safe against simultaneous scheduler deliveries.
export async function acquireBackupLease(bucket, prefix, now = new Date()) {
  const lock = bucket.file(normalizeObjectName(`${prefix}/runs/active-lock.json`))
  const runId = randomUUID()
  const expiresAt = new Date(now.getTime() + MAX_ATTEMPT_MS + 60_000).toISOString()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lock.save(JSON.stringify({ runId, expiresAt }), {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: "application/json", metadata: { runId, expiresAt } },
      })
      const metadata = await getGcsMetadata(lock)
      if (!metadata?.generation || metadata.metadata?.runId !== runId) throw new Error("Backup lease ownership could not be verified.")
      return {
        runId,
        release: async () => {
          try { await lock.delete({ ifGenerationMatch: metadata.generation }) }
          catch (error) { if (![404, 412].includes(Number(error?.code))) throw error }
        },
      }
    } catch (error) {
      if (Number(error?.code) !== 412) throw error
      const existing = await getGcsMetadata(lock)
      if (!existing) continue
      const expiration = Date.parse(existing.metadata?.expiresAt)
      if (!Number.isFinite(expiration) || expiration > now.getTime()) return null
      try { await lock.delete({ ifGenerationMatch: existing.generation }) }
      catch (deleteError) { if (![404, 412].includes(Number(deleteError?.code))) throw deleteError }
    }
  }
  return null
}

const GOOGLE_WORKSPACE_EXPORTS = new Map([
  ["application/vnd.google-apps.document", {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  }],
  ["application/vnd.google-apps.spreadsheet", {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  }],
  ["application/vnd.google-apps.presentation", {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: ".pptx",
  }],
  ["application/vnd.google-apps.drawing", {
    mimeType: "image/png",
    extension: ".png",
  }],
])

function loadLocalEnv() {
  if (process.env.LOAD_DOTENV === "0" || !fs.existsSync(LOCAL_ENV_PATH)) return

  const lines = fs.readFileSync(LOCAL_ENV_PATH, "utf8").split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const index = line.indexOf("=")
    if (index === -1) continue

    const key = line.slice(0, index).trim()
    if (process.env[key]) continue
    process.env[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function optionalEnv(name) {
  return process.env[name]?.trim() || ""
}

function parseInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseByteCount(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message || "Request failed.")
  }
  return String(error || "Request failed.")
}

function escapeDriveQueryValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

function normalizeObjectName(value) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "").replace(/[\r\n]/g, " ")
}

function addDriveIdToObjectPath(relativePath, driveFileId) {
  const extension = path.extname(relativePath)
  const stem = extension ? relativePath.slice(0, -extension.length) : relativePath
  return `${stem} [drive-${driveFileId}]${extension}`
}

function getGoogleCredentials() {
  const clientEmail = optionalEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL")
  const privateKey = optionalEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n")
  if (!clientEmail || !privateKey) return null

  const projectId =
    optionalEnv("GOOGLE_CLOUD_PROJECT") ||
    optionalEnv("GCP_PROJECT_ID") ||
    clientEmail.split("@")[1]?.replace(/\.iam\.gserviceaccount\.com$/, "")

  return {
    projectId,
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
  }
}

async function getDriveRefreshToken() {
  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return process.env.GOOGLE_DRIVE_REFRESH_TOKEN
  if (!fs.existsSync(LOCAL_DRIVE_TOKEN_PATH)) return ""

  const token = JSON.parse(await fsp.readFile(LOCAL_DRIVE_TOKEN_PATH, "utf8"))
  return token.refresh_token || ""
}

async function getDriveClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    optionalEnv("GOOGLE_OAUTH_REDIRECT_URI") || "http://127.0.0.1"
  )

  const refreshToken = await getDriveRefreshToken()
  if (!refreshToken) {
    throw new Error("Missing GOOGLE_DRIVE_REFRESH_TOKEN. Cloud Run should receive it from Secret Manager.")
  }

  auth.setCredentials({ refresh_token: refreshToken })
  return google.drive({ version: "v3", auth })
}

function getStorageClient() {
  const explicitCredentials = getGoogleCredentials()
  if (explicitCredentials) return new Storage(explicitCredentials)

  const projectId = optionalEnv("GOOGLE_CLOUD_PROJECT") || optionalEnv("GCP_PROJECT_ID") || undefined
  return new Storage({ projectId })
}

async function findFolderByName(drive, parentId, name, sharedDriveId) {
  const result = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(name)}' and '${parentId}' in parents`,
    fields: "files(id,name,createdTime)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: sharedDriveId ? "drive" : undefined,
    driveId: sharedDriveId || undefined,
  })

  return result.data.files?.[0] || null
}

async function ensureDriveFolder(drive, parentId, name, sharedDriveId) {
  const existing = await findFolderByName(drive, parentId, name, sharedDriveId)
  if (existing?.id) return existing.id

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  })

  if (!created.data.id) throw new Error(`Unable to create Drive folder: ${name}`)
  return created.data.id
}

async function listChildren(drive, parentId, sharedDriveId) {
  const files = []
  let pageToken

  do {
    const result = await drive.files.list({
      q: `trashed = false and '${parentId}' in parents`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: sharedDriveId ? "drive" : undefined,
      driveId: sharedDriveId || undefined,
    })
    files.push(...(result.data.files || []))
    pageToken = result.data.nextPageToken || undefined
  } while (pageToken)

  return files
}

async function walkDriveFolder(
  drive,
  folderId,
  sharedDriveId,
  relativePath,
  files,
  warnings,
  excludedRootFolderNames = new Set(),
  scanConcurrency = 20
) {
  const folders = [{ id: folderId, relativePath }]

  while (folders.length > 0) {
    const batch = folders.splice(0, Math.max(1, scanConcurrency))
    const results = await Promise.all(
      batch.map(async (folder) => ({
        folder,
        children: await listChildren(drive, folder.id, sharedDriveId),
      }))
    )

    for (const { folder, children } of results) {
      for (const child of children) {
        if (!child.id || !child.name) continue
        const childPath = folder.relativePath
          ? `${folder.relativePath}/${child.name}`
          : child.name

        if (child.mimeType === "application/vnd.google-apps.folder") {
          if (!folder.relativePath && excludedRootFolderNames.has(child.name)) {
            warnings.push({
              type: "folderExcluded",
              folderId: child.id,
              relativePath: childPath,
              message: "Backup output folder excluded from source traversal.",
            })
            continue
          }
          folders.push({ id: child.id, relativePath: childPath })
          continue
        }

        if (child.mimeType === "application/vnd.google-apps.shortcut") {
          warnings.push({
            type: "shortcutSkipped",
            fileId: child.id,
            relativePath: childPath,
            message: "Google Drive shortcut skipped.",
          })
          continue
        }

        files.push({
          ...child,
          relativePath: childPath,
        })
      }
    }
  }
}

async function collectDriveFiles(drive, sharedDriveId) {
  const rootFolderId = requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const scanConcurrency = parseInteger(process.env.DRIVE_FOLDER_SCAN_CONCURRENCY, 20)
  const files = []
  const warnings = []
  await walkDriveFolder(
    drive,
    rootFolderId,
    sharedDriveId,
    "",
    files,
    warnings,
    new Set([BACKUP_ROOT_FOLDER_NAME]),
    scanConcurrency
  )
  return {
    sourceFolder: {
      id: rootFolderId,
      name: "CCINFO Drive root",
    },
    files,
    warnings,
  }
}

function getDownloadPlan(file) {
  const exportPlan = GOOGLE_WORKSPACE_EXPORTS.get(file.mimeType || "")
  if (!exportPlan) {
    return {
      mode: "media",
      contentType: file.mimeType || "application/octet-stream",
      objectRelativePath: file.relativePath,
    }
  }

  const hasExtension = path.extname(file.name || "") !== ""
  return {
    mode: "export",
    contentType: exportPlan.mimeType,
    exportMimeType: exportPlan.mimeType,
    objectRelativePath: hasExtension ? file.relativePath : `${file.relativePath}${exportPlan.extension}`,
  }
}

async function getDriveDownloadStream(drive, file, plan) {
  if (plan.mode === "export") {
    const response = await drive.files.export(
      {
        fileId: file.id,
        mimeType: plan.exportMimeType,
      },
      {
        responseType: "stream",
      }
    )
    return response.data
  }

  const response = await drive.files.get(
    {
      fileId: file.id,
      alt: "media",
      supportsAllDrives: true,
    },
    {
      responseType: "stream",
    }
  )
  return response.data
}

async function getGcsMetadata(gcsFile) {
  try {
    const [metadata] = await gcsFile.getMetadata()
    return metadata
  } catch (error) {
    if (error?.code === 404) return null
    throw error
  }
}

export function metadataMatches(existingMetadata, file, plan) {
  if (!existingMetadata) return false
  const metadata = existingMetadata.metadata || {}

  // Metadata alone must not certify a zero-byte/truncated or otherwise wrong object.
  if (!existingMetadata.generation || !existingMetadata.crc32c) return false
  if (plan.mode === "media") {
    if (file.size != null && String(existingMetadata.size) !== String(file.size)) return false
    if (file.md5Checksum && (!existingMetadata.md5Hash ||
      Buffer.from(existingMetadata.md5Hash, "base64").toString("hex") !== file.md5Checksum.toLowerCase())) return false
  }

  return (
    metadata.driveFileId === String(file.id || "") &&
    metadata.driveModifiedTime === String(file.modifiedTime || "") &&
    metadata.driveSize === String(file.size || "") &&
    metadata.driveMd5Checksum === String(file.md5Checksum || "") &&
    metadata.driveMimeType === String(file.mimeType || "") &&
    metadata.downloadMode === String(plan.mode)
  )
}

export async function backupOneFile({ drive, bucket, prefix, force, file }) {
  const plan = getDownloadPlan(file)
  if (file.mimeType?.startsWith("application/vnd.google-apps.") && plan.mode !== "export") {
    throw new Error(`Unsupported Google Workspace file type: ${file.mimeType}; no backup object was created.`)
  }

  const uniqueRelativePath = addDriveIdToObjectPath(plan.objectRelativePath, file.id)
  const objectName = normalizeObjectName(`${prefix}/files/${uniqueRelativePath}`)
  const gcsFile = bucket.file(objectName)
  const existingMetadata = await getGcsMetadata(gcsFile)

  if (!force && metadataMatches(existingMetadata, file, plan)) {
    return {
      status: "skipped",
      reason: "Unchanged",
      objectName,
      generation: existingMetadata.generation || "",
    }
  }

  const driveStream = await getDriveDownloadStream(drive, file, plan)
  await pipeline(
    driveStream,
    gcsFile.createWriteStream({
      resumable: false,
      validation: "crc32c",
      metadata: {
        contentType: plan.contentType,
        metadata: {
          backupSource: "google-drive-ccinfo-root",
          downloadMode: plan.mode,
          driveFileId: String(file.id || ""),
          driveName: String(file.name || ""),
          driveRelativePath: String(file.relativePath || ""),
          driveMimeType: String(file.mimeType || ""),
          driveModifiedTime: String(file.modifiedTime || ""),
          driveSize: String(file.size || ""),
          driveMd5Checksum: String(file.md5Checksum || ""),
        },
      },
    })
  )

  const uploadedMetadata = await getGcsMetadata(gcsFile)
  if (!metadataMatches(uploadedMetadata, file, plan)) {
    throw new Error("Uploaded backup object failed generation, checksum, size, or source metadata verification.")
  }
  return {
    status: "uploaded",
    objectName,
    generation: uploadedMetadata?.generation || "",
  }
}

async function uploadGcsManifest(bucket, prefix, manifest) {
  const content = JSON.stringify(manifest, null, 2)
  const manifestObjectName = normalizeObjectName(`${prefix}/manifests/${manifest.fileName}`)
  await bucket.file(manifestObjectName).save(content, {
    contentType: "application/json",
    resumable: false,
    metadata: {
      cacheControl: "no-store",
    },
  })
  await bucket.file(normalizeObjectName(`${prefix}/manifests/latest.json`)).save(content, {
    contentType: "application/json",
    resumable: false,
    metadata: {
      cacheControl: "no-store",
    },
  })

  return manifestObjectName
}

export async function publishSuccessfulManifest({ bucket, prefix, manifest, publishDrive, readDrive }) {
  if (!isVerifiedManifest(manifest)) throw new Error("Backup completion verification failed.")
  manifest.gcsManifestObjectName = await uploadGcsManifest(bucket, prefix, manifest)
  const driveManifest = await publishDrive(manifest)
  if (!driveManifest?.id) throw new Error("Published Drive backup manifest has no file ID.")
  const readback = await readDrive(driveManifest.id)
  const verifiedCopy = typeof readback === "string" ? JSON.parse(readback) : readback
  if (!isVerifiedManifest(verifiedCopy) || !manifest.runId || verifiedCopy.runId !== manifest.runId) {
    throw new Error("Published Drive backup manifest could not be verified.")
  }
  // Never advance the successful pointer on a scheduler acknowledgement, a failed
  // Drive publication, or a completed manifest that cannot be read back intact.
  await bucket.file(normalizeObjectName(`${prefix}/manifests/latest-successful.json`)).save(
    JSON.stringify({ ...manifest, driveManifest: { ...driveManifest, verifiedAt: new Date().toISOString() } }),
    { contentType: "application/json", resumable: false, validation: "crc32c", metadata: { cacheControl: "no-store" } },
  )
  return driveManifest
}

async function uploadDriveManifest(drive, sharedDriveId, manifest, existingFileId = "") {
  const backupRootParentId = optionalEnv("GOOGLE_DRIVE_BACKUP_FOLDER_ID") || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const backupRootId = await ensureDriveFolder(drive, backupRootParentId, BACKUP_ROOT_FOLDER_NAME, sharedDriveId)
  const manifestFolderId = await ensureDriveFolder(drive, backupRootId, DRIVE_MANIFEST_FOLDER_NAME, sharedDriveId)
  const content = JSON.stringify(manifest, null, 2)

  const params = {
    requestBody: { name: manifest.fileName, ...(existingFileId ? {} : { parents: [manifestFolderId] }) },
    media: {
      mimeType: "application/json",
      body: Readable.from([content]),
    },
    fields: "id,name,webViewLink,createdTime",
    supportsAllDrives: true,
  }
  const response = existingFileId
    ? await drive.files.update({ ...params, fileId: existingFileId })
    : await drive.files.create(params)

  return response.data
}

async function ensureBucket(storage, bucketName) {
  const bucket = storage.bucket(bucketName)
  const [exists] = await bucket.exists()
  if (!exists) {
    throw new Error(`GCS bucket ${bucketName} does not exist. Create it with versioning before running the backup job.`)
  }

  const [metadata] = await bucket.getMetadata()
  return {
    bucket,
    versioningEnabled: Boolean(metadata.versioning?.enabled),
    location: metadata.location || "",
    storageClass: metadata.storageClass || "",
  }
}

function createEmptyManifest({ startedAt, bucketName, prefix, sourceFolder, bucketInfo }) {
  const stamp = startedAt.replace(/[:.]/g, "-")
  return {
    schemaVersion: 2,
    status: "running",
    verification: { status: "pending", checkedFiles: 0, completedAt: "" },
    generatedAt: startedAt,
    finishedAt: "",
    fileName: `${MANIFEST_FILE_PREFIX}-${stamp}.json`,
    source: "google-drive-ccinfo-root",
    target: "google-cloud-storage",
    sourceFolder,
    gcs: {
      bucket: bucketName,
      prefix,
      versioningEnabled: bucketInfo.versioningEnabled,
      location: bucketInfo.location,
      storageClass: bucketInfo.storageClass,
      freeTierStorageLimitBytes: FREE_TIER_STORAGE_REGIONS.has(String(bucketInfo.location).toUpperCase())
        ? FREE_TIER_STORAGE_LIMIT_BYTES
        : 0,
    },
    counts: {
      totalFiles: 0,
      estimatedCurrentStorageBytes: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
    },
    files: [],
    warnings: [],
    failures: [],
  }
}

async function runWithConcurrency(items, concurrency, handler) {
  let index = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await handler(item)
    }
  })
  await Promise.all(workers)
}

async function main() {
  loadLocalEnv()

  const startedAt = new Date().toISOString()
  const window = getBackupWindow(new Date(startedAt))
  const scheduled = process.env.DRIVE_FILE_BACKUP_SCHEDULED === "1" && process.env.DRIVE_FILE_BACKUP_ALLOW_OUTSIDE_WINDOW !== "1"
  if (scheduled && !window.open) {
    console.log("No backup started: outside the 02:00–06:00 Hong Kong backup window.")
    return
  }
  // Absolute wall-clock cutoff also covers delayed scheduler deliveries and API hangs.
  const stopAt = Math.min(Date.parse(startedAt) + MAX_ATTEMPT_MS, scheduled ? window.deadlineAt : Infinity)
  const deadlineTimer = setTimeout(() => {
    console.error("Backup attempt exceeded its deadline; the running manifest remains unverified.")
    process.exit(1)
  }, Math.max(1, stopAt - Date.now()))
  const bucketName = requireEnv("GCS_BACKUP_BUCKET")
  const prefix = normalizeObjectName(optionalEnv("GCS_BACKUP_PREFIX") || DEFAULT_GCS_PREFIX)
  const concurrency = parseInteger(process.env.DRIVE_FILE_BACKUP_CONCURRENCY, 3)
  const force = process.env.FORCE_DRIVE_FILE_BACKUP === "1"
  const sharedDriveId = optionalEnv("GOOGLE_DRIVE_SHARED_DRIVE_ID") || null

  const drive = await getDriveClient()
  const storage = getStorageClient()
  const bucketInfo = await ensureBucket(storage, bucketName)
  const lease = await acquireBackupLease(bucketInfo.bucket, prefix)
  if (!lease) {
    clearTimeout(deadlineTimer)
    console.log("No duplicate backup started: another attempt holds the backup lease.")
    return
  }
  let manifest
  let driveManifest
  try {
    const successFile = bucketInfo.bucket.file(normalizeObjectName(`${prefix}/manifests/latest-successful.json`))
    if (scheduled && !force && alreadyCompletedWindow(await readGcsJson(successFile), window)) {
      console.log("No retry needed: today's completed backup and published manifest were verified.")
      return
    }
    manifest = createEmptyManifest({
      startedAt, bucketName, prefix, bucketInfo,
      sourceFolder: { id: requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID"), name: "CCINFO Drive root" },
    })
    manifest.runId = lease.runId
    manifest.deadlineAt = new Date(stopAt).toISOString()
    // Publish before scanning so an interrupted or failed scan is visible to System Health.
    driveManifest = await uploadDriveManifest(drive, sharedDriveId, manifest)
    if (!driveManifest.id) throw new Error("Drive did not return an ID for the running backup manifest.")
    const { sourceFolder, files, warnings } = await collectDriveFiles(drive, sharedDriveId)
    manifest.sourceFolder = sourceFolder
    manifest.counts.totalFiles = files.length
    manifest.counts.estimatedCurrentStorageBytes = files.reduce((total, file) => total + parseByteCount(file.size), 0)
    manifest.warnings.push(...warnings)
    if (!bucketInfo.versioningEnabled) throw new Error("GCS bucket versioning is disabled; a verified business backup requires versioning.")

    console.log(`Found ${files.length} Google Drive file(s) under ${sourceFolder.name}.`)
    console.log(`Backing up to gs://${bucketName}/${prefix}/files with concurrency ${concurrency}.`)
    await runWithConcurrency(files, concurrency, async (file) => {
      try {
        const result = await backupOneFile({ drive, bucket: bucketInfo.bucket, prefix, force, file })
        if (result.status === "uploaded") manifest.counts.uploaded += 1
        if (result.status === "skipped") manifest.counts.skipped += 1
        manifest.verification.checkedFiles += 1
        manifest.files.push({
          id: file.id, name: file.name || "", relativePath: file.relativePath || "",
          mimeType: file.mimeType || "", modifiedTime: file.modifiedTime || "", size: file.size || "",
          md5Checksum: file.md5Checksum || "", status: result.status, reason: result.reason || "",
          objectName: result.objectName, generation: result.generation,
        })
        console.log(`${result.status}: ${file.relativePath}`)
      } catch (error) {
        manifest.counts.failed += 1
        manifest.failures.push({ id: file.id || "", name: file.name || "", relativePath: file.relativePath || "", message: getErrorMessage(error) })
        console.error(`failed: ${file.relativePath}: ${getErrorMessage(error)}`)
      }
    })
    if (manifest.counts.failed > 0) throw new Error(`Drive file backup completed with ${manifest.counts.failed} failed file(s).`)
    manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    manifest.finishedAt = new Date().toISOString()
    manifest.status = "succeeded"
    manifest.verification.status = "verified"
    manifest.verification.completedAt = manifest.finishedAt
    driveManifest = await publishSuccessfulManifest({
      bucket: bucketInfo.bucket, prefix, manifest,
      publishDrive: (completed) => uploadDriveManifest(drive, sharedDriveId, completed, driveManifest.id),
      readDrive: async (fileId) => (await drive.files.get({ fileId, alt: "media", supportsAllDrives: true })).data,
    })
    console.log(JSON.stringify({ success: true, generatedAt: manifest.generatedAt, finishedAt: manifest.finishedAt, counts: manifest.counts, driveManifest }, null, 2))
  } catch (error) {
    if (manifest) {
      manifest.status = "failed"
      manifest.finishedAt = new Date().toISOString()
      manifest.verification.status = "failed"
      manifest.failures.push({ type: "runFailure", message: getErrorMessage(error) })
      manifest.counts.failed = Math.max(1, manifest.counts.failed)
      // Keep the last successful pointer intact, even when publication or enumeration fails.
      const results = await Promise.allSettled([
        uploadGcsManifest(bucketInfo.bucket, prefix, manifest),
        uploadDriveManifest(drive, sharedDriveId, manifest, driveManifest?.id),
      ])
      for (const result of results) if (result.status === "rejected") console.error(`Unable to publish failed backup status: ${getErrorMessage(result.reason)}`)
    }
    throw error
  } finally {
    await lease.release()
    clearTimeout(deadlineTimer)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(getErrorMessage(error))
    process.exit(1)
  })
}
