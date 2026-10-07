import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadCalendarStaffDirectory, resolveCalendarStaffRecipients } from "@/lib/calendarStaff"
import { deliverCalendarReminder } from "@/lib/calendarDelivery"
import { getHongKongDateKey, isValidCalendarDate } from "@/lib/eventCalendarDates"
import { getEventCalendarRecordVersion } from "@/lib/eventCalendarStore"

const LEAVE_TO = ["stanley@cosulich.com.hk", "vincent@cosulich.com.hk", "louisa@cosulich.com.hk"]
const LEAVE_CC = ["otto@cosulich.com.hk", "kelvin@cosulich.com.hk"]
const LEAVE_TYPES = new Set(["Annual Leave", "Sick Leave Notification (for medical treatment)", "Compassionate Leave"])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function normalizeRecipients(value: string[]) {
  return Array.from(new Set(value.filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))))
}

export async function POST(request: Request) {
  try {
    await requireAdminPagePermission("event-calendar", "edit")
    const body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ message: "Supply a valid leave request." }, { status: 400 })
    }
    const from = typeof body.from === "string" ? body.from : ""
    const to = typeof body.to === "string" ? body.to : from
    const type = typeof body.type === "string" ? body.type : ""
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    const person = typeof body.person === "string" ? body.person.trim().toUpperCase() : ""

    if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to < from || !LEAVE_TYPES.has(type) || !person || person.length > 40 || reason.length > 5000) {
      return NextResponse.json({ message: "Check the applicant, leave type and dates. The end date must not be before the start date." }, { status: 400 })
    }
    const staff = await loadCalendarStaffDirectory()
    const applicant = resolveCalendarStaffRecipients([person], staff)
    if (applicant.unresolved.length) return NextResponse.json({ message: "The applicant has no unique active email address. Please check User Management before sending." }, { status: 400 })
    const recipients = normalizeRecipients([...LEAVE_TO, ...applicant.recipients])

    const delivery = await deliverCalendarReminder({
      kind: "leave", occurrenceDate: getHongKongDateKey(),
      recordId: getEventCalendarRecordVersion({ from, to, type, reason, person }),
      to: recipients,
      cc: LEAVE_CC,
      subject: "***** Leave Request",
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
          <p style="margin:0 0 8px"><strong>Leave Period</strong><br />${escapeHtml(from)} - ${escapeHtml(to)}</p>
          <p style="margin:0 0 8px"><strong>Leave Type</strong><br />${escapeHtml(type)}</p>
          <p style="margin:0 0 8px"><strong>Applicant</strong><br />${escapeHtml(person)}</p>
          <p style="margin:0"><strong>Reason (Non compulsory)</strong><br />${escapeHtml(reason || "-")}</p>
        </div>
      `,
    })

    return NextResponse.json({ success: delivery.status !== "in_progress", ...delivery }, { status: delivery.status === "in_progress" ? 202 : 200 })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Leave request email failed." },
      { status: error instanceof SyntaxError ? 400 : 500 }
    )
  }
}
