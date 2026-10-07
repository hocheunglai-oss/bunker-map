import { NextResponse } from "next/server"
import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { buildChangedEventsEmail } from "@/lib/eventCalendarEmail"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getEventCalendarRecordVersion } from "@/lib/eventCalendarStore"
import { createCalendarServiceClient } from "@/lib/calendarServiceClient"
import { resolveEventCalendarRecipients } from "@/lib/calendarRecipients"
import { deliverCalendarReminder } from "@/lib/calendarDelivery"
import { getHongKongDateKey } from "@/lib/eventCalendarDates"

function isOfficeCalendarEvent(value: unknown): value is OfficeCalendarEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<OfficeCalendarEvent>
  return typeof event.id === "string" && typeof event.startDate === "string" && typeof event.endDate === "string" && typeof event.title === "string" && Array.isArray(event.people) && Array.isArray(event.tags)
}

async function loadCanonicalCalendar() {
  const { data, error } = await createCalendarServiceClient().from("office_calendar_store").select("payload").eq("key", "event-calendar").maybeSingle()
  if (error || !data?.payload || !Array.isArray(data.payload.events)) throw new Error("The saved Event Calendar is unavailable. No email was sent.")
  return data.payload as Record<string, unknown> & { events: OfficeCalendarEvent[] }
}

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    if (!body || !["created", "updated"].includes(body.action)) return NextResponse.json({ message: "Select a valid email action." }, { status: 400 })
    const requested: unknown[] = Array.isArray(body.events) ? body.events : [body.event]
    if (!requested.length || requested.length > 100 || !requested.every(isOfficeCalendarEvent) || new Set(requested.map((event) => event.id)).size !== requested.length) {
      return NextResponse.json({ message: "Supply between 1 and 100 distinct saved events." }, { status: 400 })
    }
    const requestedEvents = requested as OfficeCalendarEvent[]
    const canonical = await loadCanonicalCalendar()
    const versions = new Map<string, string>()
    for (const requestedEvent of requestedEvents) {
      const event = canonical.events.find((candidate) => candidate.id === requestedEvent.id)
      const requestedVersion = body.eventVersions?.[requestedEvent.id] || body.eventVersion || getEventCalendarRecordVersion(requestedEvent)
      if (!event || getEventCalendarRecordVersion(event) !== requestedVersion) {
        return NextResponse.json({ message: "An event changed or was deleted after this email question opened. No email was sent; reopen the event first." }, { status: 409 })
      }
      versions.set(event.id, requestedVersion)
    }
    // Re-read immediately before submitting: never knowingly send stale content.
    const latest = await loadCanonicalCalendar()
    const events: OfficeCalendarEvent[] = []
    for (const [id, version] of versions) {
      const event = latest.events.find((candidate) => candidate.id === id)
      if (!event || getEventCalendarRecordVersion(event) !== version) return NextResponse.json({ message: "An event changed while its email was being prepared. No email was sent." }, { status: 409 })
      events.push(event)
    }
    let recipients: string[]
    try { recipients = resolveEventCalendarRecipients(latest, process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS) } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "Check the event update email list." }, { status: 400 })
    }
    if (!recipients.length) return NextResponse.json({ message: "Event update emails are disabled because the email list is empty. Add recipients in Settings to send updates." }, { status: 400 })
    const identity = [...versions].sort(([a], [b]) => a.localeCompare(b))
    const email = buildChangedEventsEmail(events, body.action)
    const result = await deliverCalendarReminder({
      kind: "event-change", occurrenceDate: getHongKongDateKey(),
      recordId: getEventCalendarRecordVersion(identity.map(([id]) => id)),
      recordVersion: getEventCalendarRecordVersion(identity),
      to: recipients, ...email,
    })
    return NextResponse.json({ success: result.status !== "in_progress", ...result }, { status: result.status === "in_progress" ? 202 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email notification failed."
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : error instanceof SyntaxError ? 400 : 500 })
  }
}
