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

export function hongKongWorkingDayNumber(
  now = new Date(),
  holidayDates: ReadonlySet<string> = new Set(),
) {
  const today = hktDateFromTimestamp(now)
  const parsed = parseIsoDate(today)
  if (!parsed || !isWeekday(today) || holidayDates.has(today)) return 0
  let number = 0
  for (let day = 1; day <= parsed.day; day += 1) {
    const date = formatIsoDate(new Date(Date.UTC(parsed.year, parsed.month - 1, day)))
    if (isWeekday(date) && !holidayDates.has(date)) number += 1
  }
  return number
}

export function previousMonthPeriod(now = new Date()) {
  const today = parseIsoDate(hktDateFromTimestamp(now))!
  const previous = new Date(Date.UTC(today.year, today.month - 2, 1))
  return { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1 }
}
