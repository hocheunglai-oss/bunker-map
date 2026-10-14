export type CcinfoDriveContext = {
  entryKind: string
  entryName: string
  countryName?: string | null
  companyName?: string | null
  portName?: string | null
  folderPath?: string | null
}

type SupabaseLike = {
  from: (table: string) => any
}

type FileTargetClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
}

export type CcinfoFileTarget = { entryKind: string; entryId: string; entryName: string; folderId: string | null; folderPath: string }

export async function prepareCcinfoFileTarget(supabase: FileTargetClient, entryKind: string, entryId: string, folderPath: string, folderId: string | null = null): Promise<CcinfoFileTarget> {
  const { data, error } = await supabase.rpc("prepare_ccinfo_file_target", {
    p_entry_kind: entryKind, p_entry_id: entryId, p_folder_id: folderId, p_folder_path: folderPath,
  })
  if (error) throw new Error("The destination folder changed or could not be checked. Reopen the entry before uploading or moving this file.")
  const target = data as CcinfoFileTarget
  if (!target || target.entryKind !== entryKind || target.entryId !== entryId || typeof target.entryName !== "string"
    || typeof target.folderPath !== "string" || (target.folderId !== null && typeof target.folderId !== "string")
    || (target.folderPath !== "" && !target.folderId)) throw new Error("The destination folder could not be confirmed. Reopen the entry before trying again.")
  return target
}

export async function registerCcinfoUploadedFile(supabase: FileTargetClient, target: CcinfoFileTarget, file: { name: string; type: string; driveId: string; url: string }) {
  const { data, error } = await supabase.rpc("register_ccinfo_file", {
    p_entry_kind: target.entryKind, p_entry_id: target.entryId, p_folder_id: target.folderId,
    p_file_name: file.name, p_file_type: file.type, p_drive_file_id: file.driveId, p_drive_url: file.url,
  })
  if (error || !data || typeof data !== "object" || !("id" in data) || !("drive_file_id" in data) || data.drive_file_id !== file.driveId) {
    throw new Error("The file reached Google Drive, but its CCINFO folder could not be saved. Reopen the entry before retrying; the uploaded Drive file has been preserved.")
  }
  return data as { id: string; folder_path: string; file_name: string; file_type: string; drive_file_id: string; drive_url: string; source: "entry" }
}

export function cleanDriveSegment(value: string | null | undefined, fallback = "Untitled") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\\/]+/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || fallback
}

export function splitCcinfoFolderPath(folderPath: string | null | undefined) {
  return String(folderPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => cleanDriveSegment(segment, ""))
    .filter(Boolean)
}

export function buildCcinfoLogicalOriginalPath(
  entryKind: string,
  entryName: string,
  folderPath: string | null | undefined,
  fileName: string,
) {
  const safeKind = cleanDriveSegment(entryKind || "entry").toLowerCase()
  const safeEntryName = cleanDriveSegment(entryName)
  const folderSegments = splitCcinfoFolderPath(folderPath)
  return [safeKind, safeEntryName, ...folderSegments, fileName].filter(Boolean).join("/")
}

export function buildCcinfoDriveFolderSegments(context: CcinfoDriveContext) {
  const entryKind = String(context.entryKind || "").trim().toLowerCase()
  const entryName = cleanDriveSegment(context.entryName)
  const countryName = context.countryName?.trim()
  const companyName = context.companyName?.trim()
  const portName = context.portName?.trim()

  let baseSegments: string[]
  if (entryKind === "country") {
    baseSegments = ["Countries", cleanDriveSegment(countryName || entryName)]
  } else if (entryKind === "company") {
    baseSegments = ["Companies", cleanDriveSegment(companyName || entryName)]
  } else if (entryKind === "port") {
    if (countryName) {
      baseSegments = ["Countries", cleanDriveSegment(countryName), "Ports", cleanDriveSegment(portName || entryName)]
    } else {
      baseSegments = ["Ports", cleanDriveSegment(portName || entryName)]
    }
  } else {
    baseSegments = ["Other Entries", cleanDriveSegment(entryKind || "entry"), entryName]
  }

  return [...baseSegments, ...splitCcinfoFolderPath(context.folderPath)]
}

export async function loadCcinfoDriveContext(
  supabase: SupabaseLike,
  entryKind: string,
  entryId: string,
  fallbackEntryName: string,
  folderPath?: string | null,
): Promise<CcinfoDriveContext> {
  const kind = String(entryKind || "").trim().toLowerCase()
  const fallbackName = cleanDriveSegment(fallbackEntryName)

  if (kind === "country") {
    const { data, error } = await supabase
      .from("cc_countries")
      .select("name")
      .eq("id", entryId)
      .maybeSingle()
    if (error) throw error
    const name = cleanDriveSegment(data?.name || fallbackName)
    return { entryKind: kind, entryName: name, countryName: name, folderPath }
  }

  if (kind === "company") {
    const { data, error } = await supabase
      .from("cc_companies")
      .select("name,country")
      .eq("id", entryId)
      .maybeSingle()
    if (error) throw error
    const name = cleanDriveSegment(data?.name || fallbackName)
    return {
      entryKind: kind,
      entryName: name,
      companyName: name,
      countryName: data?.country || null,
      folderPath,
    }
  }

  if (kind === "port") {
    const { data, error } = await supabase
      .from("cc_ports")
      .select("name,country_name,country_id")
      .eq("id", entryId)
      .maybeSingle()
    if (error) throw error

    let countryName = data?.country_name || null
    if (!countryName && data?.country_id) {
      const country = await supabase
        .from("cc_countries")
        .select("name")
        .eq("id", data.country_id)
        .maybeSingle()
      if (country.error) throw country.error
      countryName = country.data?.name || null
    }

    const name = cleanDriveSegment(data?.name || fallbackName)
    return { entryKind: kind, entryName: name, portName: name, countryName, folderPath }
  }

  return { entryKind: kind || entryKind, entryName: fallbackName, folderPath }
}

export async function ensureCcinfoDriveFolderPath(
  drive: any,
  rootFolderId: string,
  context: CcinfoDriveContext,
  ensureFolder: (drive: any, parentId: string, name: string) => Promise<string>,
) {
  let targetFolderId = rootFolderId
  for (const segment of buildCcinfoDriveFolderSegments(context)) {
    targetFolderId = await ensureFolder(drive, targetFolderId, segment)
  }
  return targetFolderId
}
