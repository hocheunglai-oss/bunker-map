import "server-only"

import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { loadGoogleApis } from "@/lib/googleApis"
import { tripReceiptMime } from "@/lib/tripExpenseClaim"
import { tripReceiptBucket, tripReceiptPath, type TripClaimRow } from "@/lib/tripExpenseStore"

const FOLDER_MIME = "application/vnd.google-apps.folder"
const BACKUP_MIME = "application/gzip"
const FOLDER_FIELDS = "id,name,mimeType,parents,trashed"
const FILE_FIELDS = FOLDER_FIELDS + ",size,sha256Checksum"
const compress = promisify(gzip)

function requiredSetting(key: string) {
  const value = process.env[key]
  if (!value) throw new Error("FCUNO Drive backup is unavailable.")
  return value
}

export async function openTripExpenseBackupDrive() {
  const { vercel, dailyBackupReceipt } = fcunoConnectionPolicy
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production" ||
      process.env.VERCEL_PROJECT_ID !== vercel.projectId) {
    throw new Error("Trip claim backups require FCUNO production.")
  }
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2({
    clientId: requiredSetting("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requiredSetting("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
    transporterOptions: { timeout: 15_000, retry: false, maxRedirects: 0 },
  })
  auth.setCredentials({ refresh_token: requiredSetting("GOOGLE_DRIVE_REFRESH_TOKEN") })
  const drive = google.drive({ version: "v3", auth })
  const requestOptions = { timeout: 15_000, retry: false, maxRedirects: 0 }
  const identity = await drive.about.get({ fields: "user(emailAddress)" }, requestOptions)
  if (identity.data.user?.emailAddress !== dailyBackupReceipt.googleAccount) throw new Error("Wrong FCUNO Drive account.")

  const daily = (await drive.files.get({
    fileId: dailyBackupReceipt.dailyFolderId, supportsAllDrives: true, fields: FOLDER_FIELDS,
  }, requestOptions)).data
  const rootId = daily.parents?.[0]
  if (daily.id !== dailyBackupReceipt.dailyFolderId || daily.trashed !== false ||
      daily.mimeType !== FOLDER_MIME || daily.name !== "Daily Supabase Backups" ||
      daily.parents?.length !== 1 || !rootId) throw new Error("Wrong FCUNO backup location.")

  const root = (await drive.files.get({
    fileId: rootId, supportsAllDrives: true, fields: FOLDER_FIELDS + ",capabilities(canAddChildren)",
  }, requestOptions)).data
  if (root.id !== rootId || root.trashed !== false || root.name !== "Bunker Map Backups" ||
      root.mimeType !== FOLDER_MIME || root.capabilities?.canAddChildren !== true) {
    throw new Error("Wrong FCUNO backup root.")
  }
  const permissions = (await drive.permissions.list({
    fileId: rootId, pageSize: 100, supportsAllDrives: true, fields: "nextPageToken,permissions(type)",
  }, requestOptions)).data
  if (permissions.nextPageToken || !permissions.permissions?.length ||
      permissions.permissions.some(permission => permission.type !== "user")) {
    throw new Error("FCUNO backup root has broad sharing.")
  }
  return { drive, rootId, requestOptions }
}

type BackupDrive = Awaited<ReturnType<typeof openTripExpenseBackupDrive>>

export async function allocateTripExpenseBackupId(context: BackupDrive) {
  const { data } = await context.drive.files.generateIds({ count: 1, space: "drive", type: "files" }, context.requestOptions)
  const id = data.ids?.[0]
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("Could not allocate the FCUNO backup.")
  return id
}

async function backupBytes(claim: TripClaimRow, bucket: ReturnType<typeof tripReceiptBucket>) {
  const receipts = []
  for (const item of claim.details.items) {
    for (const receipt of item.receipts) {
      const path = tripReceiptPath(claim.submitted_by, claim.id, item.id, receipt.id)
      const { data, error } = await bucket.download(path)
      if (error || data.size !== receipt.size) throw new Error("Trip claim receipt changed before backup.")
      const bytes = Buffer.from(await data.arrayBuffer())
      receipts.push({
        ...receipt,
        itemId: item.id,
        mimeType: tripReceiptMime(receipt.name),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        base64: bytes.toString("base64"),
      })
    }
  }
  return compress(JSON.stringify({
    schema: "fcuno.trip-expense-claim/v1",
    submittedBy: claim.submitted_by,
    submitterName: claim.submitter_name,
    submittedAt: claim.submitted_at,
    claim: claim.details,
    receipts,
  }), { level: 1 })
}

export async function writeTripExpenseBackup(
  context: BackupDrive,
  claim: TripClaimRow,
  fileId: string,
  bucket: ReturnType<typeof tripReceiptBucket>,
) {
  const { drive, rootId, requestOptions } = context
  const name = "trip-expense-claim-" + claim.id + ".json.gz"
  const bytes = await backupBytes(claim, bucket)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  try {
    await drive.files.create({
      requestBody: { id: fileId, parents: [rootId], name, mimeType: BACKUP_MIME },
      media: { mimeType: BACKUP_MIME, body: Readable.from([bytes]) },
      fields: "id",
      supportsAllDrives: true,
    }, { ...requestOptions, timeout: 60_000 })
  } catch (error) {
    if (typeof error !== "object" || !error || !("response" in error) ||
        (error.response as { status?: number } | undefined)?.status !== 409) throw error
  }
  // The reserved Drive ID lets a retry verify the same object after an interrupted upload.
  const { data } = await drive.files.get({ fileId, supportsAllDrives: true, fields: FILE_FIELDS }, requestOptions)
  if (data.id !== fileId || data.trashed !== false || data.name !== name || data.mimeType !== BACKUP_MIME ||
      data.parents?.length !== 1 || data.parents[0] !== rootId ||
      Number(data.size) !== bytes.length || data.sha256Checksum !== sha256) {
    throw new Error("Trip claim backup verification failed.")
  }
}
