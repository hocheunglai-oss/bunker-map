import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const EVENT_CALENDAR_URL = "https://fcuno.com/admin/eventcalendar"
const TIME_ZONE = "Asia/Hong_Kong"
const IS_TEST_REMINDER = true

function hasAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

function formatHongKongDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "2-digit",
    weekday: "short",
  }).format(date)
}

function buildLinkReminderEmail() {
  const dateText = formatHongKongDate()

  return {
    subject: `${IS_TEST_REMINDER ? "[TEST] " : ""}FC Event Calendar - ${dateText}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.5">
        <h2 style="margin:0 0 12px">${IS_TEST_REMINDER ? "FC Event Calendar Test" : "FC Event Calendar"}</h2>
        <p style="margin:0 0 16px">
          ${IS_TEST_REMINDER ? "This is a test email for the daily event calendar reminder." : "Please check today&apos;s event calendar."}
        </p>
        <p style="margin:0 0 18px">
          <a href="${EVENT_CALENDAR_URL}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#0a73c9;color:#ffffff;text-decoration:none;font-weight:700">
            Open Event Calendar
          </a>
        </p>
        <p style="margin:0;color:#5f7384">
          ${EVENT_CALENDAR_URL}
        </p>
      </div>
    `,
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
