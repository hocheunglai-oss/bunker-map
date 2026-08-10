import type { SupabaseClient } from "@supabase/supabase-js"
import {
  officeCalendarSeedEvents,
  type OfficeCalendarEvent,
} from "@/data/eventCalendar"
import { formatIsoDate, parseIsoDate } from "@/lib/attendanceRules"

export const DEFAULT_ATTENDANCE_STAFF_ORDER = Object.freeze([
  "VL",
  "SC",
  "OL",
  "DT",
  "KZ",
  "CY",
  "MY",
  "LC",
  "LL",
  "JZ",
])

export type AttendanceHoliday = {
  eventId: string | null
  title: string
  name: string | null
  attendeeStaffCodes: string[]
  people: string[]
}

export type AttendanceCalendarContext = {
  staffOrder: string[]
  holidaysByDate: Map<string, AttendanceHoliday>
}

type Row = Record<string, unknown>

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {}
}

function normalizedStaffCodes(value: unknown) {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .map((item) => String(item || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
}

function normalizedTags(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || "").trim().toUpperCase())
}

function isHongKongHolidayEvent(event: Row) {
  const title = String(event.title || "").trim().toUpperCase()
  const tags = normalizedTags(event.tags)
  return (
    title.startsWith("HOLIDAY ATTENDANCE") ||
    title === "PUBLIC HOLIDAY - HONG KONG" ||
    (tags.includes("PUBLIC-HOLIDAY") && tags.includes("HK"))
  )
}

function eventDates(event: Row) {
  const startText = String(event.startDate || "")
  const endText = String(event.endDate || startText)
  const start = parseIsoDate(startText)
  const end = parseIsoDate(endText)
  if (!start || !end || end.date < start.date) return []

  const dates: string[] = []
  for (
    let cursor = start.date;
    cursor <= end.date && dates.length < 14;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    dates.push(formatIsoDate(cursor))
  }
  return dates
}

export function attendanceHolidayEvents(
  events: unknown,
): Array<{ date: string; holiday: AttendanceHoliday }> {
  if (!Array.isArray(events)) return []
  const result: Array<{ date: string; holiday: AttendanceHoliday }> = []
  for (const rawEvent of events) {
    const event = asRow(rawEvent)
    if (!isHongKongHolidayEvent(event)) continue
    const title = String(event.title || "Hong Kong public holiday").trim()
    const people = normalizedStaffCodes(event.people)
    for (const date of eventDates(event)) {
      result.push({
        date,
        holiday: {
          eventId: typeof event.id === "string" ? event.id : null,
          title,
          name: title || null,
          attendeeStaffCodes: people,
          people,
        },
      })
    }
  }
  return result
}

function mergeHoliday(
  target: Map<string, AttendanceHoliday>,
  date: string,
  holiday: AttendanceHoliday,
) {
  const existing = target.get(date)
  if (!existing) {
    target.set(date, holiday)
    return
  }
  const attendeeStaffCodes = [
    ...new Set([
      ...existing.attendeeStaffCodes,
      ...holiday.attendeeStaffCodes,
    ]),
  ]
  target.set(date, {
    eventId: existing.eventId || holiday.eventId,
    title: existing.title || holiday.title,
    name: existing.name || holiday.name,
    attendeeStaffCodes,
    people: attendeeStaffCodes,
  })
}

export async function loadAttendanceCalendarContext(
  client: SupabaseClient,
): Promise<AttendanceCalendarContext> {
  const { data, error } = await client
    .from("office_calendar_store")
    .select("payload")
    .eq("key", "event-calendar")
    .maybeSingle()

  if (error) {
    throw new Error(
      `Could not load persisted Event Calendar: ${error.message || "Unknown database error."}`,
    )
  }

  const storedPayload = data?.payload
  const payload = asRow(storedPayload)
  const payloadIsObject =
    storedPayload !== null &&
    typeof storedPayload === "object" &&
    !Array.isArray(storedPayload)
  const storeIsAbsentOrEmpty =
    !data || storedPayload === null || (payloadIsObject && !Object.keys(payload).length)

  if (!storeIsAbsentOrEmpty && (!payloadIsObject || !Array.isArray(payload.events))) {
    throw new Error("Persisted Event Calendar payload is invalid.")
  }

  const events = storeIsAbsentOrEmpty
    ? (officeCalendarSeedEvents satisfies OfficeCalendarEvent[])
    : payload.events
  const storedOrder = normalizedStaffCodes(payload.people)
  const staffOrder = storedOrder.length
    ? storedOrder
    : [...DEFAULT_ATTENDANCE_STAFF_ORDER]
  const holidaysByDate = new Map<string, AttendanceHoliday>()

  for (const entry of attendanceHolidayEvents(events)) {
    mergeHoliday(holidaysByDate, entry.date, entry.holiday)
  }

  return { staffOrder, holidaysByDate }
}

export function sortAttendancePeople<T extends { staffCode: string }>(
  people: T[],
  staffOrder: string[],
) {
  const rank = new Map(
    staffOrder.map((staffCode, index) => [staffCode.toUpperCase(), index]),
  )
  return [...people].sort((left, right) => {
    const leftCode = left.staffCode.trim().toUpperCase()
    const rightCode = right.staffCode.trim().toUpperCase()
    const leftRank = rank.get(leftCode)
    const rightRank = rank.get(rightCode)
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1
      if (rightRank === undefined) return -1
      if (leftRank !== rightRank) return leftRank - rightRank
    }
    return leftCode.localeCompare(rightCode)
  })
}
