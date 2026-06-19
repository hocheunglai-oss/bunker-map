import "server-only"

import { createClient } from "@supabase/supabase-js"

const PAGE_SIZE = 1000
const PARALLEL_PAGES = 4

export type SharedAddressBookContact = {
  id: string
  source_book: string
  source_card: string | null
  display_name: string
  primary_email: string
  nickname: string | null
  first_name: string | null
  last_name: string | null
  vcard: string | null
  properties: Record<string, unknown> | null
}

export type SharedAddressBookGroup = {
  id: string
  source_book: string
  source_uid: string | null
  name: string
  nickname: string | null
  description: string | null
  member_count: number
}

export type SharedAddressBookGroupMember = {
  group_id: string
  contact_id: string
  source_book: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function getServiceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  )
}

async function loadPagedTable<T>(
  table: string,
  columns: string,
  orders: string[],
) {
  const supabase = getServiceClient()
  const rows: T[] = []
  let nextFrom = 0

  while (true) {
    const starts = Array.from(
      { length: PARALLEL_PAGES },
      (_, index) => nextFrom + index * PAGE_SIZE,
    )
    const pages = await Promise.all(
      starts.map((from) =>
        orders
          .reduce(
            (query, order) => query.order(order, { ascending: true }),
            supabase.from(table).select(columns),
          )
          .range(from, from + PAGE_SIZE - 1),
      ),
    )
    const batches = pages.map((page) => {
      if (page.error) throw page.error
      return (page.data || []) as T[]
    })

    batches.forEach((batch) => rows.push(...batch))
    if (batches.some((batch) => batch.length < PAGE_SIZE)) break
    nextFrom += PAGE_SIZE * PARALLEL_PAGES
  }

  return rows
}

export async function loadSharedAddressBook() {
  const [contacts, groups, members] = await Promise.all([
    loadPagedTable<SharedAddressBookContact>(
      "shared_addressbook_contacts",
      "id,source_book,source_card,display_name,primary_email,nickname,first_name,last_name,vcard,properties",
      ["display_name", "id"],
    ),
    loadPagedTable<SharedAddressBookGroup>(
      "shared_addressbook_groups",
      "id,source_book,source_uid,name,nickname,description,member_count",
      ["name", "id"],
    ),
    loadPagedTable<SharedAddressBookGroupMember>(
      "shared_addressbook_group_members",
      "group_id,contact_id,source_book",
      ["source_book", "group_id", "contact_id"],
    ),
  ])

  return { contacts, groups, members }
}

export async function loadSharedAddressBookRecipients() {
  const [contacts, groups] = await Promise.all([
    loadPagedTable<Pick<SharedAddressBookContact, "id" | "display_name" | "primary_email" | "nickname">>(
      "shared_addressbook_contacts",
      "id,display_name,primary_email,nickname",
      ["display_name", "id"],
    ),
    loadPagedTable<Pick<SharedAddressBookGroup, "id" | "name" | "nickname" | "member_count">>(
      "shared_addressbook_groups",
      "id,name,nickname,member_count",
      ["name", "id"],
    ),
  ])

  return { contacts, groups }
}
