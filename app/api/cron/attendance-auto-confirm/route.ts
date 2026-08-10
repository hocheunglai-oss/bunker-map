import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { autoConfirmOverdueAttendance, getAttendanceServiceClient } from "@/lib/attendanceData"

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
    const result = await autoConfirmOverdueAttendance(getAttendanceServiceClient())
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("Attendance auto-confirm failed", error)
    return NextResponse.json({ message: "Attendance auto-confirm failed." }, { status: 500 })
  }
}
