import type { OfficeCalendarEvent } from "@/data/eventCalendar"

function normalizedTags(event: OfficeCalendarEvent) {
  return event.tags.map((tag) => tag.trim().toUpperCase())
}

function isHongKongHoliday(event: OfficeCalendarEvent) {
  const title = event.title.trim().toUpperCase()
  const tags = normalizedTags(event)

  return (
    event.id.toLowerCase().startsWith("public-holiday-hk-") ||
    title.startsWith("HOLIDAY ATTENDANCE") ||
    title === "PUBLIC HOLIDAY - HONG KONG" ||
    (tags.includes("PUBLIC-HOLIDAY") && tags.includes("HK"))
  )
}

function coversImportedHolidayDate(
  current: OfficeCalendarEvent,
  imported: OfficeCalendarEvent,
) {
  return (
    current.startDate <= imported.startDate &&
    current.endDate >= imported.endDate
  )
}

export function mergeImportedEvents<T extends OfficeCalendarEvent>(
  current: T[],
  imported: T[],
) {
  const seen = new Set(
    current.map(
      (event) =>
        `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`,
    ),
  )
  const seenIds = new Set(current.map((event) => event.id))
  const nextEvents = [...current]

  for (const event of imported) {
    const key = `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`
    const alreadyHasHongKongHoliday =
      isHongKongHoliday(event) &&
      nextEvents.some(
        (existing) =>
          isHongKongHoliday(existing) &&
          coversImportedHolidayDate(existing, event),
      )

    if (alreadyHasHongKongHoliday || seen.has(key) || seenIds.has(event.id)) {
      continue
    }

    seen.add(key)
    seenIds.add(event.id)
    nextEvents.push(event)
  }

  return nextEvents
}
