import fs from "node:fs"
import path from "node:path"
import { google } from "googleapis"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")
const ADMIN_COOKIE_NAME = "bunker_admin_auth"

function loadEnv() {
  return Object.fromEntries(
    fs
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
  const tokenRaw = fs.readFileSync(TOKEN_PATH, "utf8")
  auth.setCredentials(JSON.parse(tokenRaw))
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: env.GOOGLE_DRIVE_COMPANY_FOLDER_ID,
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

async function ensureEntryFolderPath(drive: any, rootFolderId: string, entryKind: string, entryName: string, folderPath: string) {
  const uploadsFolderId = await ensureFolder(drive, rootFolderId, "Manual Uploads")
  const kindFolderId = await ensureFolder(drive, uploadsFolderId, entryKind)
  const entryFolderId = await ensureFolder(drive, kindFolderId, entryName)
  let targetFolderId = entryFolderId
  const segments = folderPath.split("/").map((segment) => segment.trim()).filter(Boolean)
  for (const segment of segments) {
    targetFolderId = await ensureFolder(drive, targetFolderId, segment)
  }
  return targetFolderId
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

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies()
    if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    const env = loadEnv()
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    const body = await request.json()
    const entryKind = String(body.entryKind || "")
    const entryId = String(body.entryId || "")
    const folderPath = String(body.folderPath || "").trim()
    const name = String(body.name || "").trim()

    if (!entryKind || !entryId || !name) {
      return NextResponse.json({ message: "Missing folder details." }, { status: 400 })
    }

    const { data, error } = await supabase
      .from("cc_entry_folders")
      .upsert(
        {
          entry_kind: entryKind,
          entry_id: entryId,
          folder_path: folderPath,
          name,
        },
        { onConflict: "entry_kind,entry_id,folder_path,name" },
      )
      .select("id,entry_kind,entry_id,folder_path,name")
      .single()

    if (error) throw error

    return NextResponse.json({ folder: data })
  } catch (error) {
    console.error("ccinfo folder create failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies()
    if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    const env = loadEnv()
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    const { searchParams } = new URL(request.url)
    const fileId = searchParams.get("fileId")
    const folderId = searchParams.get("folderId")
    const source = searchParams.get("source") || "entry"

    if (!fileId && !folderId) {
      return NextResponse.json({ message: "Missing delete target." }, { status: 400 })
    }

    if (folderId) {
      const { error } = await supabase.from("cc_entry_folders").delete().eq("id", folderId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (fileId && source === "company") {
      const { data, error: readError } = await supabase
        .from("cc_company_files")
        .select("id,drive_file_id")
        .eq("id", fileId)
        .single()
      if (readError) throw readError

      if (data?.drive_file_id) {
        const { drive } = await getDriveClient()
        await drive.files.delete({
          fileId: data.drive_file_id,
          supportsAllDrives: true,
        })
      }

      const { error } = await supabase.from("cc_company_files").delete().eq("id", fileId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    const { data, error: readError } = await supabase
      .from("cc_entry_files")
      .select("id,drive_file_id")
      .eq("id", fileId)
      .single()
    if (readError) throw readError

    if (data?.drive_file_id) {
      const { drive } = await getDriveClient()
      await drive.files.delete({
        fileId: data.drive_file_id,
        supportsAllDrives: true,
      })
    }

    const { error } = await supabase.from("cc_entry_files").delete().eq("id", fileId)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("ccinfo delete failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies()
    if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    const env = loadEnv()
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    const body = await request.json()
    const fileId = String(body.fileId || "")
    const source = String(body.source || "entry")
    const entryKind = String(body.entryKind || "")
    const entryId = String(body.entryId || "")
    const entryName = String(body.entryName || "")
    const folderPath = String(body.folderPath || "").trim()

    if (!fileId || !entryKind || !entryId || !entryName) {
      return NextResponse.json({ message: "Missing move details." }, { status: 400 })
    }

    if (source === "company") {
      return NextResponse.json({ message: "Legacy company files cannot be moved into folders yet." }, { status: 400 })
    }

    const { data: fileRow, error: readError } = await supabase
      .from("cc_entry_files")
      .select("id,file_name,drive_file_id,original_path")
      .eq("id", fileId)
      .single()
    if (readError || !fileRow) throw readError || new Error("Unable to load file.")

    if (!fileRow.drive_file_id) {
      throw new Error("This upload has no Google Drive file id.")
    }

    const { drive, rootFolderId } = await getDriveClient()
    if (!rootFolderId) throw new Error("Google Drive folder is not configured.")

    const targetFolderId = await ensureEntryFolderPath(drive, rootFolderId, entryKind, entryName, folderPath)
    const current = await drive.files.get({
      fileId: fileRow.drive_file_id,
      fields: "parents",
      supportsAllDrives: true,
    })
    const previousParents = (current.data.parents || []).join(",")

    await drive.files.update({
      fileId: fileRow.drive_file_id,
      addParents: targetFolderId,
      removeParents: previousParents || undefined,
      fields: "id, parents",
      supportsAllDrives: true,
    })

    const { error } = await supabase
      .from("cc_entry_files")
      .update({
        folder_path: folderPath,
        original_path: `${entryKind}/${entryName}/${folderPath ? `${folderPath}/` : ""}${fileRow.file_name}`,
      })
      .eq("id", fileId)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("ccinfo move failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}
