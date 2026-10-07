import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  HOLIDAY_COUNTRIES, HOLIDAY_LABELS, HOLIDAY_SCOPES, HOLIDAY_SOURCES,
  PUBLIC_HOLIDAY_DEFINITIONS, PUBLIC_HOLIDAY_REVISION,
  type HolidayCountry, type HolidayDefinition,
} from "@/data/publicHolidays"

export type HolidayCoverage = {
  country: HolidayCountry
  year: number
  status: "verified" | "unavailable"
  sourceUrls: string[]
  calendarScope: string
  eventCount: number
  message?: string
}
export type HolidaySource = {
  identity: string
  country: HolidayCountry
  year: number
  revision: string
  sourceUrls: string[]
  calendarScope: string
  deletionIds: string[]
  baseline: string
}
export type HolidayCalendarEvent = OfficeCalendarEvent & { holidaySource: HolidaySource }

export function holidayIdentity(holiday: HolidayDefinition) {
  return `${holiday.country.toLowerCase()}-${holiday.year}-${holiday.key}`
}

export function legacyHolidayId(country: HolidayCountry, date: string) {
  return `public-holiday-${country.toLowerCase()}-${date}`
}

// Baseline deliberately includes every editable field. Extra fields and people
// assignments are conservatively treated as manual changes by reconciliation.
export function holidayBaseline(event: OfficeCalendarEvent) {
  return JSON.stringify({ startDate: event.startDate, endDate: event.endDate,
    title: event.title, tags: [...event.tags].sort(), eventType: event.eventType || "Public Holiday",
    people: event.people, uncertainPeople: event.uncertainPeople || [], sourceRow: event.sourceRow ?? null })
}

export function holidayEvent(holiday: HolidayDefinition): HolidayCalendarEvent {
  const identity = holidayIdentity(holiday)
  const id = `public-holiday-${identity}`
  const event: OfficeCalendarEvent = {
    id, startDate: holiday.date, endDate: holiday.date,
    title: holiday.country === "HK" ? `HOLIDAY ATTENDANCE - ${holiday.name.toUpperCase()}`
      : `${holiday.country === "TW" ? "GOVERNMENT HOLIDAY" : "PUBLIC HOLIDAY"} - ${HOLIDAY_LABELS[holiday.country]}${holiday.country === "US" ? " (FEDERAL)" : ""} - ${holiday.name.toUpperCase()}`,
    people: [], uncertainPeople: [], tags: ["public-holiday", holiday.country], eventType: "Public Holiday",
  }
  return { ...event, holidaySource: {
    identity, country: holiday.country, year: holiday.year, revision: PUBLIC_HOLIDAY_REVISION,
    sourceUrls: HOLIDAY_SOURCES[holiday.country][holiday.year], calendarScope: HOLIDAY_SCOPES[holiday.country],
    deletionIds: [id, legacyHolidayId(holiday.country, holiday.date), ...(holiday.legacyDates || []).map((date) => legacyHolidayId(holiday.country, date))],
    baseline: holidayBaseline(event),
  } }
}

export function getVerifiedPublicHolidays(years: number[], countries: HolidayCountry[]) {
  const coverage: HolidayCoverage[] = []
  const events: HolidayCalendarEvent[] = []
  for (const year of [...new Set(years)]) {
    for (const country of [...new Set(countries)]) {
      const definitions = PUBLIC_HOLIDAY_DEFINITIONS.filter((item) => item.country === country && item.year === year)
      const sourceUrls = HOLIDAY_SOURCES[country]?.[year] || []
      const available = sourceUrls.length > 0 && definitions.length > 0
      coverage.push({ country, year, status: available ? "verified" : "unavailable", sourceUrls,
        calendarScope: HOLIDAY_SCOPES[country], eventCount: definitions.length,
        ...(!available ? { message: `${HOLIDAY_LABELS[country]} ${year} has not been verified. No dates were guessed or changed.` } : {}),
      })
      if (available) events.push(...definitions.map(holidayEvent))
    }
  }
  return { years: [...new Set(years)], countries: [...new Set(countries)], events, coverage,
    complete: coverage.length > 0 && coverage.every((item) => item.status === "verified"), revision: PUBLIC_HOLIDAY_REVISION }
}

export function parseHolidayRequest(yearsValue: unknown, countriesValue: unknown, now = new Date()) {
  const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric" }).format(now))
  const years = yearsValue == null ? [currentYear, currentYear + 1]
    : Array.isArray(yearsValue) ? yearsValue : String(yearsValue).split(",")
  const countries = countriesValue == null ? [...HOLIDAY_COUNTRIES]
    : Array.isArray(countriesValue) ? countriesValue : String(countriesValue).split(",")
  if (!years.length || years.length > 4 || years.some((year) => !/^\d{4}$/.test(String(year).trim()) || Number(year) < 2000 || Number(year) > 2100)) {
    throw new Error("Choose between one and four valid calendar years.")
  }
  const codes = countries.map((value) => String(value).trim().toUpperCase())
  if (!codes.length || codes.length > 4 || codes.some((code) => !HOLIDAY_COUNTRIES.includes(code as HolidayCountry))) {
    throw new Error("Choose Hong Kong, Singapore, Taiwan or USA.")
  }
  return { years: [...new Set(years.map(Number))], countries: [...new Set(codes)] as HolidayCountry[] }
}
