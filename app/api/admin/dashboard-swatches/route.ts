import { NextResponse } from "next/server"
import { requireAdminSession } from "@/lib/adminAuth"

const HKT_TIME_ZONE = "Asia/Hong_Kong"
const HOLIDAY_WINDOW_DAYS = 3
const REQUEST_TIMEOUT_MS = 8000

const HOLIDAY_COUNTRIES = [
  { code: "HK", label: "Hong Kong" },
  { code: "TW", label: "Taiwan" },
  { code: "SG", label: "Singapore" },
  { code: "US", label: "USA" },
  { code: "CN", label: "China" },
  { code: "KR", label: "Korea" },
  { code: "JP", label: "Japan" },
] as const

type TallyfyHoliday = {
  date?: string
  name?: string
  local_name?: string
  observed_date?: string
  is_observed_shifted?: boolean
}

type TallyfyHolidayResponse = {
  holidays?: TallyfyHoliday[]
}

type WarningSummary = Record<
  string,
  {
    name?: string
    code?: string
    actionCode?: string
    issueTime?: string
    updateTime?: string
  }
>

function getDateParts(dateKey: string) {
  return dateKey.split("-").map((part) => Number(part))
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

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = getDateParts(dateKey)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function daysBetweenDateKeys(fromDateKey: string, toDateKey: string) {
  const [fromYear, fromMonth, fromDay] = getDateParts(fromDateKey)
  const [toYear, toMonth, toDay] = getDateParts(toDateKey)
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
      86400000,
  )
}

function uniqueYearsBetween(fromDateKey: string, toDateKey: string) {
  const [fromYear] = getDateParts(fromDateKey)
  const [toYear] = getDateParts(toDateKey)
  const years = []

  for (let year = fromYear; year <= toYear; year += 1) {
    years.push(year)
  }

  return years
}

function decodeXml(value: string | undefined) {
  return (value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function textBetween(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"))
  return decodeXml(match?.[1])
}

function blocksBetween(xml: string, tagName: string) {
  return Array.from(
    xml.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi")),
    (match) => match[1],
  )
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`)
    }

    return response
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson<T>(url: string) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
    },
  })

  return (await response.json()) as T
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/xml,text/xml,text/plain",
    },
  })

  return response.text()
}

async function fetchUpcomingHolidays() {
  const fromDate = formatHktDateKey()
  const toDate = addDaysToDateKey(fromDate, HOLIDAY_WINDOW_DAYS)
  const years = uniqueYearsBetween(fromDate, toDate)
  const items = []
  const requests = HOLIDAY_COUNTRIES.flatMap((country) =>
    years.map((year) => ({ country, year })),
  )
  const results = await Promise.allSettled(
    requests.map(({ country, year }) =>
      fetchJson<TallyfyHolidayResponse>(
        `https://tallyfy.com/national-holidays/api/${country.code}/${year}.json`,
      ).then((data) => ({ country, data })),
    ),
  )
  let successfulResponses = 0

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    successfulResponses += 1

    const { country, data } = result.value

    for (const holiday of data.holidays || []) {
      const holidayDate = holiday.observed_date || holiday.date
      if (!holidayDate || holidayDate < fromDate || holidayDate > toDate) continue

      items.push({
        countryCode: country.code,
        countryName: country.label,
        date: holidayDate,
        originalDate: holiday.date || holidayDate,
        name: holiday.name || holiday.local_name || "Public holiday",
        localName: holiday.local_name || null,
        observedDate: holiday.observed_date || null,
        isObservedShifted: Boolean(holiday.is_observed_shifted),
        daysUntil: daysBetweenDateKeys(fromDate, holidayDate),
      })
    }
  }

  if (!successfulResponses) {
    throw new Error("Holiday feed unavailable.")
  }

  items.sort((first, second) => {
    if (first.date !== second.date) return first.date.localeCompare(second.date)
    return first.countryName.localeCompare(second.countryName)
  })

  return {
    checkedAt: new Date().toISOString(),
    fromDate,
    toDate,
    windowDays: HOLIDAY_WINDOW_DAYS,
    items,
    error: null,
  }
}

function parseLatestTrackPoint(trackXml: string) {
  const pastInformation = blocksBetween(trackXml, "PastInformation")
  const latest = pastInformation[pastInformation.length - 1] || ""

  return {
    intensity: textBetween(latest, "Intensity") || null,
    maximumWind: textBetween(latest, "MaximumWind") || null,
    time: textBetween(latest, "Time") || null,
    latitude: textBetween(latest, "Latitude") || null,
    longitude: textBetween(latest, "Longitude") || null,
  }
}

async function fetchTyphoonInfo() {
  const [listXml, warningSummary] = await Promise.all([
    fetchText("https://www.hko.gov.hk/wxinfo/currwx/tc_list.xml"),
    fetchJson<WarningSummary>(
      "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en",
    ).catch((): WarningSummary => ({})),
  ])
  const stormBlocks = blocksBetween(listXml, "TropicalCyclone")
  const storms = await Promise.all(
    stormBlocks.slice(0, 5).map(async (stormBlock) => {
      const trackUrl = textBetween(stormBlock, "TropicalCycloneURL").replace("http://", "https://")
      let trackXml = ""

      try {
        trackXml = trackUrl ? await fetchText(trackUrl) : ""
      } catch {
        trackXml = ""
      }

      return {
        id: textBetween(stormBlock, "TropicalCycloneID"),
        name: textBetween(stormBlock, "TropicalCycloneEnglishName") || "Unnamed system",
        chineseName: textBetween(stormBlock, "TropicalCycloneChineseName") || null,
        bulletinTime: textBetween(trackXml, "BulletinTime") || null,
        trackUrl: trackUrl || null,
        latest: parseLatestTrackPoint(trackXml),
      }
    }),
  )
  const hkoWarning = warningSummary.WTCSGNL

  return {
    checkedAt: new Date().toISOString(),
    activeCount: storms.length,
    warning: hkoWarning
      ? {
          name: hkoWarning.name || "Tropical Cyclone Warning Signal",
          code: hkoWarning.code || "WTCSGNL",
          actionCode: hkoWarning.actionCode || null,
          issueTime: hkoWarning.issueTime || null,
          updateTime: hkoWarning.updateTime || null,
        }
      : null,
    storms,
    sourceRegion: "Western North Pacific and South China Sea",
    error: null,
  }
}

function fallbackHolidays(error: unknown) {
  const fromDate = formatHktDateKey()
  return {
    checkedAt: new Date().toISOString(),
    fromDate,
    toDate: addDaysToDateKey(fromDate, HOLIDAY_WINDOW_DAYS),
    windowDays: HOLIDAY_WINDOW_DAYS,
    items: [],
    error: error instanceof Error ? error.message : "Holiday feed unavailable.",
  }
}

function fallbackTyphoon(error: unknown) {
  return {
    checkedAt: new Date().toISOString(),
    activeCount: 0,
    warning: null,
    storms: [],
    sourceRegion: "Western North Pacific and South China Sea",
    error: error instanceof Error ? error.message : "Typhoon feed unavailable.",
  }
}

export async function GET() {
  try {
    await requireAdminSession()

    const [holidayResult, typhoonResult] = await Promise.allSettled([
      fetchUpcomingHolidays(),
      fetchTyphoonInfo(),
    ])

    return NextResponse.json({
      holidays:
        holidayResult.status === "fulfilled"
          ? holidayResult.value
          : fallbackHolidays(holidayResult.reason),
      typhoon:
        typhoonResult.status === "fulfilled"
          ? typhoonResult.value
          : fallbackTyphoon(typhoonResult.reason),
    })
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Dashboard data unavailable." },
      { status: 500 },
    )
  }
}
