import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const MANAGED_PREFIX = "bunker-map-"
const FULL_REBUILD_BATCH_SIZE = 250

export const maxDuration = 300

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
  if (!value) throw new Error(`${name} is not configured.`)
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

  if (/[A-Z0-9]/i.test(stripped)) return stripped

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
  if (line.length <= 73) return line
  const parts: string[] = []
  let current = line
  while (current.length > 73) {
    parts.push(current.slice(0, 73))
    current = ` ${current.slice(73)}`
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

function buildVCard(contact: PhonebookContact) {
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
    `N:${escapeVCard(displayName)};;;;`,
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
    headers: {
      Authorization: `Basic ${auth}`,
      ...(init.headers || {}),
    },
  })
  return response
}

async function loadManagedCardHrefs() {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:getetag /></d:prop>
</d:propfind>`
  const response = await cardDavRequest("", {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body,
  })
  if (!response.ok && response.status !== 207) throw new Error(`CardDAV PROPFIND failed (${response.status}).`)
  const text = await response.text()
  const hrefs = Array.from(text.matchAll(/<[^:>]*:?href>(.*?)<\/[^:>]*:?href>/g)).map((match) =>
    match[1].replace(/&amp;/g, "&"),
  )
  return hrefs.filter((href) => decodeURIComponent(href.split("/").pop() || "").startsWith(MANAGED_PREFIX))
}

async function deleteCard(href: string) {
  const response = await cardDavRequest(href, { method: "DELETE" })
  if (!response.ok && response.status !== 404) throw new Error(`CardDAV delete failed (${response.status}).`)
}

async function putContact(contact: PhonebookContact) {
  const response = await cardDavRequest(cardHref(contact.id), {
    method: "PUT",
    headers: { "Content-Type": "text/vcard; charset=utf-8" },
    body: buildVCard(contact),
  })
  if (!response.ok && response.status !== 201 && response.status !== 204) {
    throw new Error(`CardDAV upload failed (${response.status}) for ${contact.full_name}.`)
  }
}

async function loadCompanyPhoneMap(supabase: any) {
  const rows: PhonebookCompany[] = []
  const pageSize = 1000
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

async function fetchContacts(supabase: any, company: string | null) {
  const rows: PhonebookContact[] = []
  const companyPhoneMap = await loadCompanyPhoneMap(supabase)
  const pageSize = 1000
  let from = 0

  while (true) {
    let query = supabase
      .from("phonebook_contacts")
      .select("id,full_name,company,title,position,department,direct_line,mobile_1,mobile_2,personal_email,general_email,private_email,notes")
      .order("favorite", { ascending: false })
      .order("full_name", { ascending: true })
      .range(from, from + pageSize - 1)

    if (company) query = query.eq("company", company)

    const { data, error } = await query
    if (error) throw error

    const batch = (data || []) as Omit<PhonebookContact, "company_phone" | "company_other_name">[]
    rows.push(
      ...batch.map((contact) => ({
        ...contact,
        company_phone: companyPhoneMap.get(normalizeCompanyKey(contact.company))?.phone || null,
        company_other_name: companyPhoneMap.get(normalizeCompanyKey(contact.company))?.otherName || null,
      })),
    )
    if (batch.length < pageSize) break
    from += pageSize
  }

  return rows
}

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("phonebook", "edit")

    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    )
    const body = (await request.json().catch(() => ({}))) as {
      selectedCompany?: string
      fullRebuild?: boolean
      contactIds?: string[]
      deleteContactIds?: string[]
      cursor?: number
      phase?: "delete" | "upload"
    }

    const deleteIds = Array.isArray(body.deleteContactIds) ? body.deleteContactIds.filter(Boolean) : []
    if (deleteIds.length > 0) {
      for (const contactId of deleteIds) await deleteCard(cardHref(contactId))
      return NextResponse.json({ message: `Deleted ${deleteIds.length} CardDAV contact entries.`, failed: [] })
    }

    const company = normalizeText(body.selectedCompany) || null
    let contacts = await fetchContacts(supabase, company)
    if (Array.isArray(body.contactIds) && body.contactIds.length > 0) {
      const wanted = new Set(body.contactIds)
      contacts = contacts.filter((contact) => wanted.has(contact.id))
    }

    if (contacts.length === 0) {
      return NextResponse.json({ message: "No contacts to sync.", failed: [] }, { status: 400 })
    }

    const total = contacts.length
    const cursor = Number.isFinite(body.cursor) ? Math.max(0, Number(body.cursor)) : 0
    const phase = body.fullRebuild ? (body.phase === "upload" ? "upload" : "delete") : "upload"

    if (body.fullRebuild && phase === "delete") {
      const hrefs = await loadManagedCardHrefs()
      const batch = hrefs.slice(cursor, cursor + FULL_REBUILD_BATCH_SIZE)
      for (const href of batch) await deleteCard(href)

      const deletedCount = Math.min(cursor + batch.length, hrefs.length)
      const deleteDone = deletedCount >= hrefs.length
      return NextResponse.json({
        message: deleteDone
          ? "Deleted existing CardDAV contacts. Starting upload..."
          : `Deleting existing CardDAV contacts ${deletedCount}/${hrefs.length}...`,
        failed: [],
        total: deleteDone ? total : hrefs.length,
        done: false,
        nextCursor: deleteDone ? 0 : deletedCount,
        syncedCount: 0,
        phase: deleteDone ? "upload" : "delete",
      })
    }

    if (body.fullRebuild) {
      contacts = contacts.slice(cursor, cursor + FULL_REBUILD_BATCH_SIZE)
    }

    const failed: Array<{ id: string; label: string }> = []
    let synced = 0
    for (const contact of contacts) {
      try {
        await putContact(contact)
        synced += 1
      } catch {
        failed.push({ id: contact.id, label: `${contact.full_name || "UNKNOWN"} @ ${contact.company || "NO COMPANY"}` })
      }
    }

    return NextResponse.json({
      message: failed.length
        ? `Synced ${synced} contacts to CardDAV. Skipped ${failed.length} problematic contacts.`
        : `Synced ${synced} contacts to CardDAV.`,
      failed: failed.slice(0, 20),
      total,
      done: !body.fullRebuild || cursor + contacts.length >= total,
      nextCursor: body.fullRebuild && cursor + contacts.length < total ? cursor + contacts.length : null,
      syncedCount: synced,
      phase: "upload",
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    console.error("phonebook carddav sync failed", error)
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "CardDAV sync failed." },
      { status: 500 },
    )
  }
}
