import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"


function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export async function GET() {
  try {
    await requireAdminPagePermission("ccinfo", "view")

    const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))

    const [companies, countries, ports, companyFiles, entryFiles, entryFolders] = await Promise.all([
      supabase.from("cc_companies").select("*").order("name", { ascending: true }),
      supabase.from("cc_countries").select("*").order("name", { ascending: true }),
      supabase.from("cc_ports").select("*").order("name", { ascending: true }),
      supabase.from("cc_company_files").select("*").order("file_name", { ascending: true }),
      supabase.from("cc_entry_files").select("*").order("entry_kind", { ascending: true }).order("file_name", { ascending: true }),
      supabase.from("cc_entry_folders").select("*").order("entry_kind", { ascending: true }).order("folder_path", { ascending: true }).order("name", { ascending: true }),
    ])

    const errors = [companies, countries, ports, companyFiles, entryFiles, entryFolders]
      .map((result) => result.error)
      .filter(Boolean)

    if (errors.length > 0) {
      throw errors[0]
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      counts: {
        companies: companies.data?.length || 0,
        countries: countries.data?.length || 0,
        ports: ports.data?.length || 0,
        companyFiles: companyFiles.data?.length || 0,
        entryFiles: entryFiles.data?.length || 0,
        entryFolders: entryFolders.data?.length || 0,
      },
      companies: companies.data || [],
      countries: countries.data || [],
      ports: ports.data || [],
      companyFiles: companyFiles.data || [],
      entryFiles: entryFiles.data || [],
      entryFolders: entryFolders.data || [],
    }

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ccinfo-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message || "Backup failed.")
          : "Backup failed."
    return NextResponse.json({ message }, { status: 500 })
  }
}
