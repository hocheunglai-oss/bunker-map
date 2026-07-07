import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { google } from "googleapis"
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

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

async function getDriveClient() {
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
    auth,
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: process.env.GOOGLE_DRIVE_COMPANY_FOLDER_ID || null,
  }
}

function getMimeType(fileName: string, browserMimeType?: string | null) {
  if (browserMimeType?.trim()) return browserMimeType
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
    console.warn("ccinfo direct upload sharing skipped", { fileId, message })
    return message
  }
}

function requireGoogleUploadUrl(value: string) {
  const url = new URL(value)
  const allowedHosts = new Set(["www.googleapis.com", "content.googleapis.com"])
  if (!allowedHosts.has(url.hostname) || !url.pathname.startsWith("/upload/drive/v3/files")) {
    throw new Error("Invalid Google Drive upload session.")
  }
  return url.toString()
}

function getReceivedByteCount(rangeHeader: string | null, fallback: number) {
  const match = rangeHeader?.match(/bytes=0-(\d+)/i)
  if (!match) return fallback
  const lastByte = Number(match[1])
  return Number.isFinite(lastByte) ? lastByte + 1 : fallback
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("ccinfo", "view")
    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "ccinfo"),
      { useServiceRole: true },
    )
    const body = await request.json()
    const entryKind = String(body.entryKind || "")
    const entryId = String(body.entryId || "")
    const entryName = String(body.entryName || "Untitled")
    const folderPath = String(body.folderPath || "").trim()
    const fileName = String(body.fileName || "").trim()
    const fileSize = Number(body.fileSize || 0)
    const mimeType = getMimeType(fileName, typeof body.mimeType === "string" ? body.mimeType : null)

    if (!entryKind || !entryId || !fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
      return NextResponse.json({ message: "Missing upload session data." }, { status: 400 })
    }

    const { auth, drive, rootFolderId } = await getDriveClient()
    if (!rootFolderId) {
      return NextResponse.json(
        { message: "Google Drive folder is not configured. Add GOOGLE_DRIVE_COMPANY_FOLDER_ID in Vercel." },
        { status: 500 },
      )
    }

    const driveContext = await loadCcinfoDriveContext(supabase, entryKind, entryId, entryName, folderPath)
    const targetFolderId = await ensureCcinfoDriveFolderPath(drive, rootFolderId, driveContext, ensureFolder)
    const accessTokenResponse = await auth.getAccessToken()
    const accessToken = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token
    if (!accessToken) throw new Error("Unable to authorize Google Drive upload session.")

    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(fileSize),
        "X-Upload-Content-Type": mimeType,
      },
      body: JSON.stringify({
        name: fileName,
        parents: [targetFolderId],
      }),
    })
    if (!response.ok) {
      throw new Error(await response.text() || "Unable to create Google Drive upload session.")
    }
    const uploadUrl = response.headers.get("location")
    if (!uploadUrl) throw new Error("Google Drive did not return an upload session.")

    return NextResponse.json({ uploadUrl, mimeType })
  } catch (error) {
    console.error("ccinfo upload session failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    await requireAdminPagePermission("ccinfo", "view")
    const requestUrl = new URL(request.url)
    const uploadSessionUrl =
      request.headers.get("x-google-drive-upload-url") ||
      requestUrl.searchParams.get("uploadUrl") ||
      ""
    const uploadUrl = requireGoogleUploadUrl(String(uploadSessionUrl))
    const start = Number(requestUrl.searchParams.get("start") || 0)
    const end = Number(requestUrl.searchParams.get("end") || -1)
    const total = Number(requestUrl.searchParams.get("total") || 0)
    const mimeType = getMimeType(
      String(requestUrl.searchParams.get("fileName") || "upload.bin"),
      requestUrl.searchParams.get("mimeType"),
    )

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      start < 0 ||
      end < start ||
      total <= 0 ||
      end >= total
    ) {
      return NextResponse.json({ message: "Invalid upload chunk range." }, { status: 400 })
    }

    const chunk = Buffer.from(await request.arrayBuffer())
    const expectedLength = end - start + 1
    if (chunk.byteLength !== expectedLength) {
      return NextResponse.json(
        { message: `Upload chunk size mismatch. Expected ${expectedLength} bytes but received ${chunk.byteLength}.` },
        { status: 400 },
      )
    }

    const googleResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
      body: chunk,
    })
    const responseText = await googleResponse.text()

    if (googleResponse.status === 308) {
      return NextResponse.json({
        done: false,
        nextStart: getReceivedByteCount(googleResponse.headers.get("range"), end + 1),
      })
    }

    if (!googleResponse.ok) {
      throw new Error(responseText || "Google Drive chunk upload failed.")
    }

    let driveFile: { id?: string; webViewLink?: string; webContentLink?: string; name?: string } = {}
    if (responseText) {
      try {
        driveFile = JSON.parse(responseText)
      } catch {
        throw new Error(responseText)
      }
    }
    if (!driveFile.id) throw new Error("Google Drive did not return the uploaded file.")

    return NextResponse.json({
      done: true,
      file: driveFile,
    })
  } catch (error) {
    console.error("ccinfo upload chunk failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireAdminPagePermission("ccinfo", "view")
    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "ccinfo"),
      { useServiceRole: true },
    )
    const body = await request.json()
    const entryKind = String(body.entryKind || "")
    const entryId = String(body.entryId || "")
    const entryName = String(body.entryName || "Untitled")
    const folderPath = String(body.folderPath || "").trim()
    const fileName = String(body.fileName || "").trim()
    const driveFileId = String(body.driveFileId || "").trim()

    if (!entryKind || !entryId || !fileName || !driveFileId) {
      return NextResponse.json({ message: "Missing upload completion data." }, { status: 400 })
    }

    const { drive } = await getDriveClient()
    const driveFile = await drive.files.get({
      fileId: driveFileId,
      fields: "id,name,webViewLink,webContentLink",
      supportsAllDrives: true,
    })
    const driveContext = await loadCcinfoDriveContext(supabase, entryKind, entryId, entryName, folderPath)
    const sharingWarning = await makeDriveFilePublic(drive, driveFileId)
    const url = driveFile.data.webViewLink || driveFile.data.webContentLink || `https://drive.google.com/file/d/${driveFileId}/view`

    const { data: savedFile, error } = await supabase
      .from("cc_entry_files")
      .upsert(
        {
          entry_kind: entryKind,
          entry_id: entryId,
          folder_path: folderPath || "",
          file_name: fileName,
          file_type: path.extname(fileName).replace(".", "").toUpperCase() || "FILE",
          drive_file_id: driveFileId,
          drive_url: url,
          deleted_at: null,
          original_path: buildCcinfoLogicalOriginalPath(entryKind, driveContext.entryName, folderPath, fileName),
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
    console.error("ccinfo upload completion failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}
