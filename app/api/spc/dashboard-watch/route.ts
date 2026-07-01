import { NextResponse } from "next/server"
import { requireSpcSession } from "@/lib/spcAuth"

const HKT_TIME_ZONE = "Asia/Hong_Kong"
const REQUEST_TIMEOUT_MS = 8000
const HOLIDAYS_PER_COUNTRY = 2
const MAX_HOLIDAY_DAYS_AHEAD = 5

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
      cache: "no-store",
      headers: { Accept: "application/json" },
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
  const countryResults = await Promise.allSettled(
    HOLIDAY_COUNTRIES.map(async (country) => {
      const [currentYearResult, nextYearResult] = await Promise.allSettled([
        fetchCountryHolidays(currentYear, country.code),
        fetchCountryHolidays(currentYear + 1, country.code),
      ])
      const holidays = [
        ...(currentYearResult.status === "fulfilled" ? currentYearResult.value : []),
        ...(nextYearResult.status === "fulfilled" ? nextYearResult.value : []),
      ]

      return holidays
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
    }),
  )

  const items = countryResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  )

  items.sort((first, second) => {
    if (first.date !== second.date) return first.date.localeCompare(second.date)
    return first.countryName.localeCompare(second.countryName)
  })

  return {
    checkedAt: new Date().toISOString(),
    fromDate,
    countries: HOLIDAY_COUNTRIES.map((country) => country.code).join(" "),
    items,
    error: null,
  }
}

export async function GET() {
  try {
    await requireSpcSession()
    const holidays = await fetchUpcomingHolidays()
    return NextResponse.json(
      { holidays },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
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
