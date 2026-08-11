import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { officeCalendarSeedEvents, type OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  getAdminSession,
  hasAdminPagePermission,
  type AdminSession,
} from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import { mutateEventCalendarStore } from "@/lib/eventCalendarStore"
import { recordOpenAiUsage } from "@/lib/openAiUsage"

export const maxDuration = 60

type EventCategory = "Public Holiday" | "Leave or Travel" | "Meeting Room" | "Unclassified"

type CalendarDraft = {
  title: string
  startDate: string
  endDate: string
  people: string[]
  tags: string[]
  eventType: EventCategory
  confidence: number
  notes: string
}

type PhonebookCompanyDraft = {
  name: string
  otherName: string
  country: string
  phone: string
  address: string
  website: string
  email: string
  notes: string
  confidence: number
}

type PhonebookContactDraft = {
  fullName: string
  company: string
  title: string
  position: string
  department: string
  directLine: string
  mobileArea: string
  mobile1: string
  mobile2: string
  personalEmail: string
  generalEmail: string
  privateEmail: string
  notes: string
  confidence: number
}

type AiDraft = {
  summary: string
  calendarEvents: CalendarDraft[]
  phonebookCompanies: PhonebookCompanyDraft[]
  phonebookContacts: PhonebookContactDraft[]
  warnings: string[]
  provider?: "gemini" | "openai"
  availableTools?: {
    eventCalendar: boolean
    phonebook: boolean
  }
  model?: string
}

const DEFAULT_PEOPLE = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]
const EVENT_TYPES: EventCategory[] = [
  "Public Holiday",
  "Leave or Travel",
  "Meeting Room",
  "Unclassified",
]

const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    calendarEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          people: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
          eventType: { type: "string", enum: EVENT_TYPES },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
        required: [
          "title",
          "startDate",
          "endDate",
          "people",
          "tags",
          "eventType",
          "confidence",
          "notes",
        ],
      },
    },
    phonebookCompanies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          otherName: { type: "string" },
          country: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          website: { type: "string" },
          email: { type: "string" },
          notes: { type: "string" },
          confidence: { type: "number" },
        },
        required: [
          "name",
          "otherName",
          "country",
          "phone",
          "address",
          "website",
          "email",
          "notes",
          "confidence",
        ],
      },
    },
    phonebookContacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fullName: { type: "string" },
          company: { type: "string" },
          title: { type: "string" },
          position: { type: "string" },
          department: { type: "string" },
          directLine: { type: "string" },
          mobileArea: { type: "string" },
          mobile1: { type: "string" },
          mobile2: { type: "string" },
          personalEmail: { type: "string" },
          generalEmail: { type: "string" },
          privateEmail: { type: "string" },
          notes: { type: "string" },
          confidence: { type: "number" },
        },
        required: [
          "fullName",
          "company",
          "title",
          "position",
          "department",
          "directLine",
          "mobileArea",
          "mobile1",
          "mobile2",
          "personalEmail",
          "generalEmail",
          "privateEmail",
          "notes",
          "confidence",
        ],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "calendarEvents",
    "phonebookCompanies",
    "phonebookContacts",
    "warnings",
  ],
} as const

class HttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "AI workbench action failed."
  const status =
    error instanceof HttpError
      ? error.status
      : message === "Unauthorized"
        ? 401
        : message === "Forbidden"
          ? 403
          : 500

  return NextResponse.json({ message }, { status })
}

function getAccess(session: AdminSession) {
  return {
    eventCalendar: hasAdminPagePermission(session, "event-calendar", "edit"),
    phonebook: hasAdminPagePermission(session, "phonebook", "edit"),
  }
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function cleanUpper(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").toUpperCase()
}

function cleanEmail(value: unknown) {
  return cleanText(value).replace(/\s+/g, "")
}

function clampConfidence(value: unknown) {
  const confidence = typeof value === "number" && Number.isFinite(value) ? value : 0.5
  return Math.min(1, Math.max(0, confidence))
}

function normalizePeople(value: unknown) {
  const source = Array.isArray(value) ? value : []
  return Array.from(
    new Set(
      source
        .map((item) => cleanUpper(item))
        .filter(Boolean)
        .filter((item) => item !== "??"),
    ),
  )
}

function isDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normalizeEventType(value: unknown): EventCategory {
  return EVENT_TYPES.includes(value as EventCategory) ? (value as EventCategory) : "Unclassified"
}

function normalizeCalendarDraft(value: unknown): CalendarDraft | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  const title = cleanUpper(source.title)
  const startDate = cleanText(source.startDate)
  const endDate = cleanText(source.endDate) || startDate

  if (!title || !isDateKey(startDate)) return null

  return {
    title,
    startDate,
    endDate: isDateKey(endDate) && endDate >= startDate ? endDate : startDate,
    people: normalizePeople(source.people),
    tags: normalizePeople(source.tags),
    eventType: normalizeEventType(source.eventType),
    confidence: clampConfidence(source.confidence),
    notes: cleanText(source.notes),
  }
}

function normalizePhonebookCompanyDraft(value: unknown): PhonebookCompanyDraft | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  const name = cleanUpper(source.name)
  if (!name) return null

  return {
    name,
    otherName: cleanUpper(source.otherName),
    country: cleanUpper(source.country),
    phone: cleanUpper(source.phone),
    address: cleanUpper(source.address),
    website: cleanText(source.website),
    email: cleanEmail(source.email),
    notes: cleanUpper(source.notes),
    confidence: clampConfidence(source.confidence),
  }
}

function normalizePhonebookContactDraft(value: unknown): PhonebookContactDraft | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  const fullName = cleanUpper(source.fullName)
  const company = cleanUpper(source.company)
  if (!fullName || !company) return null

  return {
    fullName,
    company,
    title: cleanUpper(source.title),
    position: cleanUpper(source.position),
    department: cleanUpper(source.department),
    directLine: cleanUpper(source.directLine),
    mobileArea: cleanUpper(source.mobileArea),
    mobile1: cleanUpper(source.mobile1),
    mobile2: cleanUpper(source.mobile2),
    personalEmail: cleanEmail(source.personalEmail),
    generalEmail: cleanEmail(source.generalEmail),
    privateEmail: cleanEmail(source.privateEmail),
    notes: cleanUpper(source.notes),
    confidence: clampConfidence(source.confidence),
  }
}

function normalizeAiDraft(value: unknown, access: ReturnType<typeof getAccess>): AiDraft {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const warnings = Array.isArray(source.warnings) ? source.warnings.map(cleanText).filter(Boolean) : []

  const calendarEvents = access.eventCalendar
    ? (Array.isArray(source.calendarEvents) ? source.calendarEvents : [])
        .map(normalizeCalendarDraft)
        .filter((item): item is CalendarDraft => Boolean(item))
    : []
  const phonebookCompanies = access.phonebook
    ? (Array.isArray(source.phonebookCompanies) ? source.phonebookCompanies : [])
        .map(normalizePhonebookCompanyDraft)
        .filter((item): item is PhonebookCompanyDraft => Boolean(item))
    : []
  const phonebookContacts = access.phonebook
    ? (Array.isArray(source.phonebookContacts) ? source.phonebookContacts : [])
        .map(normalizePhonebookContactDraft)
        .filter((item): item is PhonebookContactDraft => Boolean(item))
    : []

  if (!access.eventCalendar) warnings.push("Event Calendar is not editable for this user.")
  if (!access.phonebook) warnings.push("Phonebook is not editable for this user.")

  return {
    summary: cleanText(source.summary) || "Draft ready for review.",
    calendarEvents,
    phonebookCompanies,
    phonebookContacts,
    warnings,
    availableTools: access,
  }
}

function getHongKongDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())

  const year = parts.find((part) => part.type === "year")?.value || "2026"
  const month = parts.find((part) => part.type === "month")?.value || "01"
  const day = parts.find((part) => part.type === "day")?.value || "01"
  return `${year}-${month}-${day}`
}

function buildAiInstructions(access: ReturnType<typeof getAccess>) {
  const today = getHongKongDateKey()
  const enabledWorkflows = [
    access.eventCalendar ? "event calendar" : "",
    access.phonebook ? "phonebook" : "",
  ].filter(Boolean).join(", ")

  return [
    "You extract office admin work from pasted text into reviewable database drafts.",
    `Today is ${today} in Asia/Hong_Kong. Resolve relative dates against this date.`,
    `Only use these enabled workflows: ${enabledWorkflows || "none"}.`,
    "For event calendar work, return concise uppercase calendar titles, YYYY-MM-DD dates, people initials, tags, and one event type.",
    "For phonebook work, extract company and contact fields exactly from the input. Do not invent missing phone numbers, emails, names, companies, or countries.",
    "If a date, company, or contact name is unclear, omit that draft and add a warning.",
  ].join("\n")
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const source = payload as Record<string, unknown>
  if (typeof source.output_text === "string") return source.output_text

  const output = Array.isArray(source.output) ? source.output : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === "string") chunks.push(text)
    }
  }
  return chunks.join("\n").trim()
}

function getProvider() {
  const configured = cleanText(process.env.AI_PROVIDER).toLowerCase()
  if (configured === "openai") return "openai" as const
  if (configured === "gemini") return "gemini" as const
  if (process.env.GEMINI_API_KEY) return "gemini" as const
  return "openai" as const
}

function stripUnsupportedGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsupportedGeminiSchema)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, item]) => [key, stripUnsupportedGeminiSchema(item)]),
  )
}

function getAiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback
  const error = (payload as Record<string, unknown>).error
  if (error && typeof error === "object") {
    const message = cleanText((error as Record<string, unknown>).message)
    if (message) return message
  }
  return fallback
}

async function createOpenAiDraft(prompt: string, access: ReturnType<typeof getAccess>) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new HttpError("OPENAI_API_KEY is not configured.", 503)
  }

  const model = process.env.OPENAI_ADMIN_MODEL || "gpt-5.4-mini"

  const startedAt = Date.now()
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions: buildAiInstructions(access),
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "admin_ai_workbench_draft",
          strict: true,
          schema: AI_SCHEMA,
        },
      },
    }),
  })

  const payload = await response.json().catch(() => ({}))
  await recordOpenAiUsage({
    pageId: "admin-home",
    pagePath: "/admin",
    feature: "ai-workbench-draft",
    model,
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    payload,
  })
  if (!response.ok) {
    throw new HttpError(getAiErrorMessage(payload, "OpenAI request failed."), response.status)
  }

  const outputText = extractOutputText(payload)
  if (!outputText) throw new Error("OpenAI returned no draft.")

  let parsed: unknown
  try {
    parsed = JSON.parse(outputText)
  } catch {
    throw new Error("OpenAI returned an unreadable draft.")
  }

  const draft = normalizeAiDraft(parsed, access)
  draft.model = model
  draft.provider = "openai"
  return draft
}

async function createGeminiDraft(prompt: string, access: ReturnType<typeof getAccess>) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new HttpError("GEMINI_API_KEY is not configured.", 503)
  }

  const model = process.env.GEMINI_ADMIN_MODEL || "gemini-3-flash-preview"
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      store: false,
      input: `${buildAiInstructions(access)}\n\nUser input:\n${prompt}`,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: stripUnsupportedGeminiSchema(AI_SCHEMA),
      },
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new HttpError(getAiErrorMessage(payload, "Gemini request failed."), response.status)
  }

  const outputText = extractOutputText(payload)
  if (!outputText) throw new Error("Gemini returned no draft.")

  let parsed: unknown
  try {
    parsed = JSON.parse(outputText)
  } catch {
    throw new Error("Gemini returned an unreadable draft.")
  }

  const draft = normalizeAiDraft(parsed, access)
  draft.model = model
  draft.provider = "gemini"
  return draft
}

async function createAiDraft(prompt: string, access: ReturnType<typeof getAccess>) {
  return getProvider() === "openai"
    ? createOpenAiDraft(prompt, access)
    : createGeminiDraft(prompt, access)
}

function normalizeStoredEvents(value: unknown): OfficeCalendarEvent[] {
  const source = Array.isArray(value) ? value : officeCalendarSeedEvents
  return source
    .filter((event): event is OfficeCalendarEvent => {
      return (
        event &&
        typeof event.id === "string" &&
        typeof event.startDate === "string" &&
        typeof event.endDate === "string" &&
        typeof event.title === "string" &&
        Array.isArray(event.people) &&
        Array.isArray(event.tags)
      )
    })
    .map((event) => ({
      ...event,
      people: normalizePeople(event.people),
      uncertainPeople: normalizePeople(event.uncertainPeople || []),
      tags: normalizePeople(event.tags),
      eventType: normalizeEventType(event.eventType),
    }))
}

function eventKey(event: Pick<OfficeCalendarEvent, "title" | "startDate" | "endDate">) {
  return `${event.startDate}|${event.endDate}|${event.title.trim().toUpperCase()}`
}

async function applyCalendarEvents(
  request: Request,
  session: AdminSession,
  calendarEvents: CalendarDraft[],
) {
  if (!calendarEvents.length) return { inserted: 0, skipped: 0 }
  if (!hasAdminPagePermission(session, "event-calendar", "edit")) {
    throw new HttpError("Forbidden", 403)
  }

  const supabase = createAdminAuditedSupabaseClient(
    createAdminAuditContext(session, request, "event-calendar"),
    { useServiceRole: true },
  )
  const { data, error } = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", "event-calendar")
    .maybeSingle()
  if (error) throw error

  const payload = data?.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {}
  const existingEvents = normalizeStoredEvents(payload.events)
  const seen = new Set(existingEvents.map(eventKey))
  const insertedEvents: OfficeCalendarEvent[] = []
  let inserted = 0
  let skipped = 0

  for (const draft of calendarEvents) {
    const nextEvent: OfficeCalendarEvent = {
      id: `ai-${Date.now()}-${randomUUID().slice(0, 8)}`,
      startDate: draft.startDate,
      endDate: draft.endDate,
      title: draft.title,
      people: draft.people,
      tags: draft.tags,
      eventType: draft.eventType,
    }
    const key = eventKey(nextEvent)
    if (seen.has(key)) {
      skipped += 1
      continue
    }

    seen.add(key)
    insertedEvents.push(nextEvent)
    inserted += 1
  }

  const people = normalizePeople([
    ...(Array.isArray(payload.people) ? payload.people : DEFAULT_PEOPLE),
    ...calendarEvents.flatMap((event) => event.people),
  ])
  await mutateEventCalendarStore(supabase, {
    operation: "insert",
    events: insertedEvents,
    settings: { people },
  })

  return { inserted, skipped }
}

function buildContactSearchText(contact: Record<string, unknown>) {
  return [
    contact.full_name,
    contact.company,
    contact.title,
    contact.position,
    contact.department,
    contact.direct_line,
    contact.mobile_area,
    contact.mobile_1,
    contact.mobile_2,
    contact.personal_email,
    contact.general_email,
    contact.private_email,
    contact.notes,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function withoutEmptyValues(values: Record<string, string | boolean | null>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== ""),
  )
}

async function findCompanyByName(supabase: ReturnType<typeof createAdminAuditedSupabaseClient>, name: string) {
  const { data, error } = await supabase
    .from("phonebook_companies")
    .select("*")
    .eq("name", name)
    .order("updated_at", { ascending: false })
    .limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length ? data[0] as Record<string, unknown> : null
}

async function ensureCompany(
  supabase: ReturnType<typeof createAdminAuditedSupabaseClient>,
  draft: Partial<PhonebookCompanyDraft> & { name: string },
) {
  const name = cleanUpper(draft.name)
  if (!name) throw new Error("Company name is required.")

  const existing = await findCompanyByName(supabase, name)
  const payload = {
    name,
    source_key: cleanText(existing?.source_key) || `ai-company-${Date.now()}-${randomUUID().slice(0, 8)}`,
    other_name: cleanUpper(draft.otherName) || null,
    country: cleanUpper(draft.country) || null,
    phone: cleanUpper(draft.phone) || null,
    address: cleanUpper(draft.address) || null,
    website: cleanText(draft.website) || null,
    email: cleanEmail(draft.email) || null,
    notes: cleanUpper(draft.notes) || null,
  }

  if (existing) {
    const updatePayload = withoutEmptyValues(payload)
    const { data, error } = await supabase
      .from("phonebook_companies")
      .update(updatePayload)
      .eq("id", cleanText(existing.id))
      .select("*")
      .single()
    if (error) throw error
    return data as Record<string, unknown>
  }

  const { data, error } = await supabase
    .from("phonebook_companies")
    .insert(payload)
    .select("*")
    .single()
  if (error) throw error
  return data as Record<string, unknown>
}

async function findContact(
  supabase: ReturnType<typeof createAdminAuditedSupabaseClient>,
  fullName: string,
  company: string,
) {
  const { data, error } = await supabase
    .from("phonebook_contacts")
    .select("*")
    .eq("full_name", fullName)
    .eq("company", company)
    .order("updated_at", { ascending: false })
    .limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length ? data[0] as Record<string, unknown> : null
}

function contactPayload(
  draft: PhonebookContactDraft,
  company: Record<string, unknown>,
  existing?: Record<string, unknown> | null,
) {
  const payload = {
    full_name: draft.fullName,
    company: cleanUpper(company.name) || draft.company,
    company_source_id: cleanText(company.source_key) || null,
    title: draft.title || null,
    position: draft.position || null,
    department: draft.department || null,
    direct_line: draft.directLine || null,
    mobile_area: draft.mobileArea || null,
    mobile_1: draft.mobile1 || null,
    mobile_2: draft.mobile2 || null,
    personal_email: draft.personalEmail || null,
    general_email: draft.generalEmail || null,
    private_email: draft.privateEmail || null,
    mobile_phone: draft.mobile1 || null,
    pager: draft.mobile2 || null,
    business_phone: draft.directLine || null,
    email_1: draft.personalEmail || null,
    email_2: draft.generalEmail || null,
    notes: draft.notes || null,
    favorite: Boolean(existing?.favorite),
    source_key: cleanText(existing?.source_key) || `ai-contact-${Date.now()}-${randomUUID().slice(0, 8)}`,
  }

  return {
    ...payload,
    search_text: buildContactSearchText(payload),
  }
}

async function syncCardDav(request: Request, contactIds: string[]) {
  if (!contactIds.length) return null

  try {
    const response = await fetch(new URL("/api/phonebook/carddav-sync", request.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: request.headers.get("cookie") || "",
      },
      body: JSON.stringify({ contactIds }),
      cache: "no-store",
    })
    const payload = await response.json().catch(() => ({}))
    return {
      ok: response.ok,
      message: cleanText((payload as Record<string, unknown>).message) ||
        (response.ok ? "CardDAV sync completed." : "CardDAV sync failed."),
      failed: Array.isArray((payload as Record<string, unknown>).failed)
        ? (payload as Record<string, unknown>).failed
        : [],
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "CardDAV sync failed.",
      failed: [],
    }
  }
}

async function applyPhonebook(
  request: Request,
  session: AdminSession,
  companies: PhonebookCompanyDraft[],
  contacts: PhonebookContactDraft[],
) {
  if (!companies.length && !contacts.length) {
    return { companiesCreatedOrUpdated: 0, contactsCreated: 0, contactsUpdated: 0, cardDav: null }
  }
  if (!hasAdminPagePermission(session, "phonebook", "edit")) {
    throw new HttpError("Forbidden", 403)
  }

  const supabase = createAdminAuditedSupabaseClient(
    createAdminAuditContext(session, request, "phonebook"),
    { useServiceRole: true },
  )
  const companyMap = new Map<string, Record<string, unknown>>()
  let companiesCreatedOrUpdated = 0

  for (const companyDraft of companies) {
    const company = await ensureCompany(supabase, companyDraft)
    companyMap.set(cleanUpper(company.name), company)
    companiesCreatedOrUpdated += 1
  }

  let contactsCreated = 0
  let contactsUpdated = 0
  const changedContactIds: string[] = []

  for (const contactDraft of contacts) {
    const companyKey = cleanUpper(contactDraft.company)
    const company =
      companyMap.get(companyKey) ||
      await ensureCompany(supabase, { name: companyKey })
    companyMap.set(companyKey, company)

    const existing = await findContact(supabase, contactDraft.fullName, cleanUpper(company.name))
    const payload = contactPayload(contactDraft, company, existing)

    if (existing) {
      const updatePayload = withoutEmptyValues(payload)
      const { data, error } = await supabase
        .from("phonebook_contacts")
        .update(updatePayload)
        .eq("id", cleanText(existing.id))
        .select("id")
        .single()
      if (error) throw error
      contactsUpdated += 1
      changedContactIds.push(cleanText(data.id))
      continue
    }

    const { data, error } = await supabase
      .from("phonebook_contacts")
      .insert(payload)
      .select("id")
      .single()
    if (error) throw error
    contactsCreated += 1
    changedContactIds.push(cleanText(data.id))
  }

  const cardDav = await syncCardDav(request, changedContactIds.filter(Boolean))
  return { companiesCreatedOrUpdated, contactsCreated, contactsUpdated, cardDav }
}

export async function POST(request: Request) {
  try {
    const session = await getAdminSession()
    if (!session.authenticated) throw new HttpError("Unauthorized", 401)

    const access = getAccess(session)
    if (!access.eventCalendar && !access.phonebook) {
      throw new HttpError("Forbidden", 403)
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const action = cleanText(body.action)

    if (action === "draft") {
      const prompt = cleanText(body.prompt)
      if (!prompt) throw new HttpError("Enter something to process.", 400)
      if (prompt.length > 12000) throw new HttpError("Input is too long.", 400)

      const draft = await createAiDraft(prompt, access)
      return NextResponse.json(draft)
    }

    if (action === "apply") {
      const calendarEvents = (Array.isArray(body.calendarEvents) ? body.calendarEvents : [])
        .map(normalizeCalendarDraft)
        .filter((item): item is CalendarDraft => Boolean(item))
      const phonebookCompanies = (Array.isArray(body.phonebookCompanies) ? body.phonebookCompanies : [])
        .map(normalizePhonebookCompanyDraft)
        .filter((item): item is PhonebookCompanyDraft => Boolean(item))
      const phonebookContacts = (Array.isArray(body.phonebookContacts) ? body.phonebookContacts : [])
        .map(normalizePhonebookContactDraft)
        .filter((item): item is PhonebookContactDraft => Boolean(item))

      if (!calendarEvents.length && !phonebookCompanies.length && !phonebookContacts.length) {
        throw new HttpError("No valid drafts selected.", 400)
      }

      const [calendar, phonebook] = await Promise.all([
        applyCalendarEvents(request, session, calendarEvents),
        applyPhonebook(request, session, phonebookCompanies, phonebookContacts),
      ])

      return NextResponse.json({ calendar, phonebook })
    }

    throw new HttpError("Unknown AI workbench action.", 400)
  } catch (error) {
    return errorResponse(error)
  }
}
