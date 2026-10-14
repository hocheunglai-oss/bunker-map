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
  prepareCcinfoFileTarget,
} from "@/lib/ccinfoDrivePaths"
import { loadGoogleApis } from "@/lib/googleApis"
import { buildGoogleDriveFolderLookupQuery } from "@/lib/queryEscaping"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function folderMutationError(error: { code?: string }, operation: string) {
  const status = ["40001", "23505", "23514", "40P01", "55P03"].includes(error.code || "") ? 409 : error.code === "22023" ? 400 : 500
  const message = error.code === "23505" ? "Another folder already uses this name. No changes were saved."
    : error.code === "40001" ? "This folder or its destination changed. Reopen the entry before trying again."
      : error.code === "23514" ? "Move or delete files and subfolders inside this folder first."
        : ["40P01", "55P03"].includes(error.code || "") ? "Another change is being saved. Please try again shortly."
          : `The ${operation} could not be confirmed. Reopen the entry to check its saved folder before retrying.`
  return NextResponse.json({ message }, { status })
}

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
      .select("id,entry_kind,entry_id,folder_path,name,updated_at,implicit")
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
      const entryKind = searchParams.get("entryKind") || ""
      const entryId = searchParams.get("entryId") || ""
      const folderPath = searchParams.get("folderPath") || ""
      const expectedUpdatedAt = searchParams.get("expectedUpdatedAt") || ""
      if (!["company", "country", "port"].includes(entryKind) || !UUID.test(entryId) || !UUID.test(folderId)
        || !folderPath || !Number.isFinite(Date.parse(expectedUpdatedAt))) return NextResponse.json({ message: "Refresh this entry before deleting the folder." }, { status: 400 })
      const { data, error } = await supabase.rpc("delete_ccinfo_folder", {
        p_entry_kind: entryKind, p_entry_id: entryId, p_folder_id: folderId,
        p_folder_path: folderPath, p_expected_updated_at: expectedUpdatedAt,
      })
      if (error) return folderMutationError(error, "delete")
      return NextResponse.json({ ok: true, deletion: data })
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
      const virtual = folderId === `virtual:${folderPath}`
      const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : ""
      if (!["company", "country", "port"].includes(entryKind) || !UUID.test(entryId) || !folderPath
        || (!virtual && (!UUID.test(folderId) || !Number.isFinite(Date.parse(expectedUpdatedAt))))) {
        return NextResponse.json({ message: "Missing folder delete details." }, { status: 400 })
      }
      const { data, error } = await supabase.rpc("delete_ccinfo_folder", {
        p_entry_kind: entryKind, p_entry_id: entryId, p_folder_id: virtual ? null : folderId,
        p_folder_path: folderPath, p_expected_updated_at: virtual ? null : expectedUpdatedAt,
      })
      if (error) return folderMutationError(error, "delete")
      return NextResponse.json({ ok: true, deletion: data })
    }

    if (action === "renameFolder" || action === "moveFolder") {
      const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null
      const virtual = folderId === `virtual:${folderPath}`
      if (!["company", "country", "port"].includes(entryKind) || !UUID.test(entryId) || !folderPath
        || (action === "renameFolder" && (!name || /[\u0000-\u001f\u007f-\u009f/\\]/.test(name) || Array.from(name).length > 200))
        || (!virtual && (!UUID.test(folderId) || !expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))))) {
        return NextResponse.json({ message: "Missing folder rename details." }, { status: 400 })
      }
      const { data, error } = await supabase.rpc(action === "renameFolder" ? "rename_ccinfo_folder" : "move_ccinfo_folder", {
        p_entry_kind: entryKind, p_entry_id: entryId, p_folder_id: virtual ? null : folderId,
        p_folder_path: folderPath, p_expected_updated_at: virtual ? null : expectedUpdatedAt,
        ...(action === "renameFolder" ? { p_name: name } : { p_target_parent_path: targetFolderPath }),
      })
      if (error) return folderMutationError(error, action === "renameFolder" ? "rename" : "move")
      return NextResponse.json({ ok: true, [action === "renameFolder" ? "rename" : "move"]: data })
    }

    if (!fileId) {
      return NextResponse.json({ message: "Missing file details." }, { status: 400 })
    }

    if (!entryKind || !entryId || !entryName) {
      return NextResponse.json({ message: "Missing move details." }, { status: 400 })
    }

    const target = await prepareCcinfoFileTarget(supabase, entryKind, entryId, folderPath, folderId || null)

    if (source === "company") {
      const { data: fileRow, error: readError } = await supabase
        .from("cc_company_files")
        .select("id,file_name,original_path,updated_at")
        .eq("id", fileId)
        .eq("company_id", entryId)
        .is("deleted_at", null)
        .single()
      if (readError || !fileRow) throw readError || new Error("Unable to load file.")

      const { data, error } = await supabase.rpc("move_ccinfo_file", {
        p_entry_kind: entryKind, p_entry_id: entryId, p_source: "company", p_file_id: fileId,
        p_expected_updated_at: fileRow.updated_at, p_folder_id: target.folderId,
      })
      if (error) return folderMutationError(error, "file move")
      return NextResponse.json({ ok: true, file: data })
    }

    const { data: fileRow, error: readError } = await supabase
      .from("cc_entry_files")
      .select("id,file_name,drive_file_id,original_path,updated_at")
      .eq("id", fileId)
      .eq("entry_kind", entryKind)
      .eq("entry_id", entryId)
      .is("deleted_at", null)
      .single()
    if (readError || !fileRow) throw readError || new Error("Unable to load file.")

    if (!fileRow.drive_file_id) {
      throw new Error("This upload has no Google Drive file id.")
    }

    const { drive, rootFolderId } = await getDriveClient()
    if (!rootFolderId) throw new Error("Google Drive folder is not configured. Add GOOGLE_DRIVE_COMPANY_FOLDER_ID in Vercel.")

    const targetFolderId = await ensureEntryFolderPath(drive, rootFolderId, supabase, entryKind, entryId, entryName, target.folderPath)
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

    const { data, error } = await supabase.rpc("move_ccinfo_file", {
      p_entry_kind: entryKind, p_entry_id: entryId, p_source: "entry", p_file_id: fileId,
      p_expected_updated_at: fileRow.updated_at, p_folder_id: target.folderId,
    })
    if (error) return folderMutationError(error, "file move")
    return NextResponse.json({ ok: true, file: data })
  } catch (error) {
    console.error("ccinfo move failed", error)
    return NextResponse.json({ message: messageFromError(error) }, { status: 500 })
  }
}
