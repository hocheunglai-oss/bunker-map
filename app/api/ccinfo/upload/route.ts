import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { google } from "googleapis"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")
const ADMIN_COOKIE_NAME = "bunker_admin_auth"

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
  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      throw new Error("Google Drive is not authorized on the hosted app yet. Add GOOGLE_DRIVE_REFRESH_TOKEN in Vercel.")
    }
    const tokenRaw = await fs.readFile(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(tokenRaw))
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

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies()
    if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))
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

    const uploadsFolderId = await ensureFolder(drive, rootFolderId, "Manual Uploads")
    const kindFolderId = await ensureFolder(drive, uploadsFolderId, entryKind)
    const entryFolderId = await ensureFolder(drive, kindFolderId, entryName)
    let targetFolderId = entryFolderId

    if (folderPath) {
      const segments = folderPath.split("/").map((segment) => segment.trim()).filter(Boolean)
      for (const segment of segments) {
        targetFolderId = await ensureFolder(drive, targetFolderId, segment)
      }
    }

    const tempPath = path.join(process.cwd(), ".tmp-upload-" + Date.now() + "-" + uploadFile.name)
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

    const url = uploaded.data.webViewLink || uploaded.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`

    const { error } = await supabase.from("cc_entry_files").upsert(
      {
        entry_kind: entryKind,
        entry_id: entryId,
        folder_path: folderPath || "",
        file_name: uploadFile.name,
        file_type: path.extname(uploadFile.name).replace(".", "").toUpperCase() || "FILE",
        drive_file_id: fileId,
        drive_url: url,
        original_path: `${entryKind}/${entryName}/${folderPath ? `${folderPath}/` : ""}${uploadFile.name}`,
      },
      {
        onConflict: "entry_kind,entry_id,original_path",
      }
    )

    if (error) throw error

    return NextResponse.json({
      file: {
        id: fileId,
        folder_path: folderPath || "",
        file_name: uploadFile.name,
        file_type: path.extname(uploadFile.name).replace(".", "").toUpperCase() || "FILE",
        drive_file_id: fileId,
        drive_url: url,
      },
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message || "Upload failed.")
          : "Upload failed."
    const details =
      typeof error === "object" && error !== null && "details" in error
        ? String((error as { details?: unknown }).details || "")
        : ""
    const hint =
      typeof error === "object" && error !== null && "hint" in error
        ? String((error as { hint?: unknown }).hint || "")
        : ""
    const joined = [message, details, hint].filter(Boolean).join(" | ")
    console.error("ccinfo upload failed", error)
    return NextResponse.json({ message: joined || "Upload failed." }, { status: 500 })
  } finally {
    const uploads = fsSync.readdirSync(process.cwd()).filter((name) => name.startsWith(".tmp-upload-"))
    await Promise.all(uploads.map((file) => fs.rm(path.join(process.cwd(), file), { force: true })))
  }
}
