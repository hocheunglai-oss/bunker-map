#!/usr/bin/env node

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
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
  excludedRootFolderNames = new Set()
) {
  const children = await listChildren(drive, folderId, sharedDriveId)

  for (const child of children) {
    if (!child.id || !child.name) continue
    const childPath = relativePath ? `${relativePath}/${child.name}` : child.name

    if (child.mimeType === "application/vnd.google-apps.folder") {
      if (!relativePath && excludedRootFolderNames.has(child.name)) {
        warnings.push({
          type: "folderExcluded",
          folderId: child.id,
          relativePath: childPath,
          message: "Backup output folder excluded from source traversal.",
        })
        continue
      }
      await walkDriveFolder(
        drive,
        child.id,
        sharedDriveId,
        childPath,
        files,
        warnings,
        excludedRootFolderNames
      )
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

async function collectDriveFiles(drive, sharedDriveId) {
  const rootFolderId = requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const files = []
  const warnings = []
  await walkDriveFolder(
    drive,
    rootFolderId,
    sharedDriveId,
    "",
    files,
    warnings,
    new Set([BACKUP_ROOT_FOLDER_NAME])
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

function metadataMatches(existingMetadata, file, plan) {
  if (!existingMetadata) return false
  const metadata = existingMetadata.metadata || {}

  return (
    metadata.driveFileId === String(file.id || "") &&
    metadata.driveModifiedTime === String(file.modifiedTime || "") &&
    metadata.driveSize === String(file.size || "") &&
    metadata.driveMd5Checksum === String(file.md5Checksum || "") &&
    metadata.driveMimeType === String(file.mimeType || "") &&
    metadata.downloadMode === String(plan.mode)
  )
}

async function backupOneFile({ drive, bucket, prefix, force, file }) {
  const plan = getDownloadPlan(file)
  if (file.mimeType?.startsWith("application/vnd.google-apps.") && plan.mode !== "export") {
    return {
      status: "skipped",
      reason: "Unsupported Google Workspace file type",
    }
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

async function uploadDriveManifest(drive, sharedDriveId, manifest) {
  const backupRootParentId = optionalEnv("GOOGLE_DRIVE_BACKUP_FOLDER_ID") || requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID")
  const backupRootId = await ensureDriveFolder(drive, backupRootParentId, BACKUP_ROOT_FOLDER_NAME, sharedDriveId)
  const manifestFolderId = await ensureDriveFolder(drive, backupRootId, DRIVE_MANIFEST_FOLDER_NAME, sharedDriveId)
  const content = JSON.stringify(manifest, null, 2)

  const response = await drive.files.create({
    requestBody: {
      name: manifest.fileName,
      parents: [manifestFolderId],
    },
    media: {
      mimeType: "application/json",
      body: Readable.from([content]),
    },
    fields: "id,name,webViewLink,createdTime",
    supportsAllDrives: true,
  })

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
  const bucketName = requireEnv("GCS_BACKUP_BUCKET")
  const prefix = normalizeObjectName(optionalEnv("GCS_BACKUP_PREFIX") || DEFAULT_GCS_PREFIX)
  const concurrency = parseInteger(process.env.DRIVE_FILE_BACKUP_CONCURRENCY, 3)
  const force = process.env.FORCE_DRIVE_FILE_BACKUP === "1"
  const sharedDriveId = optionalEnv("GOOGLE_DRIVE_SHARED_DRIVE_ID") || null

  const drive = await getDriveClient()
  const storage = getStorageClient()
  const bucketInfo = await ensureBucket(storage, bucketName)
  const { sourceFolder, files, warnings } = await collectDriveFiles(drive, sharedDriveId)
  const manifest = createEmptyManifest({ startedAt, bucketName, prefix, sourceFolder, bucketInfo })
  manifest.counts.totalFiles = files.length
  manifest.counts.estimatedCurrentStorageBytes = files.reduce((total, file) => total + parseByteCount(file.size), 0)
  manifest.warnings.push(...warnings)

  if (!bucketInfo.versioningEnabled) {
    manifest.warnings.push({
      type: "gcsVersioningDisabled",
      message: "GCS bucket versioning is not enabled. Enable versioning before relying on this as a business backup.",
    })
  }

  console.log(`Found ${files.length} Google Drive file(s) under ${sourceFolder.name}.`)
  console.log(`Backing up to gs://${bucketName}/${prefix}/files with concurrency ${concurrency}.`)

  await runWithConcurrency(files, concurrency, async (file) => {
    try {
      const result = await backupOneFile({ drive, bucket: bucketInfo.bucket, prefix, force, file })
      if (result.status === "uploaded") manifest.counts.uploaded += 1
      if (result.status === "skipped") manifest.counts.skipped += 1

      manifest.files.push({
        id: file.id,
        name: file.name || "",
        relativePath: file.relativePath || "",
        mimeType: file.mimeType || "",
        modifiedTime: file.modifiedTime || "",
        size: file.size || "",
        md5Checksum: file.md5Checksum || "",
        status: result.status,
        reason: result.reason || "",
        objectName: result.objectName || "",
        generation: result.generation || "",
      })

      console.log(`${result.status}: ${file.relativePath}`)
    } catch (error) {
      manifest.counts.failed += 1
      manifest.failures.push({
        id: file.id || "",
        name: file.name || "",
        relativePath: file.relativePath || "",
        message: getErrorMessage(error),
      })
      console.error(`failed: ${file.relativePath}: ${getErrorMessage(error)}`)
    }
  })

  manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  manifest.finishedAt = new Date().toISOString()

  const gcsManifestObjectName = await uploadGcsManifest(bucketInfo.bucket, prefix, manifest)
  const driveManifest = await uploadDriveManifest(drive, sharedDriveId, {
    ...manifest,
    gcsManifestObjectName,
  })

  const summary = {
    success: manifest.counts.failed === 0,
    generatedAt: manifest.generatedAt,
    finishedAt: manifest.finishedAt,
    counts: manifest.counts,
    gcsManifestObjectName,
    driveManifest: {
      id: driveManifest.id || "",
      name: driveManifest.name || "",
      webViewLink: driveManifest.webViewLink || "",
      createdTime: driveManifest.createdTime || "",
    },
    warnings: manifest.warnings.length,
  }

  console.log(JSON.stringify(summary, null, 2))

  if (manifest.counts.failed > 0) {
    throw new Error(`Drive file backup completed with ${manifest.counts.failed} failed file(s).`)
  }
}

main().catch((error) => {
  console.error(getErrorMessage(error))
  process.exit(1)
})
