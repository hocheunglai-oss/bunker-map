import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  getEventCalendarEventVersions,
  getEventCalendarRecordVersion,
  getEventCalendarSettingVersions,
  mutateEventCalendarStore,
} from "@/lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"

type CalendarEvent = {
  id: string
  startDate: string
  endDate: string
  title: string
  people: string[]
  uncertainPeople?: string[]
  tags: string[]
  eventType?: string
  sourceRow?: number
}

type AuditRow = {
  occurred_at: string
  actor_id: string | null
  actor_name: string | null
  before_row: unknown
  after_row: unknown
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)))
}

function normalizeEvent(value: unknown): CalendarEvent | null {
  const event = asRecord(value)
  if (
    typeof event.id !== "string" ||
    typeof event.startDate !== "string" ||
    typeof event.endDate !== "string" ||
    typeof event.title !== "string"
  ) {
    return null
  }

  return {
    id: event.id.trim(),
    startDate: event.startDate,
    endDate: event.endDate,
    title: event.title,
    people: normalizeStringList(event.people),
    uncertainPeople: normalizeStringList(event.uncertainPeople),
    tags: normalizeStringList(event.tags),
    eventType: typeof event.eventType === "string" ? event.eventType : undefined,
    sourceRow: typeof event.sourceRow === "number" ? event.sourceRow : undefined,
  }
}

function payloadFromRow(row: unknown) {
  const record = asRecord(row)
  if (record.key !== "event-calendar") return null
  return asRecord(record.payload)
}

function eventsFromPayload(payload: unknown) {
  const events = asRecord(payload).events
  if (!Array.isArray(events)) return []
  return events.map(normalizeEvent).filter((event): event is CalendarEvent => Boolean(event))
}

function getTodayKey() {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return formatter.format(now)
}

async function findRecoverableEvents() {
  const supabase = getSupabaseClient()
  const { data: currentRow, error: currentError } = await supabase
    .from("office_calendar_store")
    .select("payload")
    .eq("key", "event-calendar")
    .maybeSingle()

  if (currentError) throw currentError

  const currentPayload = asRecord(currentRow?.payload)
  const currentEvents = eventsFromPayload(currentPayload)
  const currentEventIds = new Set(currentEvents.map((event) => event.id))
  const deletedEventIds = new Set([
    ...normalizeStringList(currentPayload.deletedEventIds),
    ...normalizeStringList(currentPayload.deletedRequiredSeedIds),
  ])
  const todayKey = getTodayKey()
  const candidatesById = new Map<string, CalendarEvent & {
    recoveredFrom: string
    actorName: string
  }>()

  const { data: auditRows, error: auditError } = await supabase
    .from("audit_logs")
    .select("occurred_at, actor_id, actor_name, before_row, after_row")
    .eq("table_schema", "public")
    .eq("table_name", "office_calendar_store")
    .order("occurred_at", { ascending: false })
    .limit(500)

  if (auditError) throw auditError

  for (const row of (auditRows || []) as AuditRow[]) {
    for (const payload of [payloadFromRow(row.after_row), payloadFromRow(row.before_row)]) {
      for (const event of eventsFromPayload(payload)) {
        if (currentEventIds.has(event.id) || deletedEventIds.has(event.id) || event.endDate < todayKey) continue
        if (candidatesById.has(event.id)) continue
        candidatesById.set(event.id, {
          ...event,
          recoveredFrom: row.occurred_at,
          actorName: row.actor_name || row.actor_id || "Unknown",
        })
      }
    }
  }

  return {
    currentPayload,
    currentEvents,
    candidates: Array.from(candidatesById.values()).sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title)
    ),
  }
}

export async function GET() {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    await requireAdminPagePermission("audit-log", "view")

    const result = await findRecoverableEvents()
    return NextResponse.json({
      recoverableEvents: result.candidates,
      count: result.candidates.length,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not inspect recoverable events." },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("event-calendar", "edit")
    await requireAdminPagePermission("audit-log", "view")

    const result = await findRecoverableEvents()
    const body = await request.json().catch(() => ({}))
    const requestedIds = new Set(normalizeStringList(asRecord(body).eventIds))
    const restoreEvents = requestedIds.size
      ? result.candidates.filter((event) => requestedIds.has(event.id))
      : result.candidates

    if (!restoreEvents.length) {
      return NextResponse.json({
        restoredEvents: [],
        restoredCount: 0,
        payload: result.currentPayload,
        eventVersions: getEventCalendarEventVersions(result.currentPayload),
        settingVersions: getEventCalendarSettingVersions(result.currentPayload),
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
      })
    }

    const existingIds = new Set(result.currentEvents.map((event) => event.id))
    const restoredEvents = restoreEvents
      .filter((event) => !existingIds.has(event.id))
      .map(normalizeEvent)
      .filter((event): event is CalendarEvent => Boolean(event))

    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "event-calendar"),
      { useServiceRole: true }
    )
    const payload = await mutateEventCalendarStore(supabase, {
      operation: "insert",
      events: restoredEvents,
    })
    const canonicalEvents = new Map(eventsFromPayload(payload).map((event) => [event.id, event]))
    const confirmedRestoredEvents = restoredEvents.filter((event) => {
      const canonicalEvent = canonicalEvents.get(event.id)
      return canonicalEvent && (
        getEventCalendarRecordVersion(canonicalEvent) === getEventCalendarRecordVersion(event)
      )
    })

    return NextResponse.json({
      restoredEvents: confirmedRestoredEvents,
      restoredCount: confirmedRestoredEvents.length,
      payload,
      eventVersions: getEventCalendarEventVersions(payload),
      settingVersions: getEventCalendarSettingVersions(payload),
      protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not restore missing events." },
      { status: 500 }
    )
  }
}
