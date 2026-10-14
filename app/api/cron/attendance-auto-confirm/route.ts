import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import {
  autoConfirmOverdueAttendance,
  getAttendanceServiceClient,
  loadAttendancePeopleForPeriod,
} from "@/lib/attendanceData"
import { requeryAttendanceMonthForAutoConfirmation } from "@/lib/attendanceSync"
import { previousMonthPeriod } from "@/lib/attendanceMonthEnd"
import { hasCyDingTalkAutoConfirmException } from "@/lib/attendanceAutoConfirmPolicy"

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
    // Keep CY's DingTalk requery separate. If a link is later added, a failed
    // requery may have persisted only part of the month, so withhold his
    // confirmation until a complete requery succeeds.
    const linkedPeople = (await loadAttendancePeopleForPeriod(service, period.year, period.month))
      .filter((person) => person.dingTalkUserId?.trim())
    const ordinaryPeople = linkedPeople
      .filter((person) => !hasCyDingTalkAutoConfirmException(person, period))
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const cyPeople = linkedPeople
      .filter((person) => hasCyDingTalkAutoConfirmException(person, period))
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const [ordinaryRequery, cyRequery] = await Promise.allSettled([
      requeryAttendanceMonthForAutoConfirmation({
        ...period, people: ordinaryPeople, now, supabase: service, signal: AbortSignal.timeout(45_000),
      }),
      requeryAttendanceMonthForAutoConfirmation({
        ...period, people: cyPeople, now, supabase: service, signal: AbortSignal.timeout(45_000),
      }),
    ])
    if (cyRequery.status === "rejected") {
      console.error("CY attendance exception requery failed", cyRequery.reason)
    }

    // CY is checked independently so another employee's DingTalk failure or
    // missing identity cannot prevent his authorized system confirmation.
    const cyRequeryFailed = cyPeople.length > 0 && cyRequery.status === "rejected"
    let cySystemConfirmed = 0
    let cyConfirmationError: unknown = null
    if (!cyRequeryFailed) {
      try {
        cySystemConfirmed = (await autoConfirmOverdueAttendance(
          service, now, undefined, "cyDingTalkException", cyPeople[0]?.dingtalkUserId ?? null,
        ))
          .systemConfirmed
      } catch (error) {
        cyConfirmationError = error
        console.error("CY attendance exception confirmation failed", error)
      }
    }
    if (ordinaryRequery.status === "rejected") throw ordinaryRequery.reason
    const result = await autoConfirmOverdueAttendance(service, now, undefined, "ordinary")
    if (cyRequeryFailed) throw new Error("CY DingTalk requery failed; system confirmation withheld.")
    if (cyConfirmationError !== null) throw cyConfirmationError
    return NextResponse.json({
      success: true, ...result, systemConfirmed: result.systemConfirmed + cySystemConfirmed,
      cySystemConfirmed,
      cyDingTalkRequery: cyPeople.length ? cyRequery.status : "not-linked",
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("Attendance auto-confirm failed", error)
    return NextResponse.json({ message: "Attendance auto-confirm failed." }, { status: 500 })
  }
}
