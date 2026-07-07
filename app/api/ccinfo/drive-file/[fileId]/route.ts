import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { google } from "googleapis"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TOKEN_PATH = path.join(process.cwd(), ".google-drive-oauth-token.json")

type CcinfoFileRow = {
  file_name: string | null
}

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
  return google.drive({ version: "v3", auth })
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
      return "text/plain; charset=utf-8"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    default:
      return "application/octet-stream"
  }
}

function getGoogleExport(mimeType: string | null | undefined) {
  if (!mimeType?.startsWith("application/vnd.google-apps.")) return null
  return {
    mimeType: "application/pdf",
    extension: ".pdf",
  }
}

function withExtension(fileName: string, extension: string) {
  return path.extname(fileName) ? fileName : `${fileName}${extension}`
}

function contentDisposition(disposition: string, fileName: string) {
  const safeName = fileName.replace(/["\\\r\n]/g, "_")
  return `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function parseByteRange(rangeHeader: string | null, totalSize: number | null) {
  if (!rangeHeader || !totalSize || totalSize < 1) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null

  const [, startText, endText] = match
  if (!startText && !endText) return null

  let start: number
  let end: number

  if (!startText) {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(totalSize - suffixLength, 0)
    end = totalSize - 1
  } else {
    start = Number(startText)
    end = endText ? Number(endText) : totalSize - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (start < 0 || end < start || start >= totalSize) return null
    end = Math.min(end, totalSize - 1)
  }

  return { start, end }
}

async function findCcinfoFile(supabase: ReturnType<typeof createAdminAuditedSupabaseClient>, fileId: string) {
  const entryResult = await supabase
    .from("cc_entry_files")
    .select("file_name")
    .eq("drive_file_id", fileId)
    .is("deleted_at", null)
    .limit(1)

  if (entryResult.error) throw entryResult.error
  const entryFile = (entryResult.data?.[0] || null) as CcinfoFileRow | null
  if (entryFile) return entryFile

  const companyResult = await supabase
    .from("cc_company_files")
    .select("file_name")
    .eq("drive_file_id", fileId)
    .is("deleted_at", null)
    .limit(1)

  if (companyResult.error) throw companyResult.error
  return (companyResult.data?.[0] || null) as CcinfoFileRow | null
}

export async function GET(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const { fileId } = await context.params
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
      return Response.json({ message: "Invalid file id." }, { status: 400 })
    }

    const session = await requireAdminPagePermission("ccinfo", "view")
    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "ccinfo"),
      { useServiceRole: true },
    )
    const fileRow = await findCcinfoFile(supabase, fileId)
    if (!fileRow) {
      return Response.json({ message: "File not found." }, { status: 404 })
    }

    const drive = await getDriveClient()
    const metadata = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size",
      supportsAllDrives: true,
    })
    const exportInfo = getGoogleExport(metadata.data.mimeType)
    const baseName = fileRow.file_name || metadata.data.name || "ccinfo-file"
    const fileName = exportInfo ? withExtension(baseName, exportInfo.extension) : baseName
    const dispositionParam = new URL(request.url).searchParams.get("disposition")
    const disposition = dispositionParam === "attachment" ? "attachment" : "inline"
    const metadataSize = Number(metadata.data.size)
    const totalSize = Number.isSafeInteger(metadataSize) ? metadataSize : null
    const byteRange = exportInfo ? null : parseByteRange(request.headers.get("range"), totalSize)

    const media = exportInfo
      ? await drive.files.export(
          { fileId, mimeType: exportInfo.mimeType },
          { responseType: "stream" },
        )
      : await drive.files.get(
          { fileId, alt: "media", supportsAllDrives: true },
          {
            responseType: "stream",
            headers: byteRange ? { Range: `bytes=${byteRange.start}-${byteRange.end}` } : undefined,
          },
        )
    const byteRangeApplied = Boolean(byteRange && media.status === 206)

    const headers = new Headers()
    headers.set("Content-Type", exportInfo?.mimeType || String(media.headers["content-type"] || metadata.data.mimeType || getMimeType(fileName)))
    headers.set("Content-Disposition", contentDisposition(disposition, fileName))
    headers.set("Cache-Control", "private, max-age=3600")
    headers.set("X-Content-Type-Options", "nosniff")
    if (!exportInfo && totalSize) headers.set("Accept-Ranges", "bytes")
    if (byteRangeApplied && byteRange) {
      headers.set("Content-Range", `bytes ${byteRange.start}-${byteRange.end}/${totalSize}`)
      headers.set("Content-Length", String(byteRange.end - byteRange.start + 1))
    }
    if (!byteRangeApplied) {
      const contentLength = media.headers["content-length"] || metadata.data.size
      if (contentLength) headers.set("Content-Length", String(contentLength))
    }

    return new Response(Readable.toWeb(media.data as Readable) as BodyInit, {
      status: byteRangeApplied ? 206 : 200,
      headers,
    })
  } catch (error) {
    console.error("ccinfo drive file proxy failed", error)
    return Response.json({ message: messageFromError(error) }, { status: 500 })
  }
}
