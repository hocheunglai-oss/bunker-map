import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { unstable_cache } from "next/cache"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const PAGE_SIZE = 1000
const PARALLEL_PAGES = 4
const COMPANY_COLUMNS = "id,name,source_key,other_name,country,tel_country,tel_area,tel_no_1"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

async function loadCompanies(supabase: any) {
  const companies: unknown[] = []
  let nextFrom = 0

  while (true) {
    const starts = Array.from(
      { length: PARALLEL_PAGES },
      (_, index) => nextFrom + index * PAGE_SIZE,
    )
    const pages = await Promise.all(
      starts.map((from) =>
        supabase
          .from("phonebook_companies")
          .select(COMPANY_COLUMNS)
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1),
      ),
    )

    const batches = pages.map((page) => {
      if (page.error) throw page.error
      return page.data || []
    })
    batches.forEach((batch) => companies.push(...batch))

    if (batches.some((batch) => batch.length < PAGE_SIZE)) break
    nextFrom += PAGE_SIZE * PARALLEL_PAGES
  }

  return companies
}

const loadBootstrapData = unstable_cache(
  async () => {
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    )
    const startedAt = Date.now()
    const [companies, contactCountResult] = await Promise.all([
      loadCompanies(supabase),
      supabase.from("phonebook_contacts").select("id", { count: "exact", head: true }),
    ])

    if (contactCountResult.error) throw contactCountResult.error

    return {
      companies,
      contactCount: contactCountResult.count || 0,
      serverFetchMs: Date.now() - startedAt,
    }
  },
  ["phonebook-bootstrap-v1"],
  { revalidate: 15 },
)

export async function GET() {
  try {
    await requireAdminPagePermission("phonebook", "view")
    const payload = await loadBootstrapData()

    return NextResponse.json(
      payload,
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load phonebook."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
