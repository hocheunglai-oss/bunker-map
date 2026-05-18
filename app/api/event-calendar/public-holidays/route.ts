import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { OfficeCalendarEvent } from "@/data/eventCalendar"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const HOLIDAY_COUNTRIES = [
  { code: "TW", label: "TAIWAN" },
  { code: "US", label: "USA" },
  { code: "SG", label: "SINGAPORE" },
] as const

type NagerHoliday = {
  date: string
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
  const cookieStore = await cookies()

  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Admin login required." }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const years = parseYears(searchParams.get("years"))
  const events: OfficeCalendarEvent[] = []
  const seen = new Set<string>()

  try {
    for (const year of years) {
      for (const country of HOLIDAY_COUNTRIES) {
        const holidays = await fetchCountryHolidays(year, country.code)

        for (const holiday of holidays) {
          if (!holiday.date) continue
          const key = `${holiday.date}-${country.code}`
          if (seen.has(key)) continue
          seen.add(key)

          events.push({
            id: `public-holiday-${country.code.toLowerCase()}-${holiday.date}`,
            startDate: holiday.date,
            endDate: holiday.date,
            title: `PUBLIC HOLIDAY - ${country.label}`,
            people: [],
            tags: ["public-holiday", country.code],
            eventType: "Public Holiday",
          })
        }
      }
    }

    return NextResponse.json({ years, events })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Public holiday import failed." },
      { status: 500 }
    )
  }
}
