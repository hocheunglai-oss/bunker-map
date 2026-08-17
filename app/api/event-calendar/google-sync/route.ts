import fs from "fs"
import path from "path"
import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getEventCalendarRecordVersion } from "@/lib/eventCalendarStore"
import { loadGoogleApis } from "@/lib/googleApis"
import { isVerifiedBackupActive } from "@/lib/backupMaintenance"

const TOKEN_PATH = path.join(process.cwd(), ".google-calendar-oauth-token.json")
const DEFAULT_CALENDAR_ID = "fcb.bunker@gmail.com"
const TIME_ZONE = "Asia/Hong_Kong"
export const maxDuration = 60

type GoogleSyncJob = {
  event_id: string
  requested_at: string
  attempts: number
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function getSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  )
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

function isMeetingRoomEvent(event: OfficeCalendarEvent) {
  return event.eventType === "Meeting Room" || event.eventType === "Meeting"
}

type CanonicalGoogleState = {
  event: OfficeCalendarEvent | null
  signature: string
}

async function loadCanonicalGoogleState(eventId: string): Promise<CanonicalGoogleState> {
  const { data, error } = await getSupabaseClient()
    .from("office_calendar_store")
    .select("payload")
    .eq("key", "event-calendar")
    .maybeSingle()
  if (error) throw error

  const payload = data?.payload
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.events)) {
    throw new Error("The canonical Event Calendar is unavailable. Google Calendar was not changed.")
  }
  const event = payload.events.find(
    (candidate: unknown) => isOfficeCalendarEvent(candidate) && candidate.id === eventId,
  )
  const meetingEvent = event && isMeetingRoomEvent(event) ? event : null
  return {
    event: meetingEvent,
    signature: meetingEvent ? getEventCalendarRecordVersion(meetingEvent) : "absent",
  }
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
    const endTime = time.end || addOneHour(time.start)
    const timedEndDate = endTime <= time.start ? addDays(event.endDate, 1) : event.endDate
    return {
      summary,
      description,
      start: {
        dateTime: `${event.startDate}T${time.start}:00`,
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: `${timedEndDate}T${endTime}:00`,
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

async function listManagedGoogleEvents(
  calendar: Awaited<ReturnType<typeof getCalendarClient>>,
  calendarId: string,
  eventId: string,
) {
  const response = await calendar.events.list({
    calendarId,
    privateExtendedProperty: [`bunkerMapEventId=${eventId}`],
    maxResults: 250,
    singleEvents: true,
  })
  return (response.data.items || [])
    .filter((event) => Boolean(event.id))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

async function reconcileGoogleEvent(
  calendar: Awaited<ReturnType<typeof getCalendarClient>>,
  calendarId: string,
  eventId: string,
  event: OfficeCalendarEvent | null,
) {
  let inserted = 0
  let updated = 0
  let deleted = 0
  const existing = await listManagedGoogleEvents(calendar, calendarId, eventId)

  if (!event) {
    for (const googleEvent of existing) {
      await calendar.events.delete({ calendarId, eventId: googleEvent.id as string })
      deleted += 1
    }
    return { inserted, updated, deleted }
  }

  const resource = buildGoogleEvent(event)
  const keeperId = existing[0]?.id
  if (keeperId) {
    await calendar.events.update({ calendarId, eventId: keeperId, requestBody: resource })
    updated += 1
  } else {
    await calendar.events.insert({ calendarId, requestBody: resource })
    inserted += 1
  }

  // Two requests can both observe no Google event before either inserts. List
  // again after the write, keep one record, and remove all duplicate managed
  // rows. A final update makes the retained row match the canonical FCUNO event.
  const afterWrite = await listManagedGoogleEvents(calendar, calendarId, eventId)
  const retainedId = afterWrite[0]?.id
  for (const duplicate of afterWrite.slice(1)) {
    await calendar.events.delete({ calendarId, eventId: duplicate.id as string })
    deleted += 1
  }
  if (retainedId) {
    await calendar.events.update({ calendarId, eventId: retainedId, requestBody: resource })
    updated += 1
  }

  return { inserted, updated, deleted }
}

async function reconcileUntilCanonical(
  calendar: Awaited<ReturnType<typeof getCalendarClient>>,
  calendarId: string,
  eventId: string,
) {
  const totals = { inserted: 0, updated: 0, deleted: 0 }
  let lastError: unknown = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const before = await loadCanonicalGoogleState(eventId)
      const result = await reconcileGoogleEvent(calendar, calendarId, eventId, before.event)
      totals.inserted += result.inserted
      totals.updated += result.updated
      totals.deleted += result.deleted

      const after = await loadCanonicalGoogleState(eventId)
      if (after.signature === before.signature) return totals
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The FCUNO event kept changing during Google Calendar sync. Save or delete it again after the current edits finish.")
}

function normalizedEventIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean),
  ))
}

async function runQueuedGoogleSync(eventIds: string[] | null) {
  const supabase = getSupabaseClient()
  const workerId = `google-sync-${randomUUID()}`
  const { data, error } = await supabase.rpc("claim_event_calendar_google_sync_jobs", {
    p_event_ids: eventIds?.length ? eventIds : null,
    p_limit: 12,
    p_worker_id: workerId,
  })
  if (error) throw error

  const jobs = (Array.isArray(data) ? data : []).filter((job): job is GoogleSyncJob => (
    job &&
    typeof job === "object" &&
    typeof job.event_id === "string" &&
    typeof job.requested_at === "string" &&
    typeof job.attempts === "number"
  ))

  const calendarId = process.env.GOOGLE_CALENDAR_ID || DEFAULT_CALENDAR_ID
  const calendar = jobs.length ? await getCalendarClient() : null
  let inserted = 0
  let updated = 0
  let deleted = 0
  const failed: Array<{ id: string; title: string; message: string }> = []

  async function releaseSupersededGeneration(job: GoogleSyncJob) {
    await supabase
      .from("event_calendar_google_sync_jobs")
      .update({ locked_until: null, locked_by: null })
      .eq("event_id", job.event_id)
      .eq("locked_by", workerId)
  }

  for (const job of jobs) {
    try {
      const result = await reconcileUntilCanonical(calendar!, calendarId, job.event_id)
      inserted += result.inserted
      updated += result.updated
      deleted += result.deleted
      const { data: deletedJobs, error: deleteError } = await supabase
        .from("event_calendar_google_sync_jobs")
        .delete()
        .eq("event_id", job.event_id)
        .eq("requested_at", job.requested_at)
        .select("event_id")
      if (deleteError) throw deleteError
      if (!deletedJobs?.length) await releaseSupersededGeneration(job)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Google Calendar error."
      failed.push({ id: job.event_id, title: job.event_id, message })
      const attempts = job.attempts + 1
      const retrySeconds = Math.min(3600, 15 * (2 ** Math.min(attempts, 8)))
      const { data: failedJobs } = await supabase
        .from("event_calendar_google_sync_jobs")
        .update({
          attempts,
          next_attempt_at: new Date(Date.now() + retrySeconds * 1000).toISOString(),
          locked_until: null,
          locked_by: null,
          last_error: message.slice(0, 2000),
        })
        .eq("event_id", job.event_id)
        .eq("requested_at", job.requested_at)
        .select("event_id")
      if (!failedJobs?.length) await releaseSupersededGeneration(job)
    }
  }

  const { count: queued, error: countError } = await supabase
    .from("event_calendar_google_sync_jobs")
    .select("event_id", { count: "exact", head: true })
  if (countError) throw countError

  return {
    success: failed.length === 0,
    ...(failed.length ? {
      message: "Google Calendar sync is incomplete. The FCUNO event is saved and the failed meeting-room update is queued for automatic retry.",
    } : {}),
    calendarId,
    processed: jobs.length,
    queued: queued || 0,
    inserted,
    updated,
    deleted,
    failed,
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    const eventIds: string[] = normalizedEventIds(body.eventIds)
    if (!eventIds.length || eventIds.length > 500) {
      return NextResponse.json({
        message: "This Google sync request is outdated or invalid. No Google Calendar event was changed; refresh Event Calendar and try again.",
      }, { status: 409 })
    }

    return NextResponse.json(await runQueuedGoogleSync(eventIds))
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

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  try {
    if (await isVerifiedBackupActive()) {
      return NextResponse.json({
        success: true,
        deferred: true,
        reason: "Verified daily backup in progress",
      })
    }
    return NextResponse.json(await runQueuedGoogleSync(null))
  } catch (error) {
    return NextResponse.json({
      message: error instanceof Error ? error.message : "Google Calendar sync worker failed.",
    }, { status: 500 })
  }
}
