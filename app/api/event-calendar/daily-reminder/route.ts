import { NextResponse } from "next/server"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const EVENT_CALENDAR_URL = "https://fcuno.com/admin/eventcalendar"

function hasAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

function buildLinkReminderEmail() {
  return {
    subject: "***** Event Reminder (Today or Tomorrow)",
    html: `<a href="${EVENT_CALENDAR_URL}">${EVENT_CALENDAR_URL}</a>`,
  }
}

export async function GET(request: Request) {
  if (!hasAccess(request)) {
    try {
      await requireAdminPagePermission("event-calendar", "edit")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized"
      return NextResponse.json(
        { message },
        { status: message === "Unauthorized" ? 401 : 403 }
      )
    }
  }

  const recipients = normalizeEmailList(process.env.EVENT_CALENDAR_EMAIL_RECIPIENTS)

  if (!recipients.length) {
    return NextResponse.json({ message: "EVENT_CALENDAR_EMAIL_RECIPIENTS is not configured." }, { status: 500 })
  }

  try {
    const email = buildLinkReminderEmail()
    await sendCalendarEmail({
      to: recipients,
      subject: email.subject,
      html: email.html,
    })

    return NextResponse.json({ success: true, sent: recipients.length })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Daily reminder failed." },
      { status: 500 }
    )
  }
}
