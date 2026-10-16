import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  createAdminAuditContext,
  createAdminAuditedSupabaseClient,
} from "@/lib/adminAudit"
import {
  getEventCalendarEventVersions,
  getEventCalendarRecordVersion,
  getEventCalendarSettingVersions,
  mutateEventCalendarStoreBatch,
  validateEventCalendarEvent,
  EventCalendarValidationError,
  EVENT_CALENDAR_MAX_MUTATION_EVENTS,
  EVENT_CALENDAR_MAX_BATCH_MUTATIONS,
} from "@/lib/eventCalendarStore"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"
import { loadEventCalendarHistory, readRecoverableHolidaySource } from "@/lib/eventCalendarRecovery"
import type { HolidaySource } from "@/lib/holidayCalendar"

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
  holidaySource?: HolidaySource
}

function getSupabaseClient() {
  return createCalendarServiceClient()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)))
}

function normalizeEvent(value: unknown): CalendarEvent | null {
  try {
    validateEventCalendarEvent(value)
  } catch (error) {
    if (error instanceof EventCalendarValidationError) return null
    throw error
  }
  const event = asRecord(value)

  const holidaySource = readRecoverableHolidaySource(event.holidaySource, String(event.id))
  return {
    id: String(event.id),
    startDate: String(event.startDate),
    endDate: String(event.endDate),
    title: String(event.title),
    people: normalizeStringList(event.people),
    uncertainPeople: normalizeStringList(event.uncertainPeople),
    tags: normalizeStringList(event.tags),
    eventType: typeof event.eventType === "string" ? event.eventType : undefined,
    sourceRow: typeof event.sourceRow === "number" ? event.sourceRow : undefined,
    ...(holidaySource ? { holidaySource } : {}),
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

function eventIdsFromPayload(payload: unknown) {
  const events = asRecord(payload).events
  return new Set((Array.isArray(events) ? events : [])
    .map((event) => asRecord(event).id).filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))
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
  // Even a malformed current row still owns its ID; recovery must not replace it.
  const currentEventIds = eventIdsFromPayload(currentPayload)
  const deletedEventIds = new Set([
    ...normalizeStringList(currentPayload.deletedEventIds),
    ...normalizeStringList(currentPayload.deletedRequiredSeedIds),
  ])
  const todayKey = getTodayKey()
  const candidatesById = new Map<string, CalendarEvent & {
    recoveredFrom: string
    actorName: string
  }>()
  const invalidEventIds = new Set<string>()
  const skippedInvalidKeys = new Set<string>()

  const history = await loadEventCalendarHistory(supabase)
  for (const row of history.rows) {
    for (const payload of [payloadFromRow(row.after_row), payloadFromRow(row.before_row)]) {
      const historical = asRecord(payload).events
      for (const value of Array.isArray(historical) ? historical : []) {
        const record = asRecord(value)
        const id = typeof record.id === "string" ? record.id.trim() : ""
        if (currentEventIds.has(id) || deletedEventIds.has(id) || candidatesById.has(id) || invalidEventIds.has(id)) continue
        const event = normalizeEvent(value)
        if (!event) {
          // Do not label an older version as current when the newest is invalid.
          if (id) invalidEventIds.add(id)
          skippedInvalidKeys.add(id ? `id:${id}` : `row:${getEventCalendarRecordVersion(value)}`)
          continue
        }
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
    historyComplete: history.historyComplete,
    historyScanned: history.historyScanned,
    oldestChecked: history.oldestChecked,
    skippedInvalidCount: skippedInvalidKeys.size,
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
      historyComplete: result.historyComplete,
      historyScanned: result.historyScanned,
      oldestChecked: result.oldestChecked,
      skippedInvalidCount: result.skippedInvalidCount,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not inspect recoverable events." },
      { status: error instanceof Error && error.message === "Unauthorized" ? 401 : error instanceof Error && error.message === "Forbidden" ? 403 : 500 }
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
    const maximumRecoveryEvents = EVENT_CALENDAR_MAX_MUTATION_EVENTS * EVENT_CALENDAR_MAX_BATCH_MUTATIONS
    const selectedEvents = restoreEvents.slice(0, maximumRecoveryEvents)

    if (!restoreEvents.length) {
      return NextResponse.json({
        restoredEvents: [],
        restoredCount: 0,
        historyComplete: result.historyComplete,
        historyScanned: result.historyScanned,
        oldestChecked: result.oldestChecked,
        skippedInvalidCount: result.skippedInvalidCount,
        remainingCount: 0,
        payload: result.currentPayload,
        eventVersions: getEventCalendarEventVersions(result.currentPayload),
        settingVersions: getEventCalendarSettingVersions(result.currentPayload),
        protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
      })
    }

    const existingIds = new Set(result.currentEvents.map((event) => event.id))
    const restoredEvents = selectedEvents
      .filter((event) => !existingIds.has(event.id))
      .map(normalizeEvent)
      .filter((event): event is CalendarEvent => Boolean(event))

    const supabase = createAdminAuditedSupabaseClient(
      createAdminAuditContext(session, request, "event-calendar"),
      { useServiceRole: true }
    )
    const mutations = []
    for (let start = 0; start < restoredEvents.length; start += EVENT_CALENDAR_MAX_MUTATION_EVENTS) {
      mutations.push({ operation: "insert" as const, events: restoredEvents.slice(start, start + EVENT_CALENDAR_MAX_MUTATION_EVENTS) })
    }
    const payload = await mutateEventCalendarStoreBatch(supabase, mutations)
    const canonicalEvents = new Map(eventsFromPayload(payload).map((event) => [event.id, event]))
    const canonicalEventIds = eventIdsFromPayload(payload)
    const canonicalDeletedIds = new Set([
      ...normalizeStringList(payload.deletedEventIds),
      ...normalizeStringList(payload.deletedRequiredSeedIds),
    ])
    const remainingCount = restoreEvents.filter((event) => !canonicalEventIds.has(event.id) && !canonicalDeletedIds.has(event.id)).length
    const confirmedRestoredEvents = restoredEvents.filter((event) => {
      const canonicalEvent = canonicalEvents.get(event.id)
      return canonicalEvent && (
        getEventCalendarRecordVersion(canonicalEvent) === getEventCalendarRecordVersion(event)
      )
    })

    return NextResponse.json({
      restoredEvents: confirmedRestoredEvents,
      restoredCount: confirmedRestoredEvents.length,
      historyComplete: result.historyComplete,
      historyScanned: result.historyScanned,
      oldestChecked: result.oldestChecked,
      skippedInvalidCount: result.skippedInvalidCount,
      remainingCount,
      payload,
      eventVersions: getEventCalendarEventVersions(payload),
      settingVersions: getEventCalendarSettingVersions(payload),
      protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Could not restore missing events." },
      { status: error instanceof Error && error.message === "Unauthorized" ? 401 : error instanceof Error && error.message === "Forbidden" ? 403 : 500 }
    )
  }
}
