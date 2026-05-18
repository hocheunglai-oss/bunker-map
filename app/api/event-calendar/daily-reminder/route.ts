import fs from "fs"
import path from "path"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { google } from "googleapis"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  buildDailyReminderEmail,
  normalizeEmailList,
  sendCalendarEmail,
} from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const DEFAULT_CALENDAR_ID = "cosulich.uno@gmail.com"
const TIME_ZONE = "Asia/Hong_Kong"
const TOKEN_PATH = path.join(process.cwd(), ".google-calendar-oauth-token.json")

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function getHongKongDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return `${year}-${month}-${day}`
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function extractPeople(description: string | null | undefined) {
  const match = description?.match(/^People:\s*(.+)$/im)
  return match?.[1]
    ? match[1]
        .split(",")
        .map((person) => person.trim())
        .filter(Boolean)
    : []
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

function hasAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

export async function GET(request: Request) {
  const cookieStore = await cookies()

  if (!hasAccess(request) && cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
  const dateText = getHongKongDateKey()
  const recipients = normalizeEmailList(process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS)

  if (!recipients.length) {
    return NextResponse.json({ message: "EVENT_CALENDAR_EMAIL_RECIPIENTS is not configured." }, { status: 500 })
  }

  try {
    const calendar = await getCalendarClient()
    const response = await calendar.events.list({
      calendarId,
      timeMin: `${dateText}T00:00:00+08:00`,
      timeMax: `${addDays(dateText, 1)}T00:00:00+08:00`,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    })

    const events: OfficeCalendarEvent[] = (response.data.items || []).map((item, index) => {
      const startDate = item.start?.date || item.start?.dateTime?.slice(0, 10) || dateText
      const endDate = item.end?.date
        ? addDays(item.end.date, -1)
        : item.end?.dateTime?.slice(0, 10) || startDate

      return {
        id: item.id || `google-event-${index}`,
        startDate,
        endDate: endDate < startDate ? startDate : endDate,
        title: item.summary || "UNTITLED EVENT",
        people: extractPeople(item.description),
        tags: [],
      }
    })

    const email = buildDailyReminderEmail(events, dateText)
    await sendCalendarEmail({
      to: recipients,
      subject: email.subject,
      html: email.html,
    })

    return NextResponse.json({ success: true, sent: recipients.length, events: events.length })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Daily reminder failed." },
      { status: 500 }
    )
  }
}
