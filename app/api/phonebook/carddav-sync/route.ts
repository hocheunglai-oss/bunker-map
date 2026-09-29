import { NextResponse } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const MANAGED_PREFIX = "bunker-map-"
const SYNC_BATCH_SIZE = 2
const CARDDAV_WRITE_ATTEMPTS = 3
const CARDDAV_RETRY_BASE_MS = 300
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const maxDuration = 300

type SyncStage = "input" | "configuration" | "source-read" | "source-check" | "upload" | "delete" | "verification"

class SyncError extends Error {
  constructor(message: string, readonly stage: SyncStage, readonly status?: number, readonly retryable = false) {
    super(message)
  }
}

function safeSyncError(error: unknown, stage: SyncStage): SyncError {
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

function httpSyncError(stage: SyncStage, status: number) {
  const retryable = status === 408 || status === 429 || status >= 500
  return new SyncError(`CardDAV ${stage} failed (HTTP ${status}).`, stage, status, retryable)
}

function logSyncFailure(id: string | undefined, error: SyncError) {
  // Do not log contact fields, credentials, URLs, or upstream response bodies.
  console.error("phonebook_carddav_sync_failure", {
    ...(id ? { contactId: id } : {}),
    stage: error.stage,
    ...(error.status ? { status: error.status } : {}),
  })
}

type PhonebookContact = {
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

type PhonebookCompany = {
  name: string
  other_name: string | null
  country: string | null
  tel_country: string | null
  tel_area: string | null
  tel_no_1: string | null
  phone: string | null
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new SyncError("Phonebook sync is not configured. Please contact an administrator.", "configuration")
  return value
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() || ""
}

function normalizeCompanyKey(value: string | null | undefined) {
  return normalizeText(value).toUpperCase()
}

function normalizeDialablePhone(value: string | null | undefined) {
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

function buildDisplayName(contact: PhonebookContact) {
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

function escapeVCard(value: string | null | undefined) {
  return normalizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
}

function foldVCardLine(line: string) {
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

function vcardLine(name: string, value: string | null | undefined) {
  const normalized = normalizeText(value)
  if (!normalized) return []
  return [foldVCardLine(`${name}:${escapeVCard(normalized)}`)]
}

function buildCompanyPhone(company: PhonebookCompany) {
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

function buildContactSyncHash(contact: PhonebookContact) {
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

function buildVCard(contact: PhonebookContact, syncHash = buildContactSyncHash(contact)) {
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

function cardHref(contactId: string) {
  return `${MANAGED_PREFIX}${encodeURIComponent(contactId)}.vcf`
}

function getCardDavConfig() {
  const addressBookUrl = requireEnv("CARDDAV_ADDRESSBOOK_URL").replace(/\/?$/, "/")
  const username = requireEnv("CARDDAV_USERNAME")
  const password = requireEnv("CARDDAV_PASSWORD")
  const auth = Buffer.from(`${username}:${password}`).toString("base64")
  return { addressBookUrl, auth }
}

async function cardDavRequest(pathOrUrl: string, init: RequestInit = {}) {
  const { addressBookUrl, auth } = getCardDavConfig()
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : new URL(pathOrUrl, addressBookUrl).toString()
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(15000),
    headers: {
      Authorization: `Basic ${auth}`,
      ...(init.headers || {}),
    },
  })
  return response
}

async function assertContactAbsent(supabase: SupabaseClient, contactId: string) {
  try {
    const { data, error } = await supabase.from("phonebook_contacts").select("id").eq("id", contactId).maybeSingle()
    if (error) throw safeSyncError(error, "source-check")
    if (data) throw new SyncError("Contact exists in the phonebook. Sync its current details instead of deleting it.", "source-check")
  } catch (error) {
    throw safeSyncError(error, "source-check")
  }
}

async function deleteCard(supabase: SupabaseClient, contactId: string) {
  let lastError = new SyncError("CardDAV delete failed.", "delete")
  const href = cardHref(contactId)

  for (let attempt = 1; attempt <= CARDDAV_WRITE_ATTEMPTS; attempt += 1) {
    // A queued deletion may outlive an undo/restore. Never delete a currently
    // authoritative contact. Recheck before each retry, not only the first one.
    await assertContactAbsent(supabase, contactId)
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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function verifyContact(contact: PhonebookContact, syncHash: string) {
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

async function putContact(supabase: SupabaseClient, contact: PhonebookContact) {
  const syncHash = buildContactSyncHash(contact)
  const card = buildVCard(contact, syncHash)
  let lastError = new SyncError("CardDAV upload failed.", "upload")

  for (let attempt = 1; attempt <= CARDDAV_WRITE_ATTEMPTS; attempt += 1) {
    let stage: SyncStage = "upload"
    try {
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

async function loadCompanyPhoneMap(supabase: SupabaseClient, companyNames?: string[]) {
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
  } else {
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

async function fetchContacts(
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

function validateSyncRequest(value: unknown) {
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

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("phonebook", "edit")
    const body = validateSyncRequest(await request.json().catch(() => null))
    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    )
    getCardDavConfig()
    const failed: Array<{ id: string; label: string; error: string; stage: SyncStage; status?: number }> = []
    const verifiedIds: string[] = []
    const recordFailure = (id: string, error: unknown, stage: SyncStage) => {
      const safeError = safeSyncError(error, stage)
      logSyncFailure(id, safeError)
      failed.push({
        id,
        label: `CONTACT ${id.slice(0, 8)}`,
        error: safeError.message,
        stage: safeError.stage,
        ...(safeError.status ? { status: safeError.status } : {}),
      })
    }
    if (body.deleteContactIds.length > 0) {
      for (const id of body.deleteContactIds) {
        try {
          await deleteCard(supabase, id)
          verifiedIds.push(id)
        } catch (error) {
          recordFailure(id, error, "delete")
        }
      }
      return NextResponse.json({
        message: failed.length ? `Verified ${verifiedIds.length} deletions. ${failed.length} contacts still need attention.` : `Verified ${verifiedIds.length} CardDAV deletions.`,
        failed,
        verifiedIds,
        verifiedCount: verifiedIds.length,
        syncedCount: verifiedIds.length,
        total: body.deleteContactIds.length,
        done: true,
        nextCursor: null,
        phase: "delete",
      }, { status: failed.length ? 207 : 200 })
    }

    const { contacts, total: sourceTotal } = await fetchContacts(supabase, body)
    // Old company-sync clients do not follow cursors. Fail before any write,
    // rather than silently claiming a two-contact partial sync is complete.
    if (body.company && sourceTotal > SYNC_BATCH_SIZE && !body.explicitCursor) {
      throw new SyncError("Refresh Phonebook and try Sync selected company again.", "input")
    }
    const total = body.contactIds.length || sourceTotal
    const foundIds = new Set(contacts.map((contact) => contact.id))
    for (const id of body.contactIds) {
      if (!foundIds.has(id)) recordFailure(id, new SyncError("Contact was not found in the saved phonebook.", "source-read"), "source-read")
    }
    for (const contact of contacts) {
      try {
        await putContact(supabase, contact)
        verifiedIds.push(contact.id)
      } catch (error) {
        recordFailure(contact.id, error, "upload")
      }
    }
    // Legacy fullRebuild/phase:"delete" is intentionally a non-destructive
    // upsert pass. An interrupted resync must never erase the shared book.
    const done = body.contactIds.length > 0 || body.cursor + contacts.length >= total
    return NextResponse.json({
      message: failed.length
        ? `Verified ${verifiedIds.length} CardDAV contacts. ${failed.length} contacts still need retry.`
        : `Verified ${verifiedIds.length} contacts in CardDAV.`,
      failed,
      verifiedIds,
      verifiedCount: verifiedIds.length,
      total,
      done,
      nextCursor: done ? null : body.cursor + contacts.length,
      syncedCount: verifiedIds.length,
      phase: "upload",
    }, { status: failed.length ? 207 : 200 })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    const safeError = safeSyncError(error, "source-read")
    logSyncFailure(undefined, safeError)
    return NextResponse.json(
      { message: safeError.message, stage: safeError.stage },
      { status: safeError.stage === "input" ? 400 : 503 },
    )
  }
}
