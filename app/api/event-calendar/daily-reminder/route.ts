import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
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
  const cookieStore = await cookies()

  if (!hasAccess(request) && cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 })
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
