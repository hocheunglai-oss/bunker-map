import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  ensureCcinfoDriveFolderPath,
  loadCcinfoDriveContext,
} from "@/lib/ccinfoDrivePaths"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const EXCLUDED_ROOT_FOLDERS = new Set([
  "BUNKERWIRE",
  "COQ",
  "EUROPEAN MARKETSCAN",
  "FC MARINE ENERGY",
  "HSFO",
  "LSMGO",
  "PLATTS",
  "VLSFO",
])
const CONTAINER_FOLDERS = new Set(["COMPANIES", "COUNTRIES", "PORTS"])

type DriveFolder = {
  id: string
  name: string
  parents?: string[]
}

type EntryFile = {
  id: string
  entry_kind: string
  entry_id: string
  folder_path: string | null
  file_name: string | null
  drive_file_id: string | null
  original_path: string | null
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function messageFromError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message || "Request failed.")
  }
  return "Request failed."
}

function normalizeName(name: string | null | undefined) {
  return String(name || "").replace(/\s+/g, " ").trim().toUpperCase()
}

function cleanCountryName(name: string) {
  return name.replace(/^!+/, "").replace(/\s+/g, " ").trim()
}

function hasCleanupAccess(request: Request) {
  const cleanupToken = process.env.CCINFO_CLEANUP_TOKEN
  const authorization = request.headers.get("authorization")
  return Boolean(cleanupToken && authorization === `Bearer ${cleanupToken}`)
}

async function requireCleanupAccess(request: Request) {
  if (hasCleanupAccess(request)) return
  await requireAdminPagePermission("ccinfo", "edit")
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  auth.setCredentials({ refresh_token: requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN") })
  return {
    drive: google.drive({ version: "v3", auth }),
    rootFolderId: requireEnv("GOOGLE_DRIVE_COMPANY_FOLDER_ID"),
  }
}

async function fetchCompanyNames() {
  const supabase = getSupabaseClient()
  const names = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from("cc_companies")
      .select("name")
      .range(offset, offset + 999)
    if (error) throw error
    for (const row of data || []) {
      const name = normalizeName(row.name)
      if (name) names.add(name)
    }
    if (!data || data.length < 1000) break
  }
  return names
}

async function fetchCountryNames() {
  const supabase = getSupabaseClient()
  const names = new Set<string>()
  const { data, error } = await supabase.from("cc_countries").select("name")
  if (error) throw error
  for (const row of data || []) {
    const name = normalizeName(row.name)
    if (name) names.add(name)
  }
  return names
}

async function listChildFolders(drive: any, parentId: string) {
  const folders: DriveFolder[] = []
  let pageToken: string | undefined
  do {
    const response = await drive.files.list({
      q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents`,
      fields: "nextPageToken,files(id,name,parents)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    folders.push(...((response.data.files || []) as DriveFolder[]))
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

async function listChildren(drive: any, parentId: string) {
  const children: { id: string; name: string; mimeType: string }[] = []
  let pageToken: string | undefined
  do {
    const response = await drive.files.list({
      q: `trashed = false and '${parentId}' in parents`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    children.push(...((response.data.files || []) as { id: string; name: string; mimeType: string }[]))
    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)
  return children.sort((a, b) => a.name.localeCompare(b.name))
}

async function findChildFolderByName(drive: any, parentId: string, name: string) {
  const escapedName = name.replace(/'/g, "\\'")
  const response = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentId}' in parents`,
    fields: "files(id,name,parents)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (response.data.files || [])[0] as DriveFolder | undefined
}

async function ensureFolder(drive: any, parentId: string, name: string) {
  const existing = await findChildFolderByName(drive, parentId, name)
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

async function buildPlan() {
  const [{ drive, rootFolderId }, companyNames, countryNames] = await Promise.all([
    Promise.resolve(getDriveClient()),
    fetchCompanyNames(),
    fetchCountryNames(),
  ])
  const rootFolders = await listChildFolders(drive, rootFolderId)
  const containerFolders = rootFolders.filter((folder) => CONTAINER_FOLDERS.has(normalizeName(folder.name)))
  const excludedFolders = rootFolders.filter((folder) => EXCLUDED_ROOT_FOLDERS.has(normalizeName(folder.name)))
  const countryCandidates = rootFolders.filter((folder) => {
    const name = normalizeName(folder.name)
    return folder.name.startsWith("!") && !EXCLUDED_ROOT_FOLDERS.has(name) && !CONTAINER_FOLDERS.has(name)
  })
  const companyCandidates = rootFolders.filter((folder) => {
    const name = normalizeName(folder.name)
    return (
      companyNames.has(name) &&
      !folder.name.startsWith("!") &&
      !EXCLUDED_ROOT_FOLDERS.has(name) &&
      !CONTAINER_FOLDERS.has(name)
    )
  })
  const possibleCountryNameMatches = rootFolders.filter((folder) => {
    const name = normalizeName(folder.name)
    return countryNames.has(name) && !folder.name.startsWith("!") && !CONTAINER_FOLDERS.has(name)
  })
  const plannedIds = new Set([...countryCandidates, ...companyCandidates, ...excludedFolders, ...containerFolders].map((folder) => folder.id))
  const unknownFolders = rootFolders.filter((folder) => !plannedIds.has(folder.id))

  return {
    drive,
    rootFolderId,
    rootFolders,
    countryCandidates,
    companyCandidates,
    possibleCountryNameMatches,
    excludedFolders,
    containerFolders,
    unknownFolders,
  }
}

async function fetchEntryFiles(supabase: ReturnType<typeof getSupabaseClient>) {
  const rows: EntryFile[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from("cc_entry_files")
      .select("id,entry_kind,entry_id,folder_path,file_name,drive_file_id,original_path")
      .is("deleted_at", null)
      .not("drive_file_id", "is", null)
      .range(offset, offset + 999)
    if (error) throw error
    rows.push(...((data || []) as EntryFile[]))
    if (!data || data.length < 1000) break
  }
  return rows
}

async function collectManualUploads(drive: any, rootFolderId: string) {
  const manualFolder = await findChildFolderByName(drive, rootFolderId, "Manual Uploads")
  if (!manualFolder?.id) {
    return {
      exists: false,
      folders: 0,
      files: 0,
      sample: [] as string[],
      id: null as string | null,
      fileParentById: new Map<string, string>(),
    }
  }

  const queue = [manualFolder.id]
  let folders = 0
  let files = 0
  const sample: string[] = []
  const fileParentById = new Map<string, string>()
  while (queue.length > 0) {
    const folderId = queue.shift()!
    const children = await listChildren(drive, folderId)
    for (const child of children) {
      const isFolder = child.mimeType === "application/vnd.google-apps.folder"
      if (isFolder) {
        folders += 1
        queue.push(child.id)
      } else {
        files += 1
        fileParentById.set(child.id, folderId)
      }
      if (sample.length < 50) sample.push(child.name)
    }
  }
  return { exists: true, id: manualFolder.id, folders, files, sample, fileParentById }
}

async function summarizeManualUploads(drive: any, rootFolderId: string) {
  const manualUploads = await collectManualUploads(drive, rootFolderId)
  return {
    exists: manualUploads.exists,
    id: manualUploads.id,
    folders: manualUploads.folders,
    files: manualUploads.files,
    sample: manualUploads.sample,
  }
}

function summarizePlan(plan: Awaited<ReturnType<typeof buildPlan>>) {
  return {
    rootFolderCount: plan.rootFolders.length,
    countriesToMove: plan.countryCandidates.length,
    companiesToMove: plan.companyCandidates.length,
    possibleCountryNameMatchesNotMoved: plan.possibleCountryNameMatches.map((folder) => folder.name).slice(0, 50),
    excludedRootFolders: plan.excludedFolders.map((folder) => folder.name),
    existingContainers: plan.containerFolders.map((folder) => folder.name),
    unknownRootFolderCount: plan.unknownFolders.length,
    countriesSample: plan.countryCandidates.map((folder) => folder.name).slice(0, 50),
    companiesSample: plan.companyCandidates.map((folder) => folder.name).slice(0, 50),
    unknownSample: plan.unknownFolders.map((folder) => folder.name).slice(0, 50),
  }
}

async function moveFolder(drive: any, folder: DriveFolder, targetParentId: string, rootFolderId: string, nextName?: string) {
  const requestBody = nextName && nextName !== folder.name ? { name: nextName } : undefined
  await drive.files.update({
    fileId: folder.id,
    addParents: targetParentId,
    removeParents: rootFolderId,
    requestBody,
    fields: "id,name,parents",
    supportsAllDrives: true,
  })
}

export async function GET(request: Request) {
  try {
    await requireCleanupAccess(request)
    const plan = await buildPlan()
    return NextResponse.json(summarizePlan(plan))
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireCleanupAccess(request)
    const body = await request.json().catch(() => ({}))
    const action = String(body.action || "")
    const limit = Math.max(1, Math.min(200, Number(body.limit || 50)))
    const plan = await buildPlan()

    if (action === "create-containers") {
      const countriesFolderId = await ensureFolder(plan.drive, plan.rootFolderId, "Countries")
      const companiesFolderId = await ensureFolder(plan.drive, plan.rootFolderId, "Companies")
      return NextResponse.json({ action, countriesFolderId, companiesFolderId, plan: summarizePlan(await buildPlan()) })
    }

    if (action === "move-countries") {
      const countriesFolderId = await ensureFolder(plan.drive, plan.rootFolderId, "Countries")
      const moved = []
      const skipped = []
      for (const folder of plan.countryCandidates) {
        const nextName = cleanCountryName(folder.name)
        const conflict = await findChildFolderByName(plan.drive, countriesFolderId, nextName)
        if (conflict?.id) {
          skipped.push({ id: folder.id, name: folder.name, reason: `Countries/${nextName} already exists` })
          continue
        }
        await moveFolder(plan.drive, folder, countriesFolderId, plan.rootFolderId, nextName)
        moved.push({ id: folder.id, from: folder.name, to: `Countries/${nextName}` })
      }
      return NextResponse.json({ action, moved, skipped, plan: summarizePlan(await buildPlan()) })
    }

    if (action === "move-companies") {
      const companiesFolderId = await ensureFolder(plan.drive, plan.rootFolderId, "Companies")
      const batch = plan.companyCandidates.slice(0, limit)
      const moved = []
      const skipped = []
      for (const folder of batch) {
        const conflict = await findChildFolderByName(plan.drive, companiesFolderId, folder.name)
        if (conflict?.id) {
          skipped.push({ id: folder.id, name: folder.name, reason: `Companies/${folder.name} already exists` })
          continue
        }
        await moveFolder(plan.drive, folder, companiesFolderId, plan.rootFolderId)
        moved.push({ id: folder.id, from: folder.name, to: `Companies/${folder.name}` })
      }
      return NextResponse.json({ action, moved: moved.length, skipped, movedSample: moved.slice(0, 20), plan: summarizePlan(await buildPlan()) })
    }

    if (action === "move-entry-files") {
      const supabase = getSupabaseClient()
      const rows = await fetchEntryFiles(supabase)
      const manualUploads = await collectManualUploads(plan.drive, plan.rootFolderId)
      const rowsStillInManualUploads = rows.filter((row) =>
        Boolean(row.drive_file_id && manualUploads.fileParentById.has(row.drive_file_id)),
      )
      const moved = []
      const targetFolderCache = new Map<string, string>()
      for (const row of rowsStillInManualUploads) {
        if (moved.length >= limit) break
        if (!row.drive_file_id) continue

        const targetCacheKey = `${row.entry_kind}:${row.entry_id}:${row.folder_path || ""}`
        let targetFolderId = targetFolderCache.get(targetCacheKey)
        let context: Awaited<ReturnType<typeof loadCcinfoDriveContext>> | null = null
        if (!targetFolderId) {
          context = await loadCcinfoDriveContext(
            supabase,
            row.entry_kind,
            row.entry_id,
            row.original_path?.split("/")?.[1] || row.entry_kind,
            row.folder_path || "",
          )
          targetFolderId = await ensureCcinfoDriveFolderPath(plan.drive, plan.rootFolderId, context, ensureFolder)
          targetFolderCache.set(targetCacheKey, targetFolderId)
        }

        await plan.drive.files.update({
          fileId: row.drive_file_id,
          addParents: targetFolderId,
          removeParents: manualUploads.fileParentById.get(row.drive_file_id),
          fields: "id,parents",
          supportsAllDrives: true,
        })
        if (!context) {
          context = await loadCcinfoDriveContext(
            supabase,
            row.entry_kind,
            row.entry_id,
            row.original_path?.split("/")?.[1] || row.entry_kind,
            row.folder_path || "",
          )
        }
        moved.push({
          id: row.id,
          entry_kind: row.entry_kind,
          file_name: row.file_name,
          to: context.entryKind === "country"
            ? `Countries/${context.countryName || context.entryName}`
            : context.entryKind === "company"
              ? `Companies/${context.companyName || context.entryName}`
              : context.entryKind,
        })
      }
      return NextResponse.json({
        action,
        moved: moved.length,
        remainingInManualUploads: Math.max(rowsStillInManualUploads.length - moved.length, 0),
        manualUploadsFilesBefore: manualUploads.files,
        movedSample: moved.slice(0, 20),
      })
    }

    if (action === "manual-uploads-summary") {
      return NextResponse.json({ action, manualUploads: await summarizeManualUploads(plan.drive, plan.rootFolderId) })
    }

    if (action === "delete-empty-manual-uploads") {
      const manualUploads = await summarizeManualUploads(plan.drive, plan.rootFolderId)
      if (!manualUploads.exists) return NextResponse.json({ action, deleted: false, reason: "Manual Uploads does not exist." })
      if (!manualUploads.id) return NextResponse.json({ action, deleted: false, reason: "Manual Uploads folder id was not available." }, { status: 409 })
      if (manualUploads.files > 0) {
        return NextResponse.json({ action, deleted: false, reason: "Manual Uploads still contains files.", manualUploads }, { status: 409 })
      }
      await plan.drive.files.delete({ fileId: manualUploads.id, supportsAllDrives: true })
      return NextResponse.json({ action, deleted: true, manualUploads })
    }

    return NextResponse.json({ message: "Unknown action." }, { status: 400 })
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}
