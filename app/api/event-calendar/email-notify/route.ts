import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { OfficeCalendarEvent } from "@/data/eventCalendar"
import {
  buildChangedEventEmail,
  normalizeEmailList,
  sendCalendarEmail,
} from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"

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
  const cookieStore = await cookies()

  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Admin login required." }, { status: 401 })
  }

  const body = await request.json()
  const action = body.action === "updated" ? "updated" : "created"
  const recipients = normalizeEmailList(body.recipients)

  if (!isOfficeCalendarEvent(body.event)) {
    return NextResponse.json({ message: "No valid event supplied." }, { status: 400 })
  }

  if (!recipients.length) {
    return NextResponse.json({ message: "No valid email recipients supplied." }, { status: 400 })
  }

  try {
    const email = buildChangedEventEmail(body.event, action)
    await sendCalendarEmail({
      to: recipients,
      subject: email.subject,
      html: email.html,
    })

    return NextResponse.json({ success: true, sent: recipients.length })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Email notification failed." },
      { status: 500 }
    )
  }
}
