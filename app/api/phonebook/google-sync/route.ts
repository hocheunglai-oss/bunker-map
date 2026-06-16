import fs from "node:fs/promises"
import path from "node:path"
import { google, people_v1 } from "googleapis"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const TOKEN_PATH = path.join(process.cwd(), ".google-people-oauth-token.json")
const SYNC_MARKER_KEY = "BUNKER_MAP_SYNC"
const CONTACT_ID_KEY = "BUNKER_MAP_CONTACT_ID"

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
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

function redactTail(value: string | undefined, keep = 6) {
  if (!value) return "missing"
  if (value.length <= keep) return value
  return `***${value.slice(-keep)}`
}

function isInvalidGrantError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  const lower = message.toLowerCase()
  if (lower.includes("invalid_grant")) return true
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause
    const causeMessage =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message?: unknown }).message || "").toLowerCase()
        : ""
    if (causeMessage.includes("invalid_grant")) return true
  }
  return false
}

async function getPeopleClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1",
  )
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else {
    const tokenRaw = await fs.readFile(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(tokenRaw))
  }
  return google.people({ version: "v1", auth })
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() || ""
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status || 0)
    : 0
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

function buildGoogleContact(contact: PhonebookContact): people_v1.Schema$Person {
  const displayName = buildDisplayName(contact)
  const emailAddresses: people_v1.Schema$EmailAddress[] = []
  if (contact.personal_email) emailAddresses.push({ value: contact.personal_email, type: "work" })
  if (contact.general_email) emailAddresses.push({ value: contact.general_email, type: "other" })
  if (contact.private_email) emailAddresses.push({ value: contact.private_email, type: "home" })

  const phoneNumbers: people_v1.Schema$PhoneNumber[] = []
  if (contact.company_phone) phoneNumbers.push({ value: normalizeDialablePhone(contact.company_phone), type: "work" })
  if (contact.mobile_1) phoneNumbers.push({ value: normalizeDialablePhone(contact.mobile_1), type: "mobile" })
  if (contact.mobile_2) phoneNumbers.push({ value: normalizeDialablePhone(contact.mobile_2), type: "mobile" })

  const userDefined: people_v1.Schema$UserDefined[] = [
    { key: SYNC_MARKER_KEY, value: "1" },
    { key: CONTACT_ID_KEY, value: contact.id },
  ]

  const biographies = [
    contact.company_other_name ? `OTHER NAME: ${contact.company_other_name}` : "",
    contact.notes || "",
  ]
    .filter(Boolean)
    .join("\n")

  return {
    names: [
      {
        unstructuredName: displayName,
        givenName: displayName,
      },
    ],
    organizations: contact.company
      ? [
          {
            name: contact.company,
            title: contact.position || undefined,
            department: contact.department || undefined,
          },
        ]
      : undefined,
    emailAddresses: emailAddresses.length > 0 ? emailAddresses : undefined,
    phoneNumbers: phoneNumbers.length > 0 ? phoneNumbers : undefined,
    biographies: biographies
      ? [
          {
            value: biographies,
          },
        ]
      : undefined,
    userDefined,
  }
}

function normalizeCompanyKey(value: string | null | undefined) {
  return normalizeText(value).toUpperCase()
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

    if (company) {
      query = query.eq("company", company)
    }

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

async function listManagedGoogleContacts(people: ReturnType<typeof google.people>) {
  const managed: string[] = []
  const byContactId = new Map<string, string[]>()
  let pageToken: string | undefined

  do {
    const response = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: 1000,
      pageToken,
      personFields: "userDefined",
      sortOrder: "FIRST_NAME_ASCENDING",
    })

    const connections = response.data.connections || []
    for (const person of connections) {
      const entries = person.userDefined || []
      const isManaged = entries.some((entry) => entry.key === SYNC_MARKER_KEY && entry.value === "1")
      if (isManaged && person.resourceName) {
        managed.push(person.resourceName)
        const contactId = entries.find((entry) => entry.key === CONTACT_ID_KEY)?.value
        if (contactId) {
          const current = byContactId.get(contactId) || []
          current.push(person.resourceName)
          byContactId.set(contactId, current)
        }
      }
    }

    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)

  return { managed, byContactId }
}

async function deleteManagedContacts(people: ReturnType<typeof google.people>, resourceNames: string[]) {
  for (let index = 0; index < resourceNames.length; index += 1) {
    const resourceName = resourceNames[index]

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await people.people.deleteContact({ resourceName })
        break
      } catch (error) {
        const status = getErrorStatus(error)

        if (status === 429 && attempt < 5) {
          console.warn(`Google delete quota hit at ${index + 1}/${resourceNames.length}; waiting before retrying...`)
          await sleep(65000)
          continue
        }

        if ((status === 500 || status === 502 || status === 503 || status === 504) && attempt < 5) {
          await sleep(3000 * attempt)
          continue
        }

        throw error
      }
    }

    if ((index + 1) % 50 === 0 || index + 1 === resourceNames.length) {
      console.log(`Deleted Google contacts ${index + 1}/${resourceNames.length}`)
    }

    await sleep(120)
  }
}

async function createContacts(people: ReturnType<typeof google.people>, contacts: PhonebookContact[]) {
  let synced = 0
  const failed: Array<{ id: string; label: string }> = []

  for (let i = 0; i < contacts.length; i += 1) {
    const contact = contacts[i]
    let success = false

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await people.people.createContact({
          requestBody: buildGoogleContact(contact),
        })
        success = true
        synced += 1
        break
      } catch (error) {
        const status = getErrorStatus(error)

        if ((status === 500 || status === 502 || status === 503 || status === 504) && attempt < 3) {
          await sleep(1500 * attempt)
          continue
        }

        console.error("Failed Google contact", {
          full_name: contact.full_name,
          company: contact.company,
          status,
        })
        failed.push({
          id: contact.id,
          label: `${contact.full_name || "UNKNOWN"} @ ${contact.company || "NO COMPANY"}`,
        })
        break
      }
    }

    if ((i + 1) % 100 === 0 || i + 1 === contacts.length) {
      console.log(`Synced Google contacts ${i + 1}/${contacts.length} (ok: ${synced}, failed: ${failed.length})`)
    }
  }

  return { synced, failed }
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
      retryMissing?: boolean
    }
    const { deleteContactIds: rawDeleteContactIds } = body
    const selectedCompanyValue = body.selectedCompany
    const fullRebuildValue = body.fullRebuild
    const contactIdsValue = body.contactIds
    const retryMissing = Boolean(body.retryMissing)
    const company = normalizeText(selectedCompanyValue) || null
    let contacts = await fetchContacts(supabase, company)

    if (Array.isArray(contactIdsValue) && contactIdsValue.length > 0) {
      const wanted = new Set(contactIdsValue)
      contacts = contacts.filter((contact) => wanted.has(contact.id))
    }

    let people: ReturnType<typeof google.people>
    try {
      people = await getPeopleClient()
    } catch {
      return NextResponse.json(
        { message: "Google Contacts is not authorized yet. Please run: npm run auth:google-contacts" },
        { status: 400 },
      )
    }

    const managedInfo = await listManagedGoogleContacts(people)
    const deleteIds = Array.isArray(rawDeleteContactIds) ? rawDeleteContactIds.filter(Boolean) : []
    if (deleteIds.length > 0) {
      const toDelete = deleteIds.flatMap((contactId) => managedInfo.byContactId.get(contactId) || [])
      if (toDelete.length > 0) {
        await deleteManagedContacts(people, Array.from(new Set(toDelete)))
      }

      return NextResponse.json({
        message: toDelete.length > 0 ? `Deleted ${toDelete.length} Google contact entries.` : "No matching Google contacts to delete.",
        failed: [],
      })
    }

    if (retryMissing) {
      contacts = contacts.filter((contact) => !(managedInfo.byContactId.get(contact.id)?.length))
    }

    if (contacts.length === 0) {
      return NextResponse.json(
        {
          message: retryMissing ? "No missing Google contacts to retry." : "No contacts to sync.",
          failed: [],
        },
        { status: 400 },
      )
    }

    if (fullRebuildValue) {
      await deleteManagedContacts(people, managedInfo.managed)
    } else {
      const toDelete = contacts.flatMap((contact) => managedInfo.byContactId.get(contact.id) || [])
      if (toDelete.length > 0) {
        await deleteManagedContacts(people, Array.from(new Set(toDelete)))
      }
    }
    const result = await createContacts(people, contacts)

    return NextResponse.json({
      message:
        result.failed.length > 0
          ? `Synced ${result.synced} contacts to Google Contacts. Skipped ${result.failed.length} problematic contacts.`
          : `Synced ${result.synced} contacts to Google Contacts.`,
      failed: result.failed.slice(0, 20),
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    const message = error instanceof Error ? error.message : "Google Contacts sync failed."
    console.error("phonebook google sync failed", error)
    if (isInvalidGrantError(error)) {
      const runtime = process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown"
      const tokenTail = redactTail(process.env.GOOGLE_OAUTH_REFRESH_TOKEN)
      const clientTail = redactTail(process.env.GOOGLE_OAUTH_CLIENT_ID)
      return NextResponse.json(
        {
          message: `Google auth invalid_grant on ${runtime}. Check Vercel GOOGLE_OAUTH_REFRESH_TOKEN and OAuth client values. token=${tokenTail}, client=${clientTail}`,
        },
        { status: 500 },
      )
    }
    return NextResponse.json({ message }, { status: 500 })
  }
}
