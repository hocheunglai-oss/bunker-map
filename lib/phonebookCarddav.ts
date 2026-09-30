import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash, randomUUID } from "node:crypto"

export const MANAGED_PREFIX = "bunker-map-"
export const SYNC_BATCH_SIZE = 2
export const CARDDAV_WRITE_ATTEMPTS = 3
export const CARDDAV_RETRY_BASE_MS = 300
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SyncStage = "input" | "configuration" | "source-read" | "source-check" | "upload" | "delete" | "verification"

export class SyncError extends Error {
  constructor(message: string, readonly stage: SyncStage, readonly status?: number, readonly retryable = false) {
    super(message)
  }
}

export type CardDavWriteLease = { beforeWrite: () => Promise<void>; release: () => Promise<void>; deadline: number }
export type CardDavQueueVersion = { contact_id: string; version: string }

export async function readCardDavQueueVersions(supabase: SupabaseClient, ids: string[]): Promise<CardDavQueueVersion[]> {
  if (!ids.length) return []
  const { data, error } = await supabase.from("phonebook_carddav_queue").select("contact_id,version").in("contact_id", ids)
  if (error || !data) throw new SyncError("Unable to verify queued synchronization.", "source-read")
  return data
}

export async function acknowledgeCardDavQueue(supabase: SupabaseClient, item: CardDavQueueVersion | undefined) {
  if (!item) return
  const { error } = await supabase.from("phonebook_carddav_queue").delete().eq("contact_id", item.contact_id).eq("version", item.version)
  if (error) throw new SyncError("The contact was synchronized but its queued confirmation must be retried.", "verification")
}

export async function acquireCardDavWriteLease(supabase: SupabaseClient, durationMs = 180_000): Promise<CardDavWriteLease> {
  const runId = randomUUID()
  const deadline = Date.now() + Math.min(durationMs, 180_000)
  const claim = async () => {
    if (Date.now() >= deadline) throw new SyncError("Phonebook sync will continue on the next run.", "verification")
    const { data, error } = await supabase.rpc("claim_bunker_map_backup_lock", {
      p_lock_name: "phonebook-carddav-writes", p_run_id: runId, p_lease_seconds: 360,
    })
    if (error || data !== true) throw new SyncError("Phonebook sync is already running. Your saved changes remain queued.", "verification")
    if (Date.now() >= deadline) throw new SyncError("Phonebook sync will continue on the next run.", "verification")
  }
  await claim()
  return {
    deadline,
    beforeWrite: claim,
    release: async () => {
      const { error } = await supabase.rpc("release_bunker_map_backup_lock", {
        p_lock_name: "phonebook-carddav-writes", p_run_id: runId,
      })
      if (error) console.error("phonebook_carddav_lock_release_failed")
    },
  }
}

export function safeSyncError(error: unknown, stage: SyncStage): SyncError {
  if (error instanceof SyncError) return error
  return new SyncError(
    stage === "source-read" || stage === "source-check"
      ? "Unable to read the saved phonebook. Please retry."
      : "The CardDAV connection failed or timed out. Please retry.",
    stage,
    undefined,
    stage !== "source-read" && stage !== "source-check",
  )
}

export function httpSyncError(stage: SyncStage, status: number) {
  const retryable = status === 408 || status === 429 || status >= 500
  return new SyncError(`CardDAV ${stage} failed (HTTP ${status}).`, stage, status, retryable)
}

export function logSyncFailure(id: string | undefined, error: SyncError) {
  // Do not log contact fields, credentials, URLs, or upstream response bodies.
  console.error("phonebook_carddav_sync_failure", {
    ...(id ? { contactId: id } : {}),
    stage: error.stage,
    ...(error.status ? { status: error.status } : {}),
  })
}

export function logVerifiedContacts(ids: string[], explicit: boolean) {
  // Explicit edits are small batches. Record IDs, never contact details, so
  // support can correlate an edit with a successfully verified CardDAV write.
  if (explicit && ids.length > 0) console.info("phonebook_carddav_sync_verified", { contactIds: ids })
}

export type PhonebookContact = {
  id: string
  full_name: string
  company: string | null
  company_phone: string | null
  company_other_name: string | null
  title: string | null
  position: string | null
  department: string | null
  direct_line: string | null
  mobile_1: string | null
  mobile_2: string | null
  personal_email: string | null
  general_email: string | null
  private_email: string | null
  notes: string | null
}

export type PhonebookCompany = {
  name: string
  other_name: string | null
  country: string | null
  tel_country: string | null
  tel_area: string | null
  tel_no_1: string | null
  phone: string | null
}

export function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new SyncError("Phonebook sync is not configured. Please contact an administrator.", "configuration")
  return value
}

export function normalizeText(value: string | null | undefined) {
  return value?.trim() || ""
}

export function normalizeCompanyKey(value: string | null | undefined) {
  return normalizeText(value).toUpperCase()
}

export function normalizeDialablePhone(value: string | null | undefined) {
  const trimmed = normalizeText(value)
  if (!trimmed) return ""
  if (trimmed.startsWith("+")) return trimmed

  const digits = trimmed.replace(/[^\d]/g, "")
  const looksLikeHongKongLocal =
    digits.length === 8 && !trimmed.includes("-") && !trimmed.includes("(") && !trimmed.includes(")")

  if (looksLikeHongKongLocal) return digits
  if (/^\d{1,4}-/.test(trimmed)) return `+${trimmed}`
  return trimmed
}

export function buildDisplayName(contact: PhonebookContact) {
  const raw = normalizeText(contact.full_name)
  const stripped = raw
    .replace(/^[\s([<{/\\-]+/, "")
    .replace(/[\s)\]}>/\\-]+$/, "")
    .replace(/\s+/g, " ")
    .trim()

  if (/[\p{L}\p{N}]/u.test(stripped)) return stripped

  const company = normalizeText(contact.company)
  if (company) return `${company} CONTACT`

  return `CONTACT ${contact.id.slice(0, 8)}`
}

export function escapeVCard(value: string | null | undefined) {
  return normalizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
}

export function foldVCardLine(line: string) {
  const parts: string[] = []
  let current = ""
  let byteLength = 0
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8")
    if (byteLength + size > 75) {
      parts.push(current)
      current = " "
      byteLength = 1
    }
    current += character
    byteLength += size
  }
  parts.push(current)
  return parts.join("\r\n")
}

export function vcardLine(name: string, value: string | null | undefined) {
  const normalized = normalizeText(value)
  if (!normalized) return []
  return [foldVCardLine(`${name}:${escapeVCard(normalized)}`)]
}

export function buildCompanyPhone(company: PhonebookCompany) {
  const countryName = normalizeText(company.country).toUpperCase()
  const country = normalizeText(company.tel_country)
  const area = normalizeText(company.tel_area)
  const tel1 = normalizeText(company.tel_no_1)
  const isHongKong = country === "852" || countryName === "HONG KONG"

  if (!tel1) return ""
  if (isHongKong) return tel1
  if (country && area) return `+${country}-${area}-${tel1}`
  if (country) return `+${country}-${tel1}`
  return ""
}

export function buildContactSyncHash(contact: PhonebookContact) {
  const payload = [
    buildDisplayName(contact),
    normalizeText(contact.company),
    normalizeText(contact.company_phone),
    normalizeText(contact.company_other_name),
    normalizeText(contact.position),
    normalizeDialablePhone(contact.direct_line),
    normalizeDialablePhone(contact.mobile_1),
    normalizeDialablePhone(contact.mobile_2),
    normalizeText(contact.personal_email),
    normalizeText(contact.general_email),
    normalizeText(contact.private_email),
    normalizeText(contact.notes),
  ]

  return createHash("sha256").update(JSON.stringify(payload)).digest("base64url")
}

export function buildVCard(contact: PhonebookContact, syncHash = buildContactSyncHash(contact)) {
  const displayName = buildDisplayName(contact)
  const note = [
    contact.company_other_name ? `OTHER NAME: ${contact.company_other_name}` : "",
    contact.notes || "",
  ].filter(Boolean).join("\n")
  const uid = `${MANAGED_PREFIX}${contact.id}`
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `PRODID:-//Bunker Map//Phonebook CardDAV//EN`,
    `UID:${uid}`,
    ...vcardLine("FN", displayName),
    foldVCardLine(`N:${escapeVCard(displayName)};;;;`),
    ...vcardLine("ORG", contact.company || undefined),
    ...vcardLine("TITLE", contact.position || undefined),
    ...vcardLine("TEL;TYPE=WORK", normalizeDialablePhone(contact.company_phone)),
    ...vcardLine("TEL;TYPE=CELL", normalizeDialablePhone(contact.mobile_1)),
    ...vcardLine("TEL;TYPE=CELL", normalizeDialablePhone(contact.mobile_2)),
    ...vcardLine("TEL;TYPE=WORK", normalizeDialablePhone(contact.direct_line)),
    ...vcardLine("EMAIL;TYPE=WORK", contact.personal_email),
    ...vcardLine("EMAIL;TYPE=OTHER", contact.general_email),
    ...vcardLine("EMAIL;TYPE=HOME", contact.private_email),
    ...vcardLine("NOTE", note),
    "CATEGORIES:BUNKER MAP",
    `X-BUNKER-MAP-CONTACT-ID:${contact.id}`,
    `X-BUNKER-MAP-SYNC-HASH:${syncHash}`,
    `REV:${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
    "END:VCARD",
  ]

  return `${lines.join("\r\n")}\r\n`
}

export function cardHref(contactId: string) {
  return `${MANAGED_PREFIX}${encodeURIComponent(contactId)}.vcf`
}

export function countAddressBookCards(xml: string, addressBookUrl: string) {
  const book = new URL(addressBookUrl)
  const ids = new Set<string>()
  const cards = new Set<string>()
  const otherPaths = new Set<string>()
  for (const response of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const statuses = [...response[1].matchAll(/<(?:[\w-]+:)?status\b[^>]*>HTTP\/[^\s]+\s+(\d{3})\b/gi)].map((match) => Number(match[1]))
    if (statuses.length && !statuses.some((status) => status >= 200 && status < 300)) {
      // A disappeared resource is not a card; permission/upstream errors mean
      // we cannot truthfully claim to have compared the complete address book.
      if (statuses.every((status) => status === 404)) continue
      throw new SyncError("Incomplete CardDAV inventory response.", "verification")
    }
    if (/<(?:[\w-]+:)?collection\b/i.test(response[1])) continue
    const match = /<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/i.exec(response[1])
    if (!match) continue
    try {
      const href = match[1].replace(/&amp;/gi, "&")
      const url = new URL(href, book)
      if (url.origin !== book.origin || !url.pathname.startsWith(book.pathname)) continue
      const filename = decodeURIComponent(url.pathname.slice(book.pathname.length))
      if (!filename || filename.includes("/")) continue
      // CardDAV resource names need not end in .vcf. Include every direct
      // non-collection member, including cards created by phone clients.
      cards.add(url.pathname)
      const id = /^bunker-map-([0-9a-f-]{36})\.vcf$/i.exec(filename)?.[1]
      if (id && UUID_PATTERN.test(id)) ids.add(id.toLowerCase())
      else otherPaths.add(url.pathname)
    } catch {
      // Ignore malformed remote hrefs rather than counting them as contacts.
    }
  }
  return { managedIds: ids, otherPaths: [...otherPaths], managed: ids.size, total: cards.size, other: cards.size - ids.size }
}

export async function inspectOtherCards(paths: string[], saved: Set<string>) {
  const samples: Array<{ name: string; company: string; sourceContactId: string | null; sourceExists: boolean; readable: boolean }> = []
  // Explicit diagnostic only; never download the whole address book or expose
  // URLs/credentials/phone numbers. Paths came from the origin-locked listing.
  for (let offset = 0; offset < Math.min(paths.length, 20); offset += 2) {
    samples.push(...await Promise.all(paths.slice(offset, Math.min(offset + 2, 20)).map(async (path) => {
      try {
        const response = await cardDavRequest(path, { method: "GET", cache: "no-store", redirect: "error" })
        if (!response.ok) throw new Error("Card unavailable")
        const text = await response.text()
        if (text.length > 1_000_000 || !/^BEGIN:VCARD\s*$/m.test(text)) throw new Error("Invalid card")
        const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
        const value = (key: string) => {
          const line = lines.find((line) => line.split(":", 1)[0].split(";", 1)[0].toUpperCase() === key)
          return line ? line.slice(line.indexOf(":") + 1).replace(/\\([nN,;\\])/g, (_, escaped: string) => /n/i.test(escaped) ? " " : escaped).slice(0, 200) : ""
        }
        const uid = value("UID")
        const rawId = value("X-BUNKER-MAP-CONTACT-ID") || (/^bunker-map-/i.test(uid) ? uid.slice(MANAGED_PREFIX.length) : "")
        const sourceContactId = UUID_PATTERN.test(rawId) ? rawId.toLowerCase() : null
        return { name: value("FN"), company: value("ORG"), sourceContactId, sourceExists: sourceContactId ? saved.has(sourceContactId) : false, readable: true }
      } catch {
        return { name: "", company: "", sourceContactId: null, sourceExists: false, readable: false }
      }
    })))
  }
  return samples
}

export async function readSavedContactIds(supabase: SupabaseClient) {
  const ids = new Set<string>()
  const pageSize = 1000
  let expectedCount: number | undefined
  for (let from = 0; ; from += pageSize) {
    const result = await supabase.from("phonebook_contacts")
      .select("id", { count: "exact" }).order("id", { ascending: true }).range(from, from + pageSize - 1)
    if (result.error || result.count == null || !result.data) {
      throw new SyncError("Unable to compare saved contacts.", "source-read")
    }
    if (expectedCount !== undefined && expectedCount !== result.count) {
      throw new SyncError("The phonebook changed during comparison. Please refresh.", "source-read")
    }
    expectedCount = result.count
    for (const row of result.data) ids.add(row.id.toLowerCase())
    if (result.data.length < pageSize) break
  }
  if (ids.size !== expectedCount) throw new SyncError("Incomplete saved contact comparison. Please refresh.", "source-read")
  return ids
}

export function getCardDavConfig() {
  const addressBookUrl = requireEnv("CARDDAV_ADDRESSBOOK_URL").replace(/\/?$/, "/")
  const book = new URL(addressBookUrl)
  if (book.protocol !== "https:" || book.username || book.password || book.search || book.hash) {
    throw new SyncError("Invalid CardDAV address-book configuration.", "configuration")
  }
  const username = requireEnv("CARDDAV_USERNAME")
  const password = requireEnv("CARDDAV_PASSWORD")
  const auth = Buffer.from(`${username}:${password}`).toString("base64")
  return { addressBookUrl, auth }
}

export async function cardDavRequest(pathOrUrl: string, init: RequestInit = {}) {
  const { addressBookUrl, auth } = getCardDavConfig()
  const book = new URL(addressBookUrl)
  const url = new URL(pathOrUrl, book)
  const member = decodeURIComponent(url.pathname.slice(book.pathname.length))
  if (url.origin !== book.origin || !url.pathname.startsWith(book.pathname) || url.search || url.hash || url.username || url.password || member.includes("/") || member.includes("\\") || (!member && init.method !== "PROPFIND")) {
    throw new SyncError("CardDAV request is outside the configured address book.", "configuration")
  }
  const response = await fetch(url.toString(), {
    ...init,
    redirect: "error",
    signal: init.signal || AbortSignal.timeout(15000),
    headers: {
      Authorization: `Basic ${auth}`,
      ...(init.headers || {}),
    },
  })
  return response
}


export async function assertContactAbsent(supabase: SupabaseClient, contactId: string) {
  try {
    const { data, error } = await supabase.from("phonebook_contacts").select("id").eq("id", contactId).maybeSingle()
    if (error) throw safeSyncError(error, "source-check")
    if (data) throw new SyncError("Contact exists in the phonebook. Sync its current details instead of deleting it.", "source-check")
  } catch (error) {
    throw safeSyncError(error, "source-check")
  }
}

export async function deleteCard(supabase: SupabaseClient, contactId: string, lease: CardDavWriteLease) {
  let lastError = new SyncError("CardDAV delete failed.", "delete")
  const href = cardHref(contactId)

  for (let attempt = 1; attempt <= CARDDAV_WRITE_ATTEMPTS; attempt += 1) {
    // A queued deletion may outlive an undo/restore. Never delete a currently
    // authoritative contact. Recheck before each retry, not only the first one.
    await assertContactAbsent(supabase, contactId)
    await lease.beforeWrite()
    let stage: SyncStage = "delete"
    try {
      const response = await cardDavRequest(href, {
        method: "DELETE",
        cache: "no-store",
      })
      if (!response.ok && response.status !== 404) {
        throw httpSyncError("delete", response.status)
      }

      stage = "verification"
      const verification = await cardDavRequest(href, {
        method: "GET",
        headers: { "Cache-Control": "no-cache" },
        cache: "no-store",
      })
      if (verification.status === 404) {
        await assertContactAbsent(supabase, contactId)
        return
      }
      if (!verification.ok) throw httpSyncError("verification", verification.status)
      throw new SyncError("CardDAV deletion has not been verified. Please retry.", "verification", verification.status, true)
    } catch (error) {
      lastError = safeSyncError(error, stage)
      if (!lastError.retryable) throw lastError
      if (attempt < CARDDAV_WRITE_ATTEMPTS) {
        await wait(CARDDAV_RETRY_BASE_MS * 2 ** (attempt - 1))
      }
    }
  }

  throw lastError
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function verifyContact(contact: PhonebookContact, syncHash: string) {
  const response = await cardDavRequest(cardHref(contact.id), {
    method: "GET",
    headers: {
      Accept: "text/vcard, text/x-vcard, */*",
      "Cache-Control": "no-cache",
    },
    cache: "no-store",
  })

  if (!response.ok) {
    // A successful PUT can take a moment to become visible to reads.
    if (response.status === 404) throw new SyncError("CardDAV contact is not yet visible for verification.", "verification", 404, true)
    throw httpSyncError("verification", response.status)
  }

  const lines = (await response.text()).replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
  if (!lines.includes(`X-BUNKER-MAP-CONTACT-ID:${contact.id}`)) {
    throw new SyncError("CardDAV verification returned a different contact.", "verification", undefined, true)
  }
  if (!lines.includes(`X-BUNKER-MAP-SYNC-HASH:${syncHash}`)) {
    throw new SyncError("CardDAV verification found stale data. Please retry.", "verification", undefined, true)
  }
}

export async function putContact(supabase: SupabaseClient, contact: PhonebookContact, lease: CardDavWriteLease) {
  const syncHash = buildContactSyncHash(contact)
  const card = buildVCard(contact, syncHash)
  let lastError = new SyncError("CardDAV upload failed.", "upload")

  for (let attempt = 1; attempt <= CARDDAV_WRITE_ATTEMPTS; attempt += 1) {
    let stage: SyncStage = "upload"
    try {
      const latest = await fetchContacts(supabase, { contactIds: [contact.id] })
      if (latest.contacts.length !== 1 || buildContactSyncHash(latest.contacts[0]) !== syncHash) {
        throw new SyncError("The saved contact changed during sync. Retry to sync its latest details.", "source-check")
      }
      await lease.beforeWrite()
      const response = await cardDavRequest(cardHref(contact.id), {
        method: "PUT",
        headers: {
          "Content-Type": "text/vcard; charset=utf-8",
          "Cache-Control": "no-cache",
        },
        body: card,
        cache: "no-store",
      })
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw httpSyncError("upload", response.status)
      }

      stage = "verification"
      await verifyContact(contact, syncHash)
      const current = await fetchContacts(supabase, { contactIds: [contact.id] })
      if (current.contacts.length !== 1 || buildContactSyncHash(current.contacts[0]) !== syncHash) {
        throw new SyncError("The saved contact changed during sync. Retry to sync its latest details.", "source-check")
      }
      return
    } catch (error) {
      lastError = safeSyncError(error, stage)
      if (!lastError.retryable) throw lastError
      if (attempt < CARDDAV_WRITE_ATTEMPTS) {
        await wait(CARDDAV_RETRY_BASE_MS * 2 ** (attempt - 1))
      }
    }
  }

  throw lastError
}

export async function loadCompanyPhoneMap(supabase: SupabaseClient, companyNames?: string[]) {
  const rows: PhonebookCompany[] = []
  const pageSize = 1000
  const normalizedCompanyNames = Array.from(
    new Set((companyNames || []).map(normalizeText).filter(Boolean)),
  )

  if (normalizedCompanyNames.length === 0) return new Map()

  if (normalizedCompanyNames.length > 0 && normalizedCompanyNames.length <= 200) {
    for (let index = 0; index < normalizedCompanyNames.length; index += 100) {
      const names = normalizedCompanyNames.slice(index, index + 100)
      const { data, error } = await supabase
        .from("phonebook_companies")
        .select("name,other_name,country,tel_country,tel_area,tel_no_1,phone")
        .in("name", names)
      if (error) throw error
      rows.push(...((data || []) as PhonebookCompany[]))
    }
  }
  // The relationship is keyed case-insensitively after trimming. Exact-name
  // queries are the fast path, not proof that an inherited company is absent.
  const loadedKeys = new Set(rows.map((company) => normalizeCompanyKey(company.name)))
  if (normalizedCompanyNames.some((name) => !loadedKeys.has(normalizeCompanyKey(name)))) {
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("phonebook_companies")
        .select("name,other_name,country,tel_country,tel_area,tel_no_1,phone")
        .order("name", { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw error

      const batch = (data || []) as PhonebookCompany[]
      rows.push(...batch)
      if (batch.length < pageSize) break
      from += pageSize
    }
  }

  return new Map(
    rows.map((company) => [
      normalizeCompanyKey(company.name),
      {
        phone: buildCompanyPhone(company),
        otherName: company.other_name || null,
      },
    ]),
  )
}

export async function fetchContacts(
  supabase: SupabaseClient,
  options: {
    company?: string | null
    contactIds?: string[]
    cursor?: number
  } = {},
) {
  const contactIds = Array.from(new Set((options.contactIds || []).filter(Boolean)))
  const cursor = options.cursor || 0
  let query = supabase
    .from("phonebook_contacts")
    .select("id,full_name,company,title,position,department,direct_line,mobile_1,mobile_2,personal_email,general_email,private_email,notes", { count: "exact" })
    .order("id", { ascending: true })
    .range(cursor, cursor + SYNC_BATCH_SIZE - 1)

  if (options.company) query = query.eq("company", options.company)
  if (contactIds.length > 0) query = query.in("id", contactIds)

  const { data, error, count } = await query
  if (error) throw safeSyncError(error, "source-read")
  const rows = (data || []) as Omit<PhonebookContact, "company_phone" | "company_other_name">[]

  const companyNames = Array.from(
    new Set(rows.map((contact) => normalizeText(contact.company)).filter(Boolean)),
  )
  let companyPhoneMap: Awaited<ReturnType<typeof loadCompanyPhoneMap>>
  try {
    companyPhoneMap = await loadCompanyPhoneMap(supabase, companyNames)
  } catch (error) {
    throw safeSyncError(error, "source-read")
  }

  return {
    contacts: rows.map((contact) => ({
      ...contact,
      company_phone: companyPhoneMap.get(normalizeCompanyKey(contact.company))?.phone || null,
      company_other_name: companyPhoneMap.get(normalizeCompanyKey(contact.company))?.otherName || null,
    })),
    total: count ?? rows.length,
  }
}

export function validateSyncRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncError("A phonebook sync scope is required.", "input")
  }
  const body = value as Record<string, unknown>
  for (const key of ["contactIds", "deleteContactIds"]) {
    if (body[key] == null) continue
    const ids = body[key]
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      throw new SyncError("Contact IDs must be valid UUIDs.", "input")
    }
    if (ids.length > SYNC_BATCH_SIZE) throw new SyncError(`Sync at most ${SYNC_BATCH_SIZE} contact IDs per request. Refresh Phonebook and try again.`, "input")
  }
  if (body.selectedCompany != null && typeof body.selectedCompany !== "string") {
    throw new SyncError("The company sync scope must be text.", "input")
  }
  if (body.fullRebuild != null && typeof body.fullRebuild !== "boolean") {
    throw new SyncError("The full sync option must be true or false.", "input")
  }
  if (body.cursor != null && (!Number.isSafeInteger(body.cursor) || Number(body.cursor) < 0)) {
    throw new SyncError("The sync cursor must be a non-negative integer.", "input")
  }
  const contactIds = Array.from(new Set((body.contactIds || []) as string[]))
  const deleteContactIds = Array.from(new Set((body.deleteContactIds || []) as string[]))
  const company = normalizeText(body.selectedCompany as string | undefined)
  const fullRebuild = body.fullRebuild === true
  const scopes = [contactIds.length > 0, deleteContactIds.length > 0, Boolean(company), fullRebuild].filter(Boolean)
  if (scopes.length !== 1) throw new SyncError("Choose one sync scope: contacts, deleted contacts, company, or full resync.", "input")
  const cursor = Number(body.cursor || 0)
  if ((contactIds.length > 0 || deleteContactIds.length > 0) && cursor !== 0) {
    throw new SyncError("Explicit contact batches must start at cursor zero.", "input")
  }
  return { contactIds, deleteContactIds, company, fullRebuild, cursor, explicitCursor: body.cursor != null }
}
