import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const CONFIRMATION_HEADER = "DELETE_CONFIRMED_JUNK"

type JunkFile = {
  id: string
  table: "cc_company_files" | "cc_entry_files"
  drive_file_id: string | null
  file_name: string | null
  original_path: string | null
  reason: string
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

function hasCronAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`)
}

async function requireCleanupAccess(request: Request) {
  if (hasCronAccess(request)) return
  await requireAdminPagePermission("ccinfo", "edit")
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          "x-bunker-admin-user": "ccinfo-maintenance",
          "x-bunker-admin-display-name": "CCINFO Maintenance",
          "x-bunker-admin-role": "admin",
          "x-bunker-admin-page-id": "ccinfo",
          "x-bunker-admin-page-label": "CCINFO",
          "x-bunker-admin-page-path": "/admin/ccinfo",
        },
      },
    },
  )
}

type CleanupSupabaseClient = ReturnType<typeof getSupabaseClient>

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  auth.setCredentials({ refresh_token: requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN") })
  return google.drive({ version: "v3", auth })
}

function classifyConfirmedJunk(fileName: string | null | undefined) {
  const name = fileName || ""
  if (["Thumbs.db", "desktop.ini", ".DS_Store"].includes(name)) return "system_junk_exact"
  if (name.startsWith("._")) return "mac_resource_fork"
  if (name.startsWith("~$")) return "office_temp"
  if (name.toLowerCase().endsWith(".tmp")) return "tmp_extension"
  return null
}

async function fetchActiveFiles(supabase: CleanupSupabaseClient, table: JunkFile["table"]) {
  const rows: Omit<JunkFile, "table" | "reason">[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select("id,drive_file_id,file_name,original_path")
      .is("deleted_at", null)
      .not("drive_file_id", "is", null)
      .range(offset, offset + 999)
    if (error) throw error
    rows.push(...((data || []) as Omit<JunkFile, "table" | "reason">[]))
    if (!data || data.length < 1000) break
  }
  return rows
}

async function fetchCandidates(supabase: CleanupSupabaseClient) {
  const [companyFiles, entryFiles] = await Promise.all([
    fetchActiveFiles(supabase, "cc_company_files"),
    fetchActiveFiles(supabase, "cc_entry_files"),
  ])

  return [
    ...companyFiles.map((file) => ({ ...file, table: "cc_company_files" as const })),
    ...entryFiles.map((file) => ({ ...file, table: "cc_entry_files" as const })),
  ]
    .map((file) => ({ ...file, reason: classifyConfirmedJunk(file.file_name) }))
    .filter((file): file is JunkFile => Boolean(file.reason))
    .sort((a, b) =>
      `${a.table}:${a.reason}:${a.file_name}:${a.id}`.localeCompare(`${b.table}:${b.reason}:${b.file_name}:${b.id}`),
    )
}

function summarize(candidates: JunkFile[]) {
  return candidates.reduce<Record<string, number>>((counts, candidate) => {
    const key = `${candidate.table}:${candidate.reason}`
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
}

export async function GET(request: Request) {
  try {
    await requireCleanupAccess(request)
    const supabase = getSupabaseClient()
    const candidates = await fetchCandidates(supabase)
    return NextResponse.json({
      candidates: candidates.length,
      counts: summarize(candidates),
      sample: candidates.slice(0, 10).map((candidate) => ({
        table: candidate.table,
        file_name: candidate.file_name,
        reason: candidate.reason,
        original_path: candidate.original_path,
      })),
    })
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

    const supabase = getSupabaseClient()
    const candidates = await fetchCandidates(supabase)
    const drive = getDriveClient()
    const deletedAt = new Date().toISOString()
    let deleted = 0
    let alreadyMissing = 0
    const failures: { id: string; table: string; file_name: string | null; message: string }[] = []

    for (const candidate of candidates) {
      try {
        try {
          await drive.files.delete({
            fileId: candidate.drive_file_id!,
            supportsAllDrives: true,
          })
          deleted += 1
        } catch (error) {
          const status = Number((error as { code?: unknown; response?: { status?: unknown } })?.code || (error as { response?: { status?: unknown } })?.response?.status || 0)
          if (status === 404) {
            alreadyMissing += 1
          } else {
            throw error
          }
        }

        const { error } = await supabase
          .from(candidate.table)
          .update({ deleted_at: deletedAt })
          .eq("id", candidate.id)
          .is("deleted_at", null)
        if (error) throw error
      } catch (error) {
        failures.push({
          id: candidate.id,
          table: candidate.table,
          file_name: candidate.file_name,
          message: messageFromError(error),
        })
      }
    }

    const remaining = await fetchCandidates(supabase)
    return NextResponse.json({
      success: failures.length === 0,
      candidates: candidates.length,
      counts: summarize(candidates),
      deleted,
      alreadyMissing,
      failures,
      remaining: remaining.length,
    })
  } catch (error) {
    const message = messageFromError(error)
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}
