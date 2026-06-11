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

type SharedGroupMember = {
  group_id: string | null
  contact_id: string | null
  source_book: string | null
}

type RecipientAddress = {
  displayName: string
  emailAddress: string
}

type RecipientMapEntry = {
  displayName: string
  emailAddress?: string
  members?: RecipientAddress[]
  kind: "contact" | "group"
}

const DEFAULT_GROUP_SMTP_DOMAIN = "cosulich1.onmicrosoft.com"

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

function outlookGroupSmtpDomain() {
  return cleanText(process.env.OUTLOOK_ADDIN_GROUP_DOMAIN || process.env.EXCHANGE_ADDRESSBOOK_DOMAIN || DEFAULT_GROUP_SMTP_DOMAIN)
    .toLowerCase()
}

function groupSmtpAddress(alias: string, domain: string) {
  return `${alias}@${domain}`.toLowerCase()
}

function addLookup(lookup: Record<string, RecipientMapEntry>, value: unknown, resolvedRecipient: RecipientMapEntry) {
  const key = normaliseRecipientKey(value)
  if (!key || (!resolvedRecipient.emailAddress && !resolvedRecipient.members?.length)) return
  if (!lookup[key]) lookup[key] = resolvedRecipient
}

function buildGroupMemberIndex(contacts: SharedContact[], members: SharedGroupMember[]) {
  const contactsById = new Map<string, RecipientAddress>()
  contacts.forEach((contact) => {
    const email = cleanText(contact.primary_email).toLowerCase()
    if (!contact.id || !email) return
    contactsById.set(contact.id, {
      displayName: cleanText(contact.display_name || contact.nickname || email),
      emailAddress: email,
    })
  })

  const membersByGroupId = new Map<string, RecipientAddress[]>()
  const seenByGroupId = new Map<string, Set<string>>()
  members.forEach((member) => {
    const groupId = cleanText(member.group_id)
    const contactId = cleanText(member.contact_id)
    const contact = contactsById.get(contactId)
    if (!groupId || !contact) return
    const emailKey = contact.emailAddress.toLowerCase()
    if (!seenByGroupId.has(groupId)) seenByGroupId.set(groupId, new Set<string>())
    const seen = seenByGroupId.get(groupId)
    if (!seen || seen.has(emailKey)) return
    seen.add(emailKey)
    const groupMembers = membersByGroupId.get(groupId) || []
    groupMembers.push(contact)
    membersByGroupId.set(groupId, groupMembers)
  })

  return membersByGroupId
}

function addGroupLookups(
  lookup: Record<string, RecipientMapEntry>,
  groups: SharedGroup[],
  membersByGroupId: Map<string, RecipientAddress[]>
) {
  const seenAliases = new Set<string>()
  const smtpDomain = outlookGroupSmtpDomain()

  groups
    .filter((group) => Number(group.member_count || 0) > 0)
    .forEach((group, index) => {
      const name = cleanText(group.name || group.nickname || group.source_uid)
      if (!name) return
      const aliasSeed = cleanText(group.nickname || name)
      const alias = uniqueAlias(exchangeAlias(aliasSeed, `group-${index + 1}`), seenAliases)
      const emailAddress = groupSmtpAddress(alias, smtpDomain)
      const groupMembers = membersByGroupId.get(group.id) || []
      const resolvedRecipient = {
        displayName: name,
        emailAddress,
        members: groupMembers,
        kind: "group" as const,
      }
      addLookup(lookup, name, resolvedRecipient)
      addLookup(lookup, group.nickname, resolvedRecipient)
      addLookup(lookup, group.source_uid, resolvedRecipient)
      addLookup(lookup, alias, resolvedRecipient)
      addLookup(lookup, emailAddress, resolvedRecipient)
    })
}

function addContactLookups(lookup: Record<string, RecipientMapEntry>, contacts: SharedContact[]) {
  const seenEmails = new Set<string>()

  contacts.forEach((contact) => {
    const email = cleanText(contact.primary_email).toLowerCase()
    if (!email || seenEmails.has(email)) return
    seenEmails.add(email)
    const resolvedRecipient = {
      displayName: cleanText(contact.display_name || contact.nickname || email),
      emailAddress: email,
      kind: "contact" as const,
    }

    addLookup(lookup, contact.display_name, resolvedRecipient)
    addLookup(lookup, contact.nickname, resolvedRecipient)
    addLookup(lookup, contact.source_card, resolvedRecipient)
    addLookup(lookup, email, resolvedRecipient)
  })
}

export async function GET() {
  try {
    const supabase = getSupabaseClient()
    const [contacts, groups, members] = await Promise.all([
      loadAll<SharedContact>(supabase, "shared_addressbook_contacts", "display_name"),
      loadAll<SharedGroup>(supabase, "shared_addressbook_groups", "name"),
      loadAll<SharedGroupMember>(supabase, "shared_addressbook_group_members", "source_book"),
    ])

    const recipientMap: Record<string, RecipientMapEntry> = {}
    const membersByGroupId = buildGroupMemberIndex(contacts, members)
    addGroupLookups(recipientMap, groups, membersByGroupId)
    addContactLookups(recipientMap, contacts)

    return NextResponse.json(
      {
        recipientMap,
        counts: {
          contacts: contacts.length,
          groups: groups.length,
          groupMembers: members.length,
          expandedGroups: groups.filter((group) => (membersByGroupId.get(group.id) || []).length > 0).length,
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
