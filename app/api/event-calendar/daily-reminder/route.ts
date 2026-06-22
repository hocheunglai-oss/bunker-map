import { NextResponse } from "next/server"
import { normalizeEmailList, sendCalendarEmail } from "@/lib/eventCalendarEmail"
import { requireAdminPagePermission } from "@/lib/adminAuth"

const EVENT_CALENDAR_URL = "https://fcuno.com/admin/eventcalendar"
const HONG_KONG_TIME_ZONE = "Asia/Hong_Kong"
const HONG_KONG_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: HONG_KONG_TIME_ZONE,
})

function hasAccess(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  return false
}

function getHongKongWeekday(date = new Date()) {
  return HONG_KONG_WEEKDAY_FORMATTER.format(date)
}

function isHongKongWeekday(date = new Date()) {
  const weekday = getHongKongWeekday(date)
  return weekday !== "Sat" && weekday !== "Sun"
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

  if (!isHongKongWeekday()) {
    return NextResponse.json({
      success: true,
      skipped: true,
      message: "Event reminder is weekdays only.",
      hongKongWeekday: getHongKongWeekday(),
    })
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
