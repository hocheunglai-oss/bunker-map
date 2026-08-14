import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  buildChangedEventEmail,
  normalizeEmailList,
  sendCalendarEmail,
} from "@/lib/eventCalendarEmail"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getEventCalendarRecordVersion } from "@/lib/eventCalendarStore"


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

async function loadCanonicalEvent(eventId: string) {
  const { data, error } = await getSupabaseClient()
    .from("office_calendar_store")
    .select("payload")
    .eq("key", "event-calendar")
    .maybeSingle()
  if (error) throw error

  const payload = data?.payload
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.events)) {
    throw new Error("The canonical Event Calendar is unavailable. No email was sent.")
  }
  const event = payload.events.find((candidate: unknown) => isOfficeCalendarEvent(candidate) && candidate.id === eventId)
  return { event: event || null, payload }
}

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    const action = body.action === "updated" ? "updated" : "created"

    if (!isOfficeCalendarEvent(body.event)) {
      return NextResponse.json({ message: "No valid event supplied." }, { status: 400 })
    }

    const canonical = await loadCanonicalEvent(body.event.id)
    if (!canonical.event) {
      return NextResponse.json({
        message: "This event is not present in the saved FCUNO calendar. No email was sent; refresh the calendar and try again.",
      }, { status: 409 })
    }
    const canonicalVersion = getEventCalendarRecordVersion(canonical.event)
    const requestedVersion = typeof body.eventVersion === "string" ? body.eventVersion.trim() : ""
    const requestMatchesCanonical = getEventCalendarRecordVersion(body.event) === canonicalVersion
    if ((requestedVersion && requestedVersion !== canonicalVersion) || (!requestedVersion && !requestMatchesCanonical)) {
      return NextResponse.json({
        message: "This event changed after the notification prompt opened. No email was sent; reopen the event before notifying recipients.",
      }, { status: 409 })
    }

    // Re-read immediately before SMTP so a delayed request cannot knowingly
    // send an event version or recipient list that has already been replaced.
    const latest = await loadCanonicalEvent(body.event.id)
    if (!latest.event || getEventCalendarRecordVersion(latest.event) !== canonicalVersion) {
      return NextResponse.json({
        message: "This event changed while the notification was being prepared. No email was sent; reopen the event before notifying recipients.",
      }, { status: 409 })
    }

    const savedRecipients = normalizeEmailList(
      latest.payload.emailRecipientsText,
    )
    const recipients = savedRecipients.length
      ? savedRecipients
      : normalizeEmailList(process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS)

    if (!recipients.length) {
      return NextResponse.json({ message: "No valid email recipients supplied." }, { status: 400 })
    }

    const email = buildChangedEventEmail(latest.event, action)
    await sendCalendarEmail({
      to: recipients,
      subject: email.subject,
      html: email.html,
    })

    return NextResponse.json({ success: true, sent: recipients.length })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Email notification failed." },
      { status: 500 }
    )
  }
}
