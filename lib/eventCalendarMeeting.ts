import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { addCalendarDays, calendarDateTimestamp, EVENT_CALENDAR_TIME_ZONE, getHongKongDateKey, isValidCalendarDate } from "@/lib/eventCalendarDates"

export type CalendarInterval = { startMs: number; endMs: number; allDay: boolean }
export type MeetingRoomCalendarEvent = CalendarInterval & {
  id: string; calendarId: string; title: string; startDate: string; endDate: string
  startTime: string; endTime: string; sourceEventId: string; sourceTitle: string; transparent: boolean
}
export type GoogleCalendarRecord = {
  id?: string | null; summary?: string | null; description?: string | null; status?: string | null; transparency?: string | null
  start?: { date?: string | null; dateTime?: string | null } | null
  end?: { date?: string | null; dateTime?: string | null } | null
  extendedProperties?: { private?: Record<string, string> | null } | null
}

export function meetingRoomInterval(event: Pick<OfficeCalendarEvent, "startDate" | "endDate" | "title">): CalendarInterval {
  if (!isValidCalendarDate(event.startDate) || !isValidCalendarDate(event.endDate) || event.endDate < event.startDate) {
    throw new Error("The meeting room booking has an invalid date range.")
  }
  // Multiple date bookings occupy the entire inclusive date range. The same
  // conversion is used for availability checks and the Google Calendar write.
  const time = event.startDate === event.endDate
    ? event.title.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d))?\b/)
    : null
  if (!time) return { startMs: calendarDateTimestamp(event.startDate), endMs: calendarDateTimestamp(addCalendarDays(event.endDate, 1)), allDay: true }
  const startTime = `${time[1].padStart(2, "0")}:${time[2]}`
  const startMs = calendarDateTimestamp(event.startDate, startTime)
  let endMs = time[3]
    ? calendarDateTimestamp(event.endDate, `${time[3].padStart(2, "0")}:${time[4]}`)
    : startMs + 60 * 60 * 1000
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000
  return { startMs, endMs, allDay: false }
}

export function calendarIntervalsOverlap(left: CalendarInterval, right: CalendarInterval) {
  return left.startMs < right.endMs && left.endMs > right.startMs
}

export function googleMeetingRoomDates(event: Pick<OfficeCalendarEvent, "startDate" | "endDate" | "title">) {
  const interval = meetingRoomInterval(event)
  return interval.allDay
    ? { start: { date: event.startDate }, end: { date: addCalendarDays(event.endDate, 1) } }
    : {
        start: { dateTime: new Date(interval.startMs).toISOString(), timeZone: EVENT_CALENDAR_TIME_ZONE },
        end: { dateTime: new Date(interval.endMs).toISOString(), timeZone: EVENT_CALENDAR_TIME_ZONE },
      }
}

export function normalizeMeetingRoomGoogleEvent(event: GoogleCalendarRecord, calendarId: string): MeetingRoomCalendarEvent | null {
  if (event.status === "cancelled") return null
  const allDay = Boolean(event.start?.date && !event.start?.dateTime)
  const startMs = allDay ? calendarDateTimestamp(event.start!.date!) : Date.parse(event.start?.dateTime || "")
  const endMs = allDay ? calendarDateTimestamp(event.end?.date || "") : Date.parse(event.end?.dateTime || "")
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("A meeting room entry has an invalid date range. Availability could not be verified.")
  }
  const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: EVENT_CALENDAR_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false })
  const sourceEventId = event.extendedProperties?.private?.bunkerMapEventId || ""
  return {
    id: event.id || "", calendarId, title: sourceEventId ? "MARINE ENERGY" : event.summary || "(NO TITLE)",
    startDate: allDay ? event.start!.date! : getHongKongDateKey(new Date(startMs)),
    // Google's end.date is exclusive. Only display subtracts a day; overlap
    // calculations retain the original exclusive endMs.
    endDate: allDay ? addCalendarDays(event.end!.date!, -1) : getHongKongDateKey(new Date(endMs)),
    startTime: allDay ? "" : timeFormat.format(new Date(startMs)), endTime: allDay ? "" : timeFormat.format(new Date(endMs)),
    sourceEventId, sourceTitle: event.description?.match(/Original event: (.+)/)?.[1] || "",
    transparent: event.transparency === "transparent", startMs, endMs, allDay,
  }
}

/** Fail closed on an incomplete listing instead of silently claiming a room is free. */
export async function collectCalendarPages<T>(fetchPage: (pageToken?: string) => Promise<{ items?: T[] | null; nextPageToken?: string | null }>) {
  const items: T[] = []
  const seen = new Set<string>()
  let token: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = await fetchPage(token)
    items.push(...(result.items || []))
    if (!result.nextPageToken) return items
    if (seen.has(result.nextPageToken)) throw new Error("The meeting room calendar returned an incomplete listing. Please try again.")
    token = result.nextPageToken
    seen.add(token)
  }
  throw new Error("The meeting room calendar is too large to verify safely. Please contact an administrator.")
}
