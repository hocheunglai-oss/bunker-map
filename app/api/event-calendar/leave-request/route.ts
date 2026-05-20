import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { sendCalendarEmail } from "@/lib/eventCalendarEmail"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const LEAVE_TO = ["stanley@cosulich.com.hk", "vincent@cosulich.com.hk", "louisa@cosulich.com.hk"]
const LEAVE_CC = ["otto@cosulich.com.hk", "kelvin@cosulich.com.hk"]
const PEOPLE_EMAILS: Record<string, string> = {
  VL: "vincent@cosulich.com.hk",
  SC: "stanley@cosulich.com.hk",
  OL: "otto@cosulich.com.hk",
  KZ: "kelvin@cosulich.com.hk",
  CY: "chengyuan@cosulich.com.hk",
  MY: "mayshen@cosulich.com.hk",
  DT: "diana@cosulich.com.hk",
  LC: "laureen@cosulich.com.hk",
  LL: "louisa@cosulich.com.hk",
}

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
  const cookieStore = await cookies()

  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    return NextResponse.json({ message: "Admin login required." }, { status: 401 })
  }

  const body = await request.json()
  const from = typeof body.from === "string" ? body.from : ""
  const to = typeof body.to === "string" ? body.to : from
  const type = typeof body.type === "string" ? body.type : ""
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  const person = typeof body.person === "string" ? body.person.toUpperCase() : ""
  const applicantEmail = PEOPLE_EMAILS[person]
  const recipients = normalizeRecipients([...LEAVE_TO, ...(applicantEmail ? [applicantEmail] : [])])

  if (!from || !to || !type || !person) {
    return NextResponse.json({ message: "Leave request is incomplete." }, { status: 400 })
  }

  try {
    await sendCalendarEmail({
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

    return NextResponse.json({ success: true, sent: recipients.length })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Leave request email failed." },
      { status: 500 }
    )
  }
}
