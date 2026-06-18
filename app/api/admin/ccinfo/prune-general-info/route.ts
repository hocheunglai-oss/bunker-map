import { createClient } from "@supabase/supabase-js"
import { google } from "googleapis"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const runtime = "nodejs"
export const maxDuration = 300

const NAME_PATTERN = /general[ _-]*(?:info|information)/i
const BATCH_SIZE = 75

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function hasImportedContent(record: { summary?: string | null; notes?: string | null } | undefined) {
  return [record?.summary, record?.notes].some(
    (value) => typeof value === "string" && value.replace(/\s/g, "").length >= 20
  )
}

export async function POST() {
  try {
    await requireAdminPagePermission("ccinfo", "edit")
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    )
    const [{ data: companyFiles, error: companyFileError }, { data: entryFiles, error: entryFileError }] =
      await Promise.all([
        supabase
          .from("cc_company_files")
          .select("id,company_id,file_name,drive_file_id")
          .is("deleted_at", null)
          .not("drive_file_id", "is", null),
        supabase
          .from("cc_entry_files")
          .select("id,entry_kind,entry_id,file_name,drive_file_id")
          .is("deleted_at", null)
          .not("drive_file_id", "is", null),
      ])
    if (companyFileError) throw companyFileError
    if (entryFileError) throw entryFileError

    const candidateCompanyFiles = (companyFiles || []).filter((file) => NAME_PATTERN.test(file.file_name || ""))
    const candidateEntryFiles = (entryFiles || []).filter((file) => NAME_PATTERN.test(file.file_name || ""))
    const companyIds = Array.from(new Set([
      ...candidateCompanyFiles.map((file) => file.company_id),
      ...candidateEntryFiles.filter((file) => file.entry_kind === "company").map((file) => file.entry_id),
    ]))
    const countryIds = Array.from(new Set(
      candidateEntryFiles.filter((file) => file.entry_kind === "country").map((file) => file.entry_id)
    ))

    const [{ data: companies, error: companyError }, { data: countries, error: countryError }] =
      await Promise.all([
        companyIds.length
          ? supabase.from("cc_companies").select("id,name,summary,notes").in("id", companyIds)
          : Promise.resolve({ data: [], error: null }),
        countryIds.length
          ? supabase.from("cc_countries").select("id,name,summary,notes").in("id", countryIds)
          : Promise.resolve({ data: [], error: null }),
      ])
    if (companyError) throw companyError
    if (countryError) throw countryError

    const companyMap = new Map((companies || []).map((record) => [record.id, record]))
    const countryMap = new Map((countries || []).map((record) => [record.id, record]))
    const verified = [
      ...candidateCompanyFiles
        .filter((file) => hasImportedContent(companyMap.get(file.company_id)))
        .map((file) => ({ ...file, table: "cc_company_files" })),
      ...candidateEntryFiles
        .filter((file) =>
          hasImportedContent(
            file.entry_kind === "country"
              ? countryMap.get(file.entry_id)
              : companyMap.get(file.entry_id)
          )
        )
        .map((file) => ({ ...file, table: "cc_entry_files" })),
    ]
    const batch = verified.slice(0, BATCH_SIZE)

    const auth = new google.auth.OAuth2(
      requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
    )
    auth.setCredentials({ refresh_token: requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN") })
    const drive = google.drive({ version: "v3", auth })
    let deleted = 0
    const failures: string[] = []

    for (const file of batch) {
      try {
        try {
          await drive.files.delete({ fileId: file.drive_file_id!, supportsAllDrives: true })
        } catch (error) {
          const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0
          if (status !== 404) throw error
        }
        const { error } = await supabase
          .from(file.table)
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", file.id)
        if (error) throw error
        deleted += 1
      } catch (error) {
        failures.push(`${file.file_name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return NextResponse.json({
      success: failures.length === 0,
      deleted,
      failures,
      remaining: Math.max(verified.length - deleted, 0),
      preserved: candidateCompanyFiles.length + candidateEntryFiles.length - verified.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed."
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}
