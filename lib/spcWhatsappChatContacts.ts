import { createClient } from "@supabase/supabase-js"
import { normalizeWhatsappPhone } from "@/lib/spcEnquiryChatContacts"

const MAX_CHAT_NAMES = 80
const PHONEBOOK_QUERY_CHUNK_SIZE = 30

type RequestedChatName = {
  name: string
  lookupName: string
}

type PhonebookChatContactRow = {
  id: string
  full_name: string
  mobile_area: string | null
  mobile_1: string | null
  mobile_2: string | null
  mobile_phone: string | null
  direct_line: string | null
  business_phone: string | null
  business_phone_2: string | null
  other_phone: string | null
}

export type SpcWhatsappChatContact = {
  name: string
  phone: string
  phonebookContactId: string
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

export function normalizeSpcWhatsappChatName(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 180)
    : ""
}

export function normalizeRequestedSpcWhatsappChatNames(value: unknown) {
  if (!Array.isArray(value)) return []
  const byLookupName = new Map<string, RequestedChatName>()
  for (const candidate of value) {
    if (typeof candidate !== "string") continue
    const name = candidate.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 180)
    const lookupName = normalizeSpcWhatsappChatName(name)
    if (name && lookupName && !byLookupName.has(lookupName)) byLookupName.set(lookupName, { name, lookupName })
    if (byLookupName.size >= MAX_CHAT_NAMES) break
  }
  return Array.from(byLookupName.values())
}

function preferredPhone(contact: PhonebookChatContactRow) {
  const candidates = [
    contact.mobile_1,
    contact.mobile_phone,
    contact.mobile_2,
    contact.direct_line,
    contact.business_phone,
    contact.business_phone_2,
    contact.other_phone,
  ]
  for (const candidate of candidates) {
    const phone = normalizeWhatsappPhone(candidate, "", contact.mobile_area)
    if (phone) return phone
  }
  return ""
}

export function resolveSpcWhatsappChatContacts(
  requestedNames: unknown,
  contacts: PhonebookChatContactRow[],
) {
  const requested = normalizeRequestedSpcWhatsappChatNames(requestedNames)
  const contactsByName = new Map<string, PhonebookChatContactRow[]>()
  for (const contact of contacts) {
    const lookupName = normalizeSpcWhatsappChatName(contact.full_name)
    if (!lookupName) continue
    const matches = contactsByName.get(lookupName) || []
    matches.push(contact)
    contactsByName.set(lookupName, matches)
  }

  return requested.flatMap<SpcWhatsappChatContact>((request) => {
    const matches = contactsByName.get(request.lookupName) || []
    const byPhone = new Map<string, PhonebookChatContactRow>()
    for (const match of matches) {
      const phone = preferredPhone(match)
      if (phone && !byPhone.has(phone)) byPhone.set(phone, match)
    }
    if (byPhone.size !== 1) return []
    const [phone, contact] = Array.from(byPhone.entries())[0]
    return [{ name: request.name, phone, phonebookContactId: contact.id }]
  })
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

export async function listSpcWhatsappChatContacts(requestedNames: unknown) {
  const requested = normalizeRequestedSpcWhatsappChatNames(requestedNames)
  if (requested.length === 0) return []

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const select = [
    "id",
    "full_name",
    "mobile_area",
    "mobile_1",
    "mobile_2",
    "mobile_phone",
    "direct_line",
    "business_phone",
    "business_phone_2",
    "other_phone",
  ].join(",")
  const rows = new Map<string, PhonebookChatContactRow>()
  const queryNames = Array.from(new Set(requested.flatMap(({ name }) => [name, name.toUpperCase()])))

  for (const nameChunk of chunk(queryNames, PHONEBOOK_QUERY_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("phonebook_contacts")
      .select(select)
      .in("full_name", nameChunk)
    if (error) throw error
    for (const contact of (data || []) as unknown as PhonebookChatContactRow[]) rows.set(contact.id, contact)
  }

  return resolveSpcWhatsappChatContacts(requested.map(({ name }) => name), Array.from(rows.values()))
}
