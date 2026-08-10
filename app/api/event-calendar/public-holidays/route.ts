import { NextResponse } from "next/server"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const HOLIDAY_COUNTRIES = [
  { code: "TW", label: "TAIWAN" },
  { code: "US", label: "USA" },
  { code: "SG", label: "SINGAPORE" },
  { code: "HK", label: "HONG KONG" },
] as const
type HolidayCountryCode = (typeof HOLIDAY_COUNTRIES)[number]["code"]

type NagerHoliday = {
  date: string
  localName?: string
  name?: string
  global?: boolean
  counties?: string[] | null
  types?: string[]
}

function parseYears(value: string | null) {
  const currentYear = new Date().getFullYear()
  const years = (value || String(currentYear))
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= currentYear - 1 && item <= currentYear + 3)

  return Array.from(new Set(years.length ? years : [currentYear]))
}

function parseCountries(value: string | null) {
  const allowedCountries = new Set<HolidayCountryCode>(HOLIDAY_COUNTRIES.map((country) => country.code))
  const countries = (value || "TW,US,SG,HK")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is HolidayCountryCode => allowedCountries.has(item as HolidayCountryCode))

  return Array.from(new Set(countries.length ? countries : ["TW", "US", "SG", "HK"]))
}

async function fetchCountryHolidays(year: number, countryCode: string) {
  let response: Response

  try {
    response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`, {
      cache: "no-store",
    })
  } catch {
    throw new Error("Public holiday provider is not reachable.")
  }

  if (!response.ok) {
    throw new Error(`Public holiday import failed for ${countryCode} ${year}.`)
  }

  try {
    return (await response.json()) as NagerHoliday[]
  } catch {
    throw new Error("Public holiday provider returned an unreadable response.")
  }
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "view")
    const { searchParams } = new URL(request.url)
    const years = parseYears(searchParams.get("years"))
    const countries = parseCountries(searchParams.get("countries"))
    const events: OfficeCalendarEvent[] = []
    const seen = new Set<string>()

    for (const year of years) {
      for (const country of HOLIDAY_COUNTRIES.filter((item) => countries.includes(item.code))) {
        let holidays: NagerHoliday[]

        try {
          holidays = await fetchCountryHolidays(year, country.code)
        } catch {
          continue
        }

        for (const holiday of holidays) {
          if (!holiday.date) continue
          const key = `${holiday.date}-${country.code}`
          if (seen.has(key)) continue
          seen.add(key)

          events.push({
            id: `public-holiday-${country.code.toLowerCase()}-${holiday.date}`,
            startDate: holiday.date,
            endDate: holiday.date,
            title:
              country.code === "HK"
                ? `HOLIDAY ATTENDANCE - ${(holiday.name || holiday.localName || country.label).toUpperCase()}`
                : `PUBLIC HOLIDAY - ${country.label}`,
            people: [],
            tags: ["public-holiday", country.code],
            eventType: "Public Holiday",
          })
        }
      }
    }

    return NextResponse.json({ years, events })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Public holiday import failed." },
      { status: 500 }
    )
  }
}
