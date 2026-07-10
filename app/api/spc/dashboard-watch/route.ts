import { NextResponse } from "next/server"
import { requireSpcSession } from "@/lib/spcAuth"
import { timedJson } from "@/lib/serverTiming"

const HKT_TIME_ZONE = "Asia/Hong_Kong"
const REQUEST_TIMEOUT_MS = 8000
const HOLIDAYS_PER_COUNTRY = 2
const MAX_HOLIDAY_DAYS_AHEAD = 5
const DASHBOARD_CACHE_MS = 6 * 60 * 60 * 1000
const HOLIDAY_FETCH_REVALIDATE_SECONDS = 12 * 60 * 60

type HolidayWatch = Awaited<ReturnType<typeof fetchUpcomingHolidays>>

let cachedHolidayWatch: { value: HolidayWatch; expiresAt: number } | null = null
let holidayWatchPromise: Promise<HolidayWatch> | null = null

const HOLIDAY_COUNTRIES = [
  { code: "IT", label: "Italy" },
  { code: "HK", label: "Hong Kong" },
  { code: "MC", label: "Monaco" },
  { code: "FR", label: "France" },
  { code: "US", label: "USA" },
  { code: "GR", label: "Greece" },
  { code: "SG", label: "Singapore" },
  { code: "JP", label: "Japan" },
  { code: "KR", label: "Korea" },
  { code: "VN", label: "Vietnam" },
] as const

type NagerHoliday = {
  date: string
  localName?: string
  name?: string
}

function formatHktDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HKT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function yearFromDateKey(dateKey: string) {
  return Number(dateKey.slice(0, 4))
}

function daysBetweenDateKeys(fromDateKey: string, toDateKey: string) {
  const [fromYear, fromMonth, fromDay] = fromDateKey.split("-").map(Number)
  const [toYear, toMonth, toDay] = toDateKey.split("-").map(Number)
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
      86400000,
  )
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: HOLIDAY_FETCH_REVALIDATE_SECONDS },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
    return response
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchCountryHolidays(year: number, countryCode: string) {
  const response = await fetchWithTimeout(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
  )
  return (await response.json()) as NagerHoliday[]
}

async function fetchUpcomingHolidays() {
  const fromDate = formatHktDateKey()
  const currentYear = yearFromDateKey(fromDate)
  const includeNextYear = fromDate >= `${currentYear}-12-27`
  const years = includeNextYear ? [currentYear, currentYear + 1] : [currentYear]
  const countryResults = await Promise.all(
    HOLIDAY_COUNTRIES.map(async (country) => {
      const results = await Promise.allSettled(
        years.map((year) => fetchCountryHolidays(year, country.code)),
      )
      const holidays = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      )

      const items = holidays
        .map((holiday) => ({
          holiday,
          daysUntil: daysBetweenDateKeys(fromDate, holiday.date),
        }))
        .filter(({ daysUntil }) => daysUntil >= 0 && daysUntil <= MAX_HOLIDAY_DAYS_AHEAD)
        .sort((first, second) => first.holiday.date.localeCompare(second.holiday.date))
        .slice(0, HOLIDAYS_PER_COUNTRY)
        .map(({ holiday, daysUntil }) => ({
          countryCode: country.code,
          countryName: country.label,
          date: holiday.date,
          name: holiday.name || holiday.localName || "Public holiday",
          localName: holiday.localName || null,
          daysUntil,
        }))

      return {
        items,
        failures: results.filter((result) => result.status === "rejected").length,
        requests: results.length,
      }
    }),
  )

  const items = countryResults.flatMap((result) => result.items)
  const failures = countryResults.reduce((total, result) => total + result.failures, 0)
  const requests = countryResults.reduce((total, result) => total + result.requests, 0)

  items.sort((first, second) => {
    if (first.date !== second.date) return first.date.localeCompare(second.date)
    return first.countryName.localeCompare(second.countryName)
  })

  return {
    checkedAt: new Date().toISOString(),
    fromDate,
    countries: HOLIDAY_COUNTRIES.map((country) => country.code).join(" "),
    items,
    error: failures === requests ? "Holiday service is temporarily unavailable." : null,
  }
}

async function loadUpcomingHolidays() {
  const currentDate = formatHktDateKey()
  if (
    cachedHolidayWatch &&
    cachedHolidayWatch.value.fromDate === currentDate &&
    cachedHolidayWatch.expiresAt > Date.now()
  ) {
    return { value: cachedHolidayWatch.value, cacheStatus: "hit" as const }
  }
  if (holidayWatchPromise) {
    return { value: await holidayWatchPromise, cacheStatus: "deduped" as const }
  }

  const stale = cachedHolidayWatch?.value.fromDate === currentDate
    ? cachedHolidayWatch.value
    : null
  holidayWatchPromise = fetchUpcomingHolidays()
  try {
    const value = await holidayWatchPromise
    cachedHolidayWatch = { value, expiresAt: Date.now() + DASHBOARD_CACHE_MS }
    return { value, cacheStatus: "miss" as const }
  } catch (error) {
    if (stale) return { value: stale, cacheStatus: "stale" as const }
    throw error
  } finally {
    holidayWatchPromise = null
  }
}

export async function GET() {
  const startedAt = Date.now()
  try {
    await requireSpcSession()
    const holidays = await loadUpcomingHolidays()
    return timedJson(
      "/api/spc/dashboard-watch",
      startedAt,
      { holidays: holidays.value },
      { headers: { "Cache-Control": "private, no-store" } },
      { cache: holidays.cacheStatus, returned: holidays.value.items.length },
    )
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "SPC dashboard watch unavailable." },
      { status: 500 },
    )
  }
}
