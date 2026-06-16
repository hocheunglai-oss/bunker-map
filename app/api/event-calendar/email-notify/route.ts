import { NextResponse } from "next/server"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  buildChangedEventEmail,
  normalizeEmailList,
  sendCalendarEmail,
} from "@/lib/eventCalendarEmail"
import { requireAdminPagePermission } from "@/lib/adminAuth"


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

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    const action = body.action === "updated" ? "updated" : "created"
    const requestRecipients = normalizeEmailList(body.recipients)
    const recipients = requestRecipients.length
      ? requestRecipients
      : normalizeEmailList(process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS)

    if (!isOfficeCalendarEvent(body.event)) {
      return NextResponse.json({ message: "No valid event supplied." }, { status: 400 })
    }

    if (!recipients.length) {
      return NextResponse.json({ message: "No valid email recipients supplied." }, { status: 400 })
    }

    const email = buildChangedEventEmail(body.event, action)
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
