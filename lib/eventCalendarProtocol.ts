export const EVENT_CALENDAR_PROTOCOL_VERSION = 2

export const EVENT_CALENDAR_OPERATIONS = ["create", "update", "upsert", "insert", "delete", "cancel", "people", "settings"] as const
export type EventCalendarOperation = (typeof EVENT_CALENDAR_OPERATIONS)[number]
export type EventCalendarEmailAction = "created" | "updated" | "cancelled"

export function isEventCalendarOperation(value: unknown): value is EventCalendarOperation {
  return EVENT_CALENDAR_OPERATIONS.some((operation) => operation === value)
}

/** Official holiday entries affect attendance independently of the event editor. */
export function isCalendarHoliday(event: { eventType?: unknown; title?: unknown; tags?: unknown; holidaySource?: unknown }) {
  const title = typeof event.title === "string" ? event.title.toUpperCase() : ""
  return event.eventType === "Public Holiday" || Boolean(event.holidaySource) ||
    title.includes("PUBLIC HOLIDAY") || title.includes("HOLIDAY ATTENDANCE") ||
    (Array.isArray(event.tags) && event.tags.some((tag) => typeof tag === "string" && tag.trim().toUpperCase() === "PUBLIC-HOLIDAY"))
}
