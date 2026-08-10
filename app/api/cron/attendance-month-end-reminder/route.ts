import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import {
  getAttendanceServiceClient,
  sendAttendanceMonthEndReviewReminders,
  sendAttendanceSecondReminders,
} from "@/lib/attendanceData"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...PRIVATE_HEADERS, ...init.headers },
  })
}

function isAuthorized(request: Request, secret: string) {
  const actual = Buffer.from(request.headers.get("authorization") || "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error("Attendance month-end reminder is missing CRON_SECRET.")
    return privateJson({ message: "Attendance month-end reminder is not configured." }, { status: 503 })
  }
  if (!isAuthorized(request, cronSecret)) {
    return privateJson({ message: "Unauthorized" }, { status: 401 })
  }

  try {
    const client = getAttendanceServiceClient()
    const [monthEndReview, secondReminder] = await Promise.all([
      sendAttendanceMonthEndReviewReminders(client),
      sendAttendanceSecondReminders(client),
    ])
    const failed = monthEndReview.failed + secondReminder.failed
    return privateJson({ success: failed === 0, monthEndReview, secondReminder }, {
      status: failed > 0 ? 502 : 200,
    })
  } catch (error) {
    console.error("Attendance month-end reminder failed", error)
    return privateJson({ message: "Attendance month-end reminder failed." }, { status: 500 })
  }
}
