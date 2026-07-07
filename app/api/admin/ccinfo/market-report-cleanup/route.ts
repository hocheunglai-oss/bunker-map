import { google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const CONFIRMATION_HEADER = "DELETE_MARKET_REPORT_FOLDERS"
const MARKET_REPORT_FOLDERS = [
  { id: "1wzRycxzPAb42EvfhjPV22mkFwliXZv8d", name: "Platts" },
  { id: "14uXNTTleIO2K78gTEVDEAl8IfJZH4Aj1", name: "European Marketscan" },
  { id: "19ACtDV2U9_JrV_AmRJuHL7A29-Yxini7", name: "Bunkerwire" },
]

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

function hasCleanupAccess(request: Request) {
  const cleanupToken = process.env.CCINFO_CLEANUP_TOKEN
  const authorization = request.headers.get("authorization")
  return Boolean(cleanupToken && authorization === `Bearer ${cleanupToken}`)
}

async function requireCleanupAccess(request: Request) {
  if (hasCleanupAccess(request)) return
  await requireAdminPagePermission("ccinfo", "edit")
}

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  auth.setCredentials({ refresh_token: requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN") })
  return google.drive({ version: "v3", auth })
}

export async function GET(request: Request) {
  try {
    await requireCleanupAccess(request)
    const drive = getDriveClient()
    const folders = []
    for (const folder of MARKET_REPORT_FOLDERS) {
      try {
        const metadata = await drive.files.get({
          fileId: folder.id,
          fields: "id,name,mimeType,trashed",
          supportsAllDrives: true,
        })
        folders.push(metadata.data)
      } catch (error) {
        const status = Number((error as { code?: unknown; response?: { status?: unknown } })?.code || (error as { response?: { status?: unknown } })?.response?.status || 0)
        folders.push({ id: folder.id, name: folder.name, missing: status === 404, error: status === 404 ? null : messageFromError(error) })
      }
    }
    return NextResponse.json({ folders })
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireCleanupAccess(request)
    if (request.headers.get("x-ccinfo-cleanup-confirm") !== CONFIRMATION_HEADER) {
      return NextResponse.json({ message: "Missing cleanup confirmation header." }, { status: 400 })
    }

    const drive = getDriveClient()
    const results: {
      id: string
      name: string
      deleted: boolean
      alreadyMissing: boolean
      message?: string
    }[] = []
    for (const folder of MARKET_REPORT_FOLDERS) {
      try {
        await drive.files.delete({
          fileId: folder.id,
          supportsAllDrives: true,
        })
        results.push({ ...folder, deleted: true, alreadyMissing: false })
      } catch (error) {
        const status = Number((error as { code?: unknown; response?: { status?: unknown } })?.code || (error as { response?: { status?: unknown } })?.response?.status || 0)
        if (status === 404) {
          results.push({ ...folder, deleted: false, alreadyMissing: true })
        } else {
          results.push({ ...folder, deleted: false, alreadyMissing: false, message: messageFromError(error) })
        }
      }
    }
    return NextResponse.json({ results, success: results.every((result) => result.deleted || result.alreadyMissing) })
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}
