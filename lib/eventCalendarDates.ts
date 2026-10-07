export const EVENT_CALENDAR_TIME_ZONE = "Asia/Hong_Kong"

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** A calendar date, independent of the computer's local timezone. */
export function getHongKongDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_CALENDAR_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now)
}

export function addCalendarDays(value: string, days: number) {
  if (!isValidCalendarDate(value)) throw new Error("Enter a valid calendar date.")
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function preserveCalendarEndDate(start: string, currentEnd: string) {
  return isValidCalendarDate(currentEnd) && currentEnd >= start ? currentEnd : start
}

export function calendarDateTimestamp(value: string, time = "00:00") {
  if (!isValidCalendarDate(value) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Enter a valid calendar date and time.")
  }
  return new Date(`${value}T${time}:00+08:00`).getTime()
}
