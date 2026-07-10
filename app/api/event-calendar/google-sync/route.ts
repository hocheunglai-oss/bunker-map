import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadGoogleApis } from "@/lib/googleApis"

const TOKEN_PATH = path.join(process.cwd(), ".google-calendar-oauth-token.json")
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"
const TIME_ZONE = "Asia/Hong_Kong"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function isOfficeCalendarEvent(value: unknown): value is OfficeCalendarEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<OfficeCalendarEvent>

  return (
    typeof event.id === "string" &&
    typeof event.startDate === "string" &&
    typeof event.endDate === "string" &&
    typeof event.title === "string" &&
    Array.isArray(event.people) &&
    Array.isArray(event.tags)
  )
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function extractTimeRange(title: string) {
  const match = title.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d))?\b/)
  if (!match) return null

  return {
    start: `${match[1].padStart(2, "0")}:${match[2]}`,
    end: match[3] && match[4] ? `${match[3].padStart(2, "0")}:${match[4]}` : null,
    raw: match[0],
  }
}

function addOneHour(timeText: string) {
  const [hour, minute] = timeText.split(":").map(Number)
  const next = new Date(Date.UTC(2026, 0, 1, hour, minute))
  next.setUTCHours(next.getUTCHours() + 1)
  return `${String(next.getUTCHours()).padStart(2, "0")}:${String(next.getUTCMinutes()).padStart(2, "0")}`
}

function buildGoogleEvent(event: OfficeCalendarEvent) {
  const time = event.startDate === event.endDate ? extractTimeRange(event.title) : null
  const summary = "MARINE ENERGY"
  const description = [
    "Imported from Bunker Map Office Tools.",
    `Original event: ${event.title}`,
    event.people.length ? `People: ${event.people.join(", ")}` : "",
    event.tags.length ? `Tags: ${event.tags.join(", ")}` : "",
    event.sourceRow ? `Excel source row: ${event.sourceRow}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  if (time) {
    return {
      summary,
      description,
      start: {
        dateTime: `${event.startDate}T${time.start}:00`,
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: `${event.endDate}T${time.end || addOneHour(time.start)}:00`,
        timeZone: TIME_ZONE,
      },
      extendedProperties: {
        private: {
          bunkerMapEventId: event.id,
        },
      },
    }
  }

  return {
    summary,
    description,
    start: {
      date: event.startDate,
    },
    end: {
      date: addDays(event.endDate, 1),
    },
    extendedProperties: {
      private: {
        bunkerMapEventId: event.id,
      },
    },
  }
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

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    const events: OfficeCalendarEvent[] = Array.isArray(body.events) ? body.events.filter(isOfficeCalendarEvent) : []
    const activeEventIdValues: unknown[] = Array.isArray(body.activeEventIds) ? body.activeEventIds : events.map((event) => event.id)
    const activeEventIds = new Set(
      activeEventIdValues
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim())
    )
    const calendarId =
      typeof body.calendarId === "string" && body.calendarId.trim()
        ? body.calendarId.trim()
        : process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
    const calendar = await getCalendarClient()
    let inserted = 0
    let updated = 0
    let deleted = 0
    const failed: Array<{ id: string; title: string; message: string }> = []

    for (const event of events) {
      try {
        const resource = buildGoogleEvent(event)
        const existing = await calendar.events.list({
          calendarId,
          privateExtendedProperty: [`bunkerMapEventId=${event.id}`],
          maxResults: 1,
          singleEvents: true,
        })
        const existingId = existing.data.items?.[0]?.id

        if (existingId) {
          await calendar.events.update({
            calendarId,
            eventId: existingId,
            requestBody: resource,
          })
          updated += 1
        } else {
          await calendar.events.insert({
            calendarId,
            requestBody: resource,
          })
          inserted += 1
        }
      } catch (error) {
        failed.push({
          id: event.id,
          title: event.title,
          message: error instanceof Error ? error.message : "Unknown Google Calendar error.",
        })
      }
    }

    try {
      const managedEvents = await calendar.events.list({
        calendarId,
        timeMin: `${addDays(new Date().toISOString().slice(0, 10), -30)}T00:00:00+08:00`,
        timeMax: `${addDays(new Date().toISOString().slice(0, 10), 365)}T23:59:59+08:00`,
        maxResults: 2500,
        singleEvents: true,
      })

      for (const googleEvent of managedEvents.data.items || []) {
        const sourceEventId = googleEvent.extendedProperties?.private?.bunkerMapEventId
        if (!sourceEventId || activeEventIds.has(sourceEventId) || !googleEvent.id) continue

        await calendar.events.delete({
          calendarId,
          eventId: googleEvent.id,
        })
        deleted += 1
      }
    } catch (error) {
      failed.push({
        id: "google-calendar-reconcile",
        title: "Meeting room cleanup",
        message: error instanceof Error ? error.message : "Unknown Google Calendar cleanup error.",
      })
    }

    return NextResponse.json({
      success: failed.length === 0,
      calendarId,
      inserted,
      updated,
      deleted,
      failed,
    })
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
            : "Google Calendar sync failed.",
      },
      { status: 500 }
    )
  }
}
