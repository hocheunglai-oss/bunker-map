import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  ensureCcinfoDriveFolderPath,
  loadCcinfoDriveContext,
} from "@/lib/ccinfoDrivePaths"
import { loadGoogleApis } from "@/lib/googleApis"
import { buildGoogleDriveFolderLookupQuery } from "@/lib/queryEscaping"

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
  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      throw new Error("Google Drive is not authorized on the hosted app yet. Add GOOGLE_DRIVE_REFRESH_TOKEN in Vercel.")
    }
    const tokenRaw = fs.readFileSync(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(tokenRaw))
  }
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: process.env.GOOGLE_DRIVE_COMPANY_FOLDER_ID || null,
  }
}

async function ensureFolder(drive: any, parentId: string, name: string) {
  const lookup = await drive.files.list({
    q: buildGoogleDriveFolderLookupQuery(parentId, name),
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

async function ensureEntryFolderPath(
  drive: any,
  rootFolderId: string,
  supabase: ReturnType<typeof createAdminAuditedSupabaseClient>,
  entryKind: string,
  entryId: string,
  entryName: string,
  folderPath: string,
) {
  const driveContext = await loadCcinfoDriveContext(supabase, entryKind, entryId, entryName, folderPath)
  return ensureCcinfoDriveFolderPath(drive, rootFolderId, driveContext, ensureFolder)
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

async function deleteDriveFileIfPresent(driveFileId: string | null | undefined) {
  if (!driveFileId) return
  try {
    const { drive } = await getDriveClient()
    await drive.files.delete({
      fileId: driveFileId,
      supportsAllDrives: true,
    })
  } catch (error) {
    console.warn("ccinfo drive delete skipped", {
      driveFileId,
      message: messageFromError(error),
    })
  }
}

async function renameDriveFileIfPresent(driveFileId: string | null | undefined, name: string) {
  if (!driveFileId) return
  try {
    const { drive } = await getDriveClient()
    await drive.files.update({
      fileId: driveFileId,
      requestBody: { name },
      supportsAllDrives: true,
    })
  } catch (error) {
    console.warn("ccinfo drive rename skipped", {
      driveFileId,
      message: messageFromError(error),
    })
  }
}

function deriveFolderPathFromOriginalPath(originalPath?: string | null) {
  if (!originalPath) return ""
  const normalized = originalPath.replace(/\\/g, "/")
  const archiveMatch = normalized.match(/- Company Information\/[^/]+\/(.+)$/)
  if (archiveMatch?.[1]) {
    const segments = archiveMatch[1].split("/").filter(Boolean)
    return segments.slice(0, -1).join("/")
  }
  const genericMatch = normalized.match(/company\/[^/]+\/(.+)$/i)
  if (genericMatch?.[1]) {
    const segments = genericMatch[1].split("/").filter(Boolean)
    return segments.slice(0, -1).join("/")
  }
  return ""
}

function setFolderPathInOriginalPath(originalPath: string | null | undefined, folderPath: string, fileName: string, entryKind = "company", entryName = "Untitled") {
  const normalized = (originalPath || "").replace(/\\/g, "/")
  const suffix = `${folderPath ? `${folderPath}/` : ""}${fileName}`
  const archiveMatch = normalized.match(/^(.*- Company Information\/[^/]+)(?:\/.*)?$/)
  if (archiveMatch?.[1]) return `${archiveMatch[1]}/${suffix}`
  const genericMatch = normalized.match(new RegExp(`^(${entryKind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/[^/]+)(?:\\/.*)?$`, "i"))
  if (genericMatch?.[1]) return `${genericMatch[1]}/${suffix}`
  return `${entryKind}/${entryName}/${suffix}`
}

function rebaseFolderPath(currentPath: string, sourcePath: string, targetParentPath: string) {
  const folderName = sourcePath.split("/").filter(Boolean).pop() || sourcePath
  const nextRoot = [targetParentPath, folderName].filter(Boolean).join("/")
  if (currentPath === sourcePath) return nextRoot
  if (currentPath.startsWith(`${sourcePath}/`)) return `${nextRoot}${currentPath.slice(sourcePath.length)}`
  return currentPath
}

function canMoveFolderToPath(sourcePath: string, targetParentPath: string) {
  const currentParentPath = sourcePath.split("/").filter(Boolean).slice(0, -1).join("/")
  if (!sourcePath || currentParentPath === targetParentPath) return false
  if (targetParentPath === sourcePath || targetParentPath.startsWith(`${sourcePath}/`)) return false
  return true
}

async function requireCcinfoFileAccess(request: Request) {
  // CCINFO document management is intentionally collaborative for anyone
  // who can view CCINFO. Other CCINFO content edits remain protected by
  // the page-level edit checks used by the Supabase mutation proxy.
  const session = await requireAdminPagePermission("ccinfo", "view")
  return createAdminAuditedSupabaseClient(
    createAdminAuditContext(session, request, "ccinfo"),
    { useServiceRole: true },
  )
}

function renameOriginalPathBasename(originalPath: string | null | undefined, nextName: string, entryKind = "company", entryName = "Untitled") {
  const folderPath = deriveFolderPathFromOriginalPath(originalPath)
  return setFolderPathInOriginalPath(originalPath, folderPath, nextName, entryKind, entryName)
}

export async function POST(request: Request) {
  try {
    const supabase = await requireCcinfoFileAccess(request)
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
    const supabase = await requireCcinfoFileAccess(request)
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
        .select("id")
        .eq("id", fileId)
        .single()
      if (readError) throw readError

      const { error } = await supabase
        .from("cc_company_files")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", data.id)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    const { data: initialData, error: readError } = await supabase
      .from("cc_entry_files")
      .select("id")
      .eq("id", fileId)
      .maybeSingle()
    if (readError) throw readError
    let data = initialData

    if (!data) {
      const fallbackLookup = await supabase
        .from("cc_entry_files")
        .select("id")
        .eq("drive_file_id", fileId)
        .maybeSingle()
      if (fallbackLookup.error) throw fallbackLookup.error
      data = fallbackLookup.data
    }

    if (!data) {
      return NextResponse.json({ message: "File not found." }, { status: 404 })
    }

    const { error } = await supabase
      .from("cc_entry_files")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.id)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("ccinfo delete failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await requireCcinfoFileAccess(request)
    const body = await request.json()
    const fileId = String(body.fileId || "")
    const folderId = String(body.folderId || "")
    const source = String(body.source || "entry")
    const action = String(body.action || "move")
    const entryKind = String(body.entryKind || "")
    const entryId = String(body.entryId || "")
    const entryName = String(body.entryName || "")
    const folderPath = String(body.folderPath || "").trim()
    const targetFolderPath = String(body.targetFolderPath || "").trim()
    const name = String(body.name || "").trim()

    if (action === "restore") {
      if (!fileId) {
        return NextResponse.json({ message: "Missing file details." }, { status: 400 })
      }
      if (source === "company") {
        const { error } = await supabase
          .from("cc_company_files")
          .update({ deleted_at: null })
          .eq("id", fileId)
        if (error) throw error
        return NextResponse.json({ ok: true })
      }

      const { error } = await supabase
        .from("cc_entry_files")
        .update({ deleted_at: null })
        .eq("id", fileId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (action === "renameFile") {
      if (!fileId || !name) {
        return NextResponse.json({ message: "Missing file rename details." }, { status: 400 })
      }

      if (source === "company") {
        const { data: fileRow, error: readError } = await supabase
          .from("cc_company_files")
          .select("id,file_name,drive_file_id,original_path")
          .eq("id", fileId)
          .single()
        if (readError || !fileRow) throw readError || new Error("Unable to load file.")

        await renameDriveFileIfPresent(fileRow.drive_file_id, name)
        const { error } = await supabase
          .from("cc_company_files")
          .update({
            file_name: name,
            file_type: path.extname(name).slice(1).toLowerCase() || "file",
            original_path: renameOriginalPathBasename(fileRow.original_path, name, "company", entryName),
          })
          .eq("id", fileId)
        if (error) throw error
        return NextResponse.json({ ok: true })
      }

      const { data: fileRow, error: readError } = await supabase
        .from("cc_entry_files")
        .select("id,file_name,drive_file_id,original_path,folder_path")
        .eq("id", fileId)
        .single()
      if (readError || !fileRow) throw readError || new Error("Unable to load file.")

      await renameDriveFileIfPresent(fileRow.drive_file_id, name)
      const { error } = await supabase
        .from("cc_entry_files")
        .update({
          file_name: name,
          file_type: path.extname(name).slice(1).toLowerCase() || "file",
          original_path: `${entryKind}/${entryName}/${fileRow.folder_path ? `${fileRow.folder_path}/` : ""}${name}`,
        })
        .eq("id", fileId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (action === "deleteFolderContents") {
      if (!entryId || !folderPath) {
        return NextResponse.json({ message: "Missing folder delete details." }, { status: 400 })
      }

      if (source === "company") {
        const { data: companyFiles, error: fileReadError } = await supabase
          .from("cc_company_files")
          .select("id,original_path")
          .eq("company_id", entryId)
          .is("deleted_at", null)
        if (fileReadError) throw fileReadError

        const ids = (companyFiles || [])
          .filter((file) => {
            const currentPath = deriveFolderPathFromOriginalPath(file.original_path)
            return currentPath === folderPath || currentPath.startsWith(`${folderPath}/`)
          })
          .map((file) => file.id)

        if (ids.length > 0) {
          const { error } = await supabase
            .from("cc_company_files")
            .update({ deleted_at: new Date().toISOString() })
            .in("id", ids)
          if (error) throw error
        }

        return NextResponse.json({ ok: true, count: ids.length })
      }

      return NextResponse.json({ message: "Only imported company folders can be deleted with contents." }, { status: 400 })
    }

    if (action === "moveFolder") {
      if (!entryKind || !entryId || !folderPath) {
        return NextResponse.json({ message: "Missing folder move details." }, { status: 400 })
      }

      if (!canMoveFolderToPath(folderPath, targetFolderPath)) {
        return NextResponse.json({ ok: true, skipped: true })
      }

      if (source === "company") {
        const { data: companyFiles, error: fileReadError } = await supabase
          .from("cc_company_files")
          .select("id,file_name,original_path")
          .eq("company_id", entryId)
          .is("deleted_at", null)
        if (fileReadError) throw fileReadError

        for (const file of companyFiles || []) {
          const currentPath = deriveFolderPathFromOriginalPath(file.original_path)
          if (currentPath !== folderPath && !currentPath.startsWith(`${folderPath}/`)) continue
          const nextFolderPath = rebaseFolderPath(currentPath, folderPath, targetFolderPath)
          const { error } = await supabase
            .from("cc_company_files")
            .update({ original_path: setFolderPathInOriginalPath(file.original_path, nextFolderPath, file.file_name, "company", entryName) })
            .eq("id", file.id)
          if (error) throw error
        }

        return NextResponse.json({ ok: true })
      }

      const { data: folderRows, error: folderReadError } = await supabase
        .from("cc_entry_folders")
        .select("id,folder_path,name")
        .eq("entry_kind", entryKind)
        .eq("entry_id", entryId)
      if (folderReadError) throw folderReadError

      for (const folder of folderRows || []) {
        const currentFullPath = [folder.folder_path, folder.name].filter(Boolean).join("/")
        if (currentFullPath !== folderPath && !currentFullPath.startsWith(`${folderPath}/`)) continue
        const nextFullPath = rebaseFolderPath(currentFullPath, folderPath, targetFolderPath)
        const segments = nextFullPath.split("/").filter(Boolean)
        const nextName = segments.pop() || folder.name
        const nextParentPath = segments.join("/")
        const { error } = await supabase
          .from("cc_entry_folders")
          .update({ folder_path: nextParentPath, name: nextName })
          .eq("id", folder.id)
        if (error) throw error
      }

      const { data: affectedFiles, error: fileReadError } = await supabase
        .from("cc_entry_files")
        .select("id,folder_path,file_name")
        .eq("entry_kind", entryKind)
        .eq("entry_id", entryId)
        .or(`folder_path.eq.${folderPath},folder_path.like.${folderPath}/%`)
      if (fileReadError) throw fileReadError

      for (const file of affectedFiles || []) {
        const nextFolderPath = rebaseFolderPath(String(file.folder_path || ""), folderPath, targetFolderPath)
        const { error } = await supabase
          .from("cc_entry_files")
          .update({
            folder_path: nextFolderPath,
            original_path: `${entryKind}/${entryName}/${nextFolderPath ? `${nextFolderPath}/` : ""}${file.file_name}`,
          })
          .eq("id", file.id)
        if (error) throw error
      }

      return NextResponse.json({ ok: true })
    }

    if (action === "renameFolder") {
      if (!name || !entryKind || !entryId) {
        return NextResponse.json({ message: "Missing folder rename details." }, { status: 400 })
      }

      if (source === "company") {
        if (!folderPath) {
          return NextResponse.json({ message: "Missing imported folder path." }, { status: 400 })
        }

        const parentPath = folderPath.split("/").slice(0, -1).join("/")
        const newFullPath = [parentPath, name].filter(Boolean).join("/")
        const { data: companyFiles, error: fileReadError } = await supabase
          .from("cc_company_files")
          .select("id,file_name,original_path")
          .eq("company_id", entryId)
          .is("deleted_at", null)
        if (fileReadError) throw fileReadError

        for (const file of companyFiles || []) {
          const currentPath = deriveFolderPathFromOriginalPath(file.original_path)
          if (currentPath !== folderPath && !currentPath.startsWith(`${folderPath}/`)) continue
          const nextFolderPath = currentPath.replace(folderPath, newFullPath)
          const { error } = await supabase
            .from("cc_company_files")
            .update({ original_path: setFolderPathInOriginalPath(file.original_path, nextFolderPath, file.file_name, "company", entryName) })
            .eq("id", file.id)
          if (error) throw error
        }

        return NextResponse.json({ ok: true })
      }

      if (!folderId) {
        return NextResponse.json({ message: "Missing folder rename details." }, { status: 400 })
      }

      const { data: folderRow, error: folderReadError } = await supabase
        .from("cc_entry_folders")
        .select("id,folder_path,name")
        .eq("id", folderId)
        .single()
      if (folderReadError || !folderRow) throw folderReadError || new Error("Unable to load folder.")

      const oldFullPath = [folderRow.folder_path, folderRow.name].filter(Boolean).join("/")
      const newFullPath = [folderRow.folder_path, name].filter(Boolean).join("/")

      const { error: folderUpdateError } = await supabase
        .from("cc_entry_folders")
        .update({ name })
        .eq("id", folderId)
      if (folderUpdateError) throw folderUpdateError

      const { data: nestedFolders, error: nestedFolderError } = await supabase
        .from("cc_entry_folders")
        .select("id,folder_path")
        .eq("entry_kind", entryKind)
        .eq("entry_id", entryId)
        .like("folder_path", `${oldFullPath}/%`)
      if (nestedFolderError) throw nestedFolderError

      for (const nested of nestedFolders || []) {
        const nextFolderPath = String(nested.folder_path || "").replace(oldFullPath, newFullPath)
        const { error } = await supabase.from("cc_entry_folders").update({ folder_path: nextFolderPath }).eq("id", nested.id)
        if (error) throw error
      }

      const { data: affectedFiles, error: fileReadError } = await supabase
        .from("cc_entry_files")
        .select("id,folder_path,original_path,file_name")
        .eq("entry_kind", entryKind)
        .eq("entry_id", entryId)
        .or(`folder_path.eq.${oldFullPath},folder_path.like.${oldFullPath}/%`)
      if (fileReadError) throw fileReadError

      for (const file of affectedFiles || []) {
        const nextFolderPath = String(file.folder_path || "").replace(oldFullPath, newFullPath)
        const nextOriginalPath = `${entryKind}/${entryName}/${nextFolderPath ? `${nextFolderPath}/` : ""}${file.file_name}`
        const { error } = await supabase
          .from("cc_entry_files")
          .update({ folder_path: nextFolderPath, original_path: nextOriginalPath })
          .eq("id", file.id)
        if (error) throw error
      }

      return NextResponse.json({ ok: true })
    }

    if (!fileId) {
      return NextResponse.json({ message: "Missing file details." }, { status: 400 })
    }

    if (!entryKind || !entryId || !entryName) {
      return NextResponse.json({ message: "Missing move details." }, { status: 400 })
    }

    if (source === "company") {
      const { data: fileRow, error: readError } = await supabase
        .from("cc_company_files")
        .select("id,file_name,original_path")
        .eq("id", fileId)
        .single()
      if (readError || !fileRow) throw readError || new Error("Unable to load file.")

      const { error } = await supabase
        .from("cc_company_files")
        .update({
          original_path: setFolderPathInOriginalPath(fileRow.original_path, folderPath, fileRow.file_name, entryKind, entryName),
        })
        .eq("id", fileId)
      if (error) throw error
      return NextResponse.json({ ok: true })
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
    if (!rootFolderId) throw new Error("Google Drive folder is not configured. Add GOOGLE_DRIVE_COMPANY_FOLDER_ID in Vercel.")

    const targetFolderId = await ensureEntryFolderPath(drive, rootFolderId, supabase, entryKind, entryId, entryName, folderPath)
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
