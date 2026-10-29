import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import {
  autoConfirmOverdueAttendance,
  getAttendanceServiceClient,
  loadAttendancePeopleForPeriod,
} from "@/lib/attendanceData"
import { requeryAttendanceMonthForAutoConfirmation } from "@/lib/attendanceSync"
import { previousMonthPeriod } from "@/lib/attendanceMonthEnd"
import { hasCyDingTalkAutoConfirmException, hasJzDingTalkAutoConfirmException } from "@/lib/attendanceAutoConfirmPolicy"
import { hasManualEntryOnlyAttendancePolicyForPeriod } from "@/lib/attendanceManualEntryPolicy"

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
    // Keep each approved exception's DingTalk requery separate. A failed
    // requery after a link is added may persist only part of the month, so
    // withhold that person's confirmation until a complete requery succeeds.
    const periodPeople = await loadAttendancePeopleForPeriod(service, period.year, period.month)
    const linkedPeople = periodPeople
      .filter((person) => person.dingTalkUserId?.trim())
    const ordinaryPeople = linkedPeople
      .filter((person) => !hasManualEntryOnlyAttendancePolicyForPeriod(person, period))
      .filter((person) => !hasCyDingTalkAutoConfirmException(person, period))
      .filter((person) => !hasJzDingTalkAutoConfirmException(person, period))
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const cyPeople = linkedPeople
      .filter((person) => hasCyDingTalkAutoConfirmException(person, period))
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const jzEligible = periodPeople.some((person) => hasJzDingTalkAutoConfirmException(person, period))
    const jzPeople = linkedPeople
      .filter((person) => hasJzDingTalkAutoConfirmException(person, period))
      .map((person) => ({ id: person.id, dingtalkUserId: person.dingTalkUserId!.trim() }))
    const [ordinaryRequery, cyRequery, jzRequery] = await Promise.allSettled([
      requeryAttendanceMonthForAutoConfirmation({
        ...period, people: ordinaryPeople, now, supabase: service, signal: AbortSignal.timeout(45_000),
      }),
      requeryAttendanceMonthForAutoConfirmation({
        ...period, people: cyPeople, now, supabase: service, signal: AbortSignal.timeout(45_000),
      }),
      jzPeople.length ? requeryAttendanceMonthForAutoConfirmation({
        ...period, people: jzPeople, now, supabase: service, signal: AbortSignal.timeout(45_000),
      }) : Promise.resolve(),
    ])
    if (cyRequery.status === "rejected") {
      console.error("CY attendance exception requery failed", cyRequery.reason)
    }
    if (jzRequery.status === "rejected") {
      console.error("JZ attendance exception requery failed", jzRequery.reason)
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
    // A JZ failure cannot suppress CY/ordinary processing, and their failures
    // cannot suppress JZ's independently guarded, owner-authorized path.
    const jzRequeryFailed = jzPeople.length > 0 && jzRequery.status === "rejected"
    let jzSystemConfirmed = 0
    let jzConfirmationError: unknown = null
    if (jzEligible && !jzRequeryFailed) {
      try {
        jzSystemConfirmed = (await autoConfirmOverdueAttendance(
          service, now, undefined, "jzDingTalkException", jzPeople[0]?.dingtalkUserId ?? null,
        )).systemConfirmed
      } catch (error) {
        jzConfirmationError = error
        console.error("JZ attendance exception confirmation failed", error)
      }
    }
    if (ordinaryRequery.status === "rejected") throw ordinaryRequery.reason
    const result = await autoConfirmOverdueAttendance(service, now, undefined, "ordinary")
    if (cyRequeryFailed) throw new Error("CY DingTalk requery failed; system confirmation withheld.")
    if (cyConfirmationError !== null) throw cyConfirmationError
    if (jzRequeryFailed) throw new Error("JZ DingTalk requery failed; system confirmation withheld.")
    if (jzConfirmationError !== null) throw jzConfirmationError
    return NextResponse.json({
      success: true, ...result, systemConfirmed: result.systemConfirmed + cySystemConfirmed + jzSystemConfirmed,
      cySystemConfirmed,
      cyDingTalkRequery: cyPeople.length ? cyRequery.status : "not-linked",
      jzSystemConfirmed,
      jzDingTalkRequery: jzPeople.length ? jzRequery.status : "not-linked",
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("Attendance auto-confirm failed", error)
    return NextResponse.json({ message: "Attendance auto-confirm failed." }, { status: 500 })
  }
}
