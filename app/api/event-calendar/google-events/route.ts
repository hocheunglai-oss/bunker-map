import fs from "fs"
import path from "path"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { google } from "googleapis"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const TOKEN_PATH = path.join(process.cwd(), ".google-calendar-oauth-token.json")
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"
const TIME_ZONE = "Asia/Hong_Kong"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

async function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )

  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN

  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else {
    const tokenRaw = fs.readFileSync(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(tokenRaw))
  }

  return google.calendar({ version: "v3", auth })
}

function toDateInput(value: Date) {
  return value.toISOString().slice(0, 10)
}

function parseGoogleEventDate(value: { date?: string | null; dateTime?: string | null } | undefined) {
  if (!value?.dateTime && !value?.date) return { date: "", time: "" }

  if (value.dateTime) {
    const date = new Date(value.dateTime)
    const dateText = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
    const timeText = new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date)

    return { date: dateText, time: timeText }
  }

  return { date: value.date || "", time: "" }
}

export async function GET(request: Request) {
  const cookieStore = await cookies()

  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Admin login required." }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const calendarId = searchParams.get("calendarId")?.trim() || process.env.GOOGLE_MEETING_CALENDAR_ID || DEFAULT_CALENDAR_ID
  const now = new Date()
  const defaultTimeMin = new Date(now)
  defaultTimeMin.setDate(defaultTimeMin.getDate() - 14)
  const defaultTimeMax = new Date(now)
  defaultTimeMax.setDate(defaultTimeMax.getDate() + 180)

  try {
    const calendar = await getCalendarClient()
    const response = await calendar.events.list({
      calendarId,
      timeMin: searchParams.get("timeMin") || `${toDateInput(defaultTimeMin)}T00:00:00+08:00`,
      timeMax: searchParams.get("timeMax") || `${toDateInput(defaultTimeMax)}T23:59:59+08:00`,
      maxResults: 250,
      singleEvents: true,
      orderBy: "startTime",
    })

    const events = (response.data.items || []).map((event) => {
      const start = parseGoogleEventDate(event.start)
      const end = parseGoogleEventDate(event.end)

      return {
        id: event.id || "",
        calendarId,
        title: event.summary || "(NO TITLE)",
        startDate: start.date,
        endDate: end.date || start.date,
        startTime: start.time,
        endTime: end.time,
        location: event.location || "",
      }
    })

    return NextResponse.json({ success: true, calendarId, events })
  } catch (error) {
    const missingToken =
      error instanceof Error && error.message.includes(".google-calendar-oauth-token.json")

    return NextResponse.json(
      {
        message: missingToken
          ? "Google Calendar is not authorized. Run npm run auth:google-calendar first."
          : error instanceof Error
            ? error.message
            : "Google Calendar import failed.",
      },
      { status: 500 }
    )
  }
}
