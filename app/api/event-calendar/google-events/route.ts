import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadGoogleApis } from "@/lib/googleApis"
import { addCalendarDays, getHongKongDateKey, calendarDateTimestamp } from "@/lib/eventCalendarDates"
import { collectCalendarPages, normalizeMeetingRoomGoogleEvent } from "@/lib/eventCalendarMeeting"

const TOKEN_PATH = path.join(process.cwd(), ".google-calendar-oauth-token.json")
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

async function getCalendarClient() {
  const { google } = await loadGoogleApis()
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1"
  )

  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN

  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken })
  } else if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("Google Calendar is not authorized on the hosted app yet. Add GOOGLE_CALENDAR_REFRESH_TOKEN in Vercel.")
  } else {
    const tokenRaw = fs.readFileSync(TOKEN_PATH, "utf8")
    auth.setCredentials(JSON.parse(tokenRaw))
  }

  return google.calendar({ version: "v3", auth })
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "view")
    const { searchParams } = new URL(request.url)
    // Use the same server-owned destination as the sync worker. A browser may
    // choose a time window, but it cannot redirect reads to another calendar.
    const calendarId = process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
    const today = getHongKongDateKey()
    const timeMin = searchParams.get("timeMin") || new Date(calendarDateTimestamp(today)).toISOString()
    const timeMax = searchParams.get("timeMax") || new Date(calendarDateTimestamp(addCalendarDays(today, 181))).toISOString()
    if (!Number.isFinite(Date.parse(timeMin)) || !Number.isFinite(Date.parse(timeMax)) || Date.parse(timeMax) <= Date.parse(timeMin)) {
      return NextResponse.json({ message: "Choose a valid meeting room date range." }, { status: 400 })
    }
    const calendar = await getCalendarClient()
    const records = await collectCalendarPages(async (pageToken) => {
      const response = await calendar.events.list({
        calendarId, timeMin, timeMax, pageToken, maxResults: 2500,
        singleEvents: true, orderBy: "startTime",
      })
      return response.data
    })
    const events = records.map((event) => normalizeMeetingRoomGoogleEvent(event, calendarId)).filter(Boolean)

    return NextResponse.json({ success: true, calendarId, events })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
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
