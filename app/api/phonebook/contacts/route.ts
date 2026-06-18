import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const SEARCH_LIMIT = 400

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() || ""
}

function buildSearchTokens(value: string) {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

type ContactRow = {
  id: string
  full_name: string
  company: string | null
  company_source_id: string | null
  title: string | null
  name_remark: string | null
  position: string | null
  department: string | null
  tel_ext: string | null
  direct_line: string | null
  mobile_area: string | null
  mobile_1: string | null
  mobile_2: string | null
  personal_email: string | null
  general_email: string | null
  private_email: string | null
  instant_messaging: string | null
  others: string | null
  area_of_responsibility: string | null
  mobile_phone: string | null
  pager: string | null
  business_phone: string | null
  business_phone_2: string | null
  other_phone: string | null
  email_1: string | null
  email_2: string | null
  notes: string | null
  favorite: boolean
  search_text: string | null
}

async function fetchAllContacts(supabase: any, company?: string) {
  const allContacts: ContactRow[] = []
  const pageSize = 1000
  let from = 0

  while (true) {
    let query = supabase
      .from("phonebook_contacts")
      .select("*")
      .order("favorite", { ascending: false })
      .order("full_name", { ascending: true })
      .range(from, from + pageSize - 1)

    if (company) query = query.eq("company", company)

    const { data, error } = await query
    if (error) throw error

    const batch = (data || []) as ContactRow[]
    allContacts.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  return allContacts
}

async function fetchContactsBySearch(supabase: any, query: string) {
  const tokens = buildSearchTokens(query).slice(0, 6)
  if (tokens.length === 0) return [] as ContactRow[]

  let contactQuery = supabase
    .from("phonebook_contacts")
    .select("*")
    .order("favorite", { ascending: false })
    .order("full_name", { ascending: true })
    .limit(SEARCH_LIMIT)

  for (const token of tokens) {
    contactQuery = contactQuery.ilike("search_text", `%${token}%`)
  }

  const companyTokenFilters = tokens.flatMap((token) => [`name.ilike.%${token}%`, `other_name.ilike.%${token}%`])
  const directMatchesPromise = contactQuery
  const matchingCompaniesPromise = supabase
    .from("phonebook_companies")
    .select("name")
    .or(companyTokenFilters.join(","))
    .limit(120)

  const [
    { data: directMatches, error: directError },
    { data: matchingCompanies, error: companyError },
  ] = await Promise.all([directMatchesPromise, matchingCompaniesPromise])

  if (directError) throw directError
  if (companyError) throw companyError

  const direct = ((directMatches || []) as ContactRow[]).map((contact) => [contact.id, contact] as const)
  const results = new Map<string, ContactRow>(direct)

  const companyNames = Array.from(
    new Set(
      ((matchingCompanies || []) as Array<{ name: string | null }>)
        .map((company) => normalizeText(company.name))
        .filter(Boolean),
    ),
  )

  for (let index = 0; index < companyNames.length; index += 20) {
    const chunk = companyNames.slice(index, index + 20)
    const { data: companyContacts, error: chunkError } = await supabase
      .from("phonebook_contacts")
      .select("*")
      .in("company", chunk)
      .order("favorite", { ascending: false })
      .order("full_name", { ascending: true })
      .limit(SEARCH_LIMIT)

    if (chunkError) throw chunkError

    for (const contact of (companyContacts || []) as ContactRow[]) {
      results.set(contact.id, contact)
      if (results.size >= SEARCH_LIMIT) break
    }

    if (results.size >= SEARCH_LIMIT) break
  }

  return Array.from(results.values()).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""))
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("phonebook", "view")

    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    )

    const { searchParams } = new URL(request.url)
    const company = normalizeText(searchParams.get("company"))
    const query = normalizeText(searchParams.get("query"))
    const all = searchParams.get("all") === "1"

    if (company) {
      const contacts = await fetchAllContacts(supabase, company)
      return NextResponse.json({ contacts })
    }

    if (all) {
      const contacts = await fetchAllContacts(supabase)
      return NextResponse.json({ contacts })
    }

    if (query) {
      const contacts = await fetchContactsBySearch(supabase, query)
      return NextResponse.json({ contacts, limited: contacts.length >= SEARCH_LIMIT })
    }

    return NextResponse.json({ contacts: [] })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Unable to load phonebook contacts." },
      { status: 500 },
    )
  }
}
