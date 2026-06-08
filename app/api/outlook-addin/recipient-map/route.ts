import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 0

type SharedContact = {
  id: string
  source_book: string | null
  source_card: string | null
  display_name: string | null
  nickname: string | null
  primary_email: string | null
}

type SharedGroup = {
  id: string
  source_book: string | null
  source_uid: string | null
  name: string | null
  nickname: string | null
  member_count: number | null
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

async function loadAll<T>(supabase: any, table: string, orderColumn: string) {
  const rows: T[] = []
  const pageSize = 1000
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) throw error
    rows.push(...((data || []) as T[]))
    if (!data || data.length < pageSize) break
    from += pageSize
  }

  return rows
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function normaliseRecipientKey(value: unknown) {
  return cleanText(value)
    .replace(/^"+|"+$/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function exchangeAlias(value: string, fallback: string) {
  const base = cleanText(value || fallback)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 58)

  return base || fallback
}

function uniqueAlias(baseAlias: string, seenAliases: Set<string>) {
  let alias = baseAlias
  let index = 2
  while (seenAliases.has(alias)) {
    const suffix = `-${index}`
    alias = `${baseAlias.slice(0, 64 - suffix.length)}${suffix}`
    index += 1
  }
  seenAliases.add(alias)
  return alias
}

function addLookup(lookup: Record<string, string>, value: unknown, resolvedRecipient: string) {
  const key = normaliseRecipientKey(value)
  if (!key || !resolvedRecipient) return
  if (!lookup[key]) lookup[key] = resolvedRecipient
}

function addGroupLookups(lookup: Record<string, string>, groups: SharedGroup[]) {
  const seenAliases = new Set<string>()

  groups
    .filter((group) => Number(group.member_count || 0) > 0)
    .forEach((group, index) => {
      const name = cleanText(group.name || group.nickname || group.source_uid)
      if (!name) return
      const aliasSeed = cleanText(group.nickname || name)
      const alias = uniqueAlias(exchangeAlias(aliasSeed, `group-${index + 1}`), seenAliases)
      addLookup(lookup, name, alias)
      addLookup(lookup, group.nickname, alias)
      addLookup(lookup, group.source_uid, alias)
      addLookup(lookup, alias, alias)
    })
}

function addContactLookups(lookup: Record<string, string>, contacts: SharedContact[]) {
  const seenEmails = new Set<string>()

  contacts.forEach((contact) => {
    const email = cleanText(contact.primary_email).toLowerCase()
    if (!email || seenEmails.has(email)) return
    seenEmails.add(email)

    addLookup(lookup, contact.display_name, email)
    addLookup(lookup, contact.nickname, email)
    addLookup(lookup, contact.source_card, email)
    addLookup(lookup, email, email)
  })
}

export async function GET() {
  try {
    const supabase = getSupabaseClient()
    const [contacts, groups] = await Promise.all([
      loadAll<SharedContact>(supabase, "shared_addressbook_contacts", "display_name"),
      loadAll<SharedGroup>(supabase, "shared_addressbook_groups", "name"),
    ])

    const recipientMap: Record<string, string> = {}
    addGroupLookups(recipientMap, groups)
    addContactLookups(recipientMap, contacts)

    return NextResponse.json(
      {
        recipientMap,
        counts: {
          contacts: contacts.length,
          groups: groups.length,
          mappedKeys: Object.keys(recipientMap).length,
        },
      },
      {
        headers: {
          "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load Outlook recipient map." },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  })
}
