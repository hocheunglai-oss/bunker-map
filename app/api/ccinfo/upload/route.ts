import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { google } from "googleapis"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

function loadEnv() {
  return Object.fromEntries(
    fsSync
      .readFileSync(path.join(process.cwd(), ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line: string) => !line.trim().startsWith("#"))
      .map((line: string) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

async function getDriveClient() {
  const env = loadEnv()
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  const tokenRaw = await fs.readFile(TOKEN_PATH, "utf8")
  auth.setCredentials(JSON.parse(tokenRaw))
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: env.GOOGLE_DRIVE_COMPANY_FOLDER_ID,
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
  const cookieStore = cookies()
  if (cookieStore.get("admin-auth")?.value !== "true") {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const formData = await request.formData()
  const entryKind = String(formData.get("entryKind") || "")
  const entryId = String(formData.get("entryId") || "")
  const entryName = String(formData.get("entryName") || "Untitled")
  const uploadFile = formData.get("file")

  if (!entryKind || !entryId || !(uploadFile instanceof File)) {
    return NextResponse.json({ message: "Missing upload data." }, { status: 400 })
  }

  const { drive, rootFolderId } = await getDriveClient()
  if (!rootFolderId) {
    return NextResponse.json({ message: "Google Drive folder is not configured." }, { status: 500 })
  }

  const uploadsFolderId = await ensureFolder(drive, rootFolderId, "Manual Uploads")
  const kindFolderId = await ensureFolder(drive, uploadsFolderId, entryKind)
  const entryFolderId = await ensureFolder(drive, kindFolderId, entryName)

  const tempPath = path.join(process.cwd(), ".tmp-upload-" + Date.now() + "-" + uploadFile.name)
  const bytes = Buffer.from(await uploadFile.arrayBuffer())
  await fs.writeFile(tempPath, bytes)

  try {
    const uploaded = await drive.files.create({
      requestBody: {
        name: uploadFile.name,
        parents: [entryFolderId],
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

    const { error } = await supabase.from("cc_entry_files").upsert({
      entry_kind: entryKind,
      entry_id: entryId,
      file_name: uploadFile.name,
      file_type: path.extname(uploadFile.name).replace(".", "").toUpperCase() || "FILE",
      drive_file_id: fileId,
      drive_url: url,
      original_path: `${entryKind}/${entryName}/${uploadFile.name}`,
    })

    if (error) throw error

    return NextResponse.json({
      file: {
        id: fileId,
        file_name: uploadFile.name,
        file_type: path.extname(uploadFile.name).replace(".", "").toUpperCase() || "FILE",
        drive_file_id: fileId,
        drive_url: url,
      },
    })
  } finally {
    await fs.rm(tempPath, { force: true })
  }
}
