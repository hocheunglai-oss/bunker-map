import {
  formatIsoDate,
  hktDateFromTimestamp,
  isWeekday,
  parseIsoDate,
} from "@/lib/attendanceRules"

export function isLastHongKongWorkingDay(
  now = new Date(),
  holidayDates: ReadonlySet<string> = new Set(),
) {
  const today = hktDateFromTimestamp(now)
  const parsed = parseIsoDate(today)
  if (!parsed || !isWeekday(today) || holidayDates.has(today)) return false

  for (
    let cursor = new Date(parsed.date.getTime() + 24 * 60 * 60 * 1000);
    cursor.getUTCMonth() === parsed.date.getUTCMonth();
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const date = formatIsoDate(cursor)
    if (isWeekday(date) && !holidayDates.has(date)) return false
  }
  return true
}
