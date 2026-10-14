import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import {
  autoConfirmOverdueAttendance,
  getAttendanceServiceClient,
  loadAttendancePeopleForPeriod,
} from "@/lib/attendanceData"
import { requeryAttendanceMonthForAutoConfirmation } from "@/lib/attendanceSync"
import { previousMonthPeriod } from "@/lib/attendanceMonthEnd"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function isAuthorized(request: Request, secret: string) {
  const actual = Buffer.from(request.headers.get("authorization") || "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ message: "Attendance auto-confirm is not configured." }, { status: 503 })
  if (!isAuthorized(request, secret)) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  try {
    const service = getAttendanceServiceClient()
    const now = new Date()
    const period = previousMonthPeriod(now)
    // Recheck the entire closed month for every linked person, including
    // already-confirmed staff. A later DingTalk correction must reopen their
    // record even when there is nobody left for this cron to auto-confirm.
    const people = (await loadAttendancePeopleForPeriod(service, period.year, period.month))
      .filter((person) => person.dingTalkUserId?.trim())
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const syncSignal = AbortSignal.timeout(45_000)
    await requeryAttendanceMonthForAutoConfirmation({
      ...period, people, now: new Date(), supabase: service, signal: syncSignal,
    })
    const result = await autoConfirmOverdueAttendance(service, new Date())
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("Attendance auto-confirm failed", error)
    return NextResponse.json({ message: "Attendance auto-confirm failed." }, { status: 500 })
  }
}
