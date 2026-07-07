import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

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

    return NextResponse.json({ message: "Unknown action." }, { status: 400 })
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}
