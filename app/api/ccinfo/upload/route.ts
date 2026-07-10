import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  buildCcinfoLogicalOriginalPath,
  ensureCcinfoDriveFolderPath,
  loadCcinfoDriveContext,
} from "@/lib/ccinfoDrivePaths"
import { loadGoogleApis } from "@/lib/googleApis"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

async function getDriveClient() {
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN
  const useHostedToken = process.env.VERCEL || process.env.NODE_ENV === "production"
  if (useHostedToken) {
    if (!refreshToken) {
      throw new Error("Google Drive is not authorized on the hosted app yet. Add GOOGLE_DRIVE_REFRESH_TOKEN in Vercel.")
    }
    auth.setCredentials({ refresh_token: refreshToken })
  } else if (fsSync.existsSync(TOKEN_PATH)) {
    auth.setCredentials(JSON.parse(await fs.readFile(TOKEN_PATH, "utf8")))
  } else if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else {
    throw new Error("Google Drive is not authorized. Run npm run auth:google-drive.")
  }
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: process.env.GOOGLE_DRIVE_COMPANY_FOLDER_ID || null,
  }
}

function getMimeType(fileName: string) {
  const ext = path.extname(fileName).toLowerCase()
  switch (ext) {
    case ".pdf":
      return "application/pdf"
    case ".doc":
      return "application/msword"
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case ".xls":
      return "application/vnd.ms-excel"
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case ".ppt":
      return "application/vnd.ms-powerpoint"
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    case ".txt":
      return "text/plain"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    default:
      return "application/octet-stream"
  }
}

async function ensureFolder(drive: any, parentId: string, name: string) {
  const escapedName = name.replace(/'/g, "\\'")
  const lookup = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentId}' in parents`,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const existing = lookup.data.files?.[0]
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
  if (!created.data.id) throw new Error(`Unable to create folder ${name}`)
  return created.data.id
}

function messageFromError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message || "Request failed.")
        : "Request failed."
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? String((error as { details?: unknown }).details || "")
      : ""
  const hint =
    typeof error === "object" && error !== null && "hint" in error
      ? String((error as { hint?: unknown }).hint || "")
      : ""
  return [message, details, hint].filter(Boolean).join(" | ") || "Request failed."
}

async function makeDriveFilePublic(drive: any, fileId: string) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    })
    return null
  } catch (error) {
    const message = messageFromError(error)
    console.warn("ccinfo upload sharing skipped", { fileId, message })
    return message
  }
}

export async function POST(request: Request) {
  let tempPath = ""
  try {
    // CCINFO file panel actions are intentionally available to everyone
    // who can access CCINFO, while text/table edits still go through edit-only APIs.
    const session = await requireAdminPagePermission("ccinfo", "view")
    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "ccinfo"),
      { useServiceRole: true },
    )
    const formData = await request.formData()
    const entryKind = String(formData.get("entryKind") || "")
    const entryId = String(formData.get("entryId") || "")
    const entryName = String(formData.get("entryName") || "Untitled")
    const folderPath = String(formData.get("folderPath") || "").trim()
    const uploadFile = formData.get("file")

    if (!entryKind || !entryId || !(uploadFile instanceof File)) {
      return NextResponse.json({ message: "Missing upload data." }, { status: 400 })
    }

    const { drive, rootFolderId } = await getDriveClient()
    if (!rootFolderId) {
      return NextResponse.json(
        { message: "Google Drive folder is not configured. Add GOOGLE_DRIVE_COMPANY_FOLDER_ID in Vercel." },
        { status: 500 },
      )
    }

    const driveContext = await loadCcinfoDriveContext(supabase, entryKind, entryId, entryName, folderPath)
    const targetFolderId = await ensureCcinfoDriveFolderPath(drive, rootFolderId, driveContext, ensureFolder)

    tempPath = path.join(os.tmpdir(), ".tmp-upload-" + Date.now() + "-" + uploadFile.name)
    const bytes = Buffer.from(await uploadFile.arrayBuffer())
    await fs.writeFile(tempPath, bytes)

    const uploaded = await drive.files.create({
      requestBody: {
        name: uploadFile.name,
        parents: [targetFolderId],
      },
      media: {
        mimeType: getMimeType(uploadFile.name),
        body: fsSync.createReadStream(tempPath),
      },
      fields: "id,webViewLink,webContentLink,name",
      supportsAllDrives: true,
    })

    const fileId = uploaded.data.id
    if (!fileId) throw new Error("Google Drive upload failed.")
    const sharingWarning = await makeDriveFilePublic(drive, fileId)

    const url = uploaded.data.webViewLink || uploaded.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`

    const { data: savedFile, error } = await supabase
      .from("cc_entry_files")
      .upsert(
        {
          entry_kind: entryKind,
          entry_id: entryId,
          folder_path: folderPath || "",
          file_name: uploadFile.name,
          file_type: path.extname(uploadFile.name).replace(".", "").toUpperCase() || "FILE",
          drive_file_id: fileId,
          drive_url: url,
          deleted_at: null,
          original_path: buildCcinfoLogicalOriginalPath(entryKind, driveContext.entryName, folderPath, uploadFile.name),
        },
        {
          onConflict: "entry_kind,entry_id,original_path",
        }
      )
      .select("id,folder_path,file_name,file_type,drive_file_id,drive_url")
      .single()

    if (error || !savedFile) throw error || new Error("Upload record could not be saved.")

    return NextResponse.json({
      file: {
        id: savedFile.id,
        folder_path: savedFile.folder_path || "",
        file_name: savedFile.file_name,
        file_type: savedFile.file_type,
        drive_file_id: savedFile.drive_file_id,
        drive_url: savedFile.drive_url,
        source: "entry",
      },
      warning: sharingWarning ? `Uploaded, but Google Drive sharing could not be changed automatically: ${sharingWarning}` : null,
    })
  } catch (error) {
    const joined = messageFromError(error)
    console.error("ccinfo upload failed", error)
    return NextResponse.json({ message: joined || "Upload failed." }, { status: 500 })
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true })
    }
  }
}
