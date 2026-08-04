import { createClient } from "@supabase/supabase-js"

const MAX_USERNAMES = 80
const PHONEBOOK_QUERY_CHUNK_SIZE = 10
const EMAIL_FIELDS = ["personal_email", "general_email", "private_email", "email_1", "email_2"] as const

type SpcUserRow = {
  username: string
  display_name: string | null
  whatsapp_phone: string | null
}

type PhonebookContactRow = {
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
  personal_email: string | null
  general_email: string | null
  private_email: string | null
  email_1: string | null
  email_2: string | null
}

export type SpcEnquiryChatContact = {
  username: string
  displayName: string
  phone: string
  phonebookContactId: string
}

const COUNTRY_CODE_BY_DOMAIN: Record<string, string> = {
  "cosulich.com.hk": "852",
  "cosulich.com.sg": "65",
  "cosulich.gr": "30",
  "cosulich.it": "39",
  "cosulich.mc": "377",
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

export function normalizeSpcChatUsername(value: unknown) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(username)) return ""
  return username.slice(0, 254)
}

export function normalizeRequestedSpcChatUsernames(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map(normalizeSpcChatUsername).filter(Boolean))).slice(0, MAX_USERNAMES)
}

export function normalizeWhatsappPhone(value: string | null | undefined, username: string, mobileArea?: string | null) {
  const raw = String(value || "").trim()
  if (!raw) return ""

  let digits = raw.replace(/\D/g, "")
  if (!digits) return ""
  if (raw.startsWith("00")) digits = digits.slice(2)

  const explicitArea = String(mobileArea || "").replace(/\D/g, "")
  if (!raw.startsWith("+") && !raw.startsWith("00") && explicitArea && !digits.startsWith(explicitArea)) {
    digits = `${explicitArea}${digits.replace(/^0+/, "")}`
  }

  if (!raw.startsWith("+") && !raw.startsWith("00") && !explicitArea && digits.length <= 10) {
    const domain = normalizeSpcChatUsername(username).split("@")[1] || ""
    const countryCode = COUNTRY_CODE_BY_DOMAIN[domain] || ""
    if (countryCode && !digits.startsWith(countryCode)) {
      digits = `${countryCode}${digits.replace(/^0+/, "")}`
    }
  }

  return digits.length >= 8 && digits.length <= 15 ? digits : ""
}

function phonebookEmails(contact: PhonebookContactRow) {
  return EMAIL_FIELDS.map((field) => normalizeSpcChatUsername(contact[field])).filter(Boolean)
}

function preferredPhone(contact: PhonebookContactRow, username: string) {
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
    const phone = normalizeWhatsappPhone(candidate, username, contact.mobile_area)
    if (phone) return phone
  }
  return ""
}

export function resolveSpcEnquiryChatContacts(users: SpcUserRow[], contacts: PhonebookContactRow[]) {
  const contactsByUsername = new Map<string, PhonebookContactRow[]>()
  for (const contact of contacts) {
    for (const username of phonebookEmails(contact)) {
      const matches = contactsByUsername.get(username) || []
      if (!matches.some((match) => match.id === contact.id)) matches.push(contact)
      contactsByUsername.set(username, matches)
    }
  }

  return users.flatMap<SpcEnquiryChatContact>((user) => {
    const username = normalizeSpcChatUsername(user.username)
    const explicitPhone = normalizeWhatsappPhone(user.whatsapp_phone, username)
    if (username && explicitPhone) {
      return [{
        username,
        displayName: user.display_name?.trim() || username,
        phone: explicitPhone,
        phonebookContactId: "",
      }]
    }
    const matches = contactsByUsername.get(username) || []
    if (!username || matches.length !== 1) return []
    const phone = preferredPhone(matches[0], username)
    if (!phone) return []
    return [{
      username,
      displayName: user.display_name?.trim() || matches[0].full_name?.trim() || username,
      phone,
      phonebookContactId: matches[0].id,
    }]
  })
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

export async function listSpcEnquiryChatContacts(requestedUsernames: unknown) {
  const usernames = normalizeRequestedSpcChatUsernames(requestedUsernames)
  if (usernames.length === 0) return []

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: userData, error: userError } = await supabase
    .from("spc_users")
    .select("username,display_name,whatsapp_phone")
    .eq("is_active", true)
    .in("username", usernames)

  if (userError) throw userError
  const users = (userData || []) as SpcUserRow[]
  if (users.length === 0) return []

  const allowedUsernames = users.map((user) => normalizeSpcChatUsername(user.username)).filter(Boolean)
  const contactRows = new Map<string, PhonebookContactRow>()
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
    ...EMAIL_FIELDS,
  ].join(",")

  for (const usernameChunk of chunk(allowedUsernames, PHONEBOOK_QUERY_CHUNK_SIZE)) {
    const filters = usernameChunk.flatMap((username) => EMAIL_FIELDS.map((field) => `${field}.eq.${username}`))
    const { data, error } = await supabase.from("phonebook_contacts").select(select).or(filters.join(","))
    if (error) throw error
    for (const contact of (data || []) as unknown as PhonebookContactRow[]) contactRows.set(contact.id, contact)
  }

  return resolveSpcEnquiryChatContacts(users, Array.from(contactRows.values()))
}
