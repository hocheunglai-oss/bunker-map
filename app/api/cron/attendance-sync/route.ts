import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { runAttendanceSync } from "@/lib/attendanceSync"
import { isVerifiedBackupActive } from "@/lib/backupMaintenance"

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
  const authorization = request.headers.get("authorization") || ""
  const expected = `Bearer ${secret}`
  const actualBytes = Buffer.from(authorization)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error("Attendance sync cron is missing CRON_SECRET.")
    return privateJson({ message: "Attendance sync is not configured." }, { status: 503 })
  }
  if (!isAuthorized(request, cronSecret)) {
    return privateJson({ message: "Unauthorized" }, { status: 401 })
  }

  try {
    if (await isVerifiedBackupActive()) {
      return privateJson({
        success: true,
        deferred: true,
        reason: "Verified daily backup in progress",
      })
    }
    const sync = await runAttendanceSync()
    return privateJson({ success: true, sync })
  } catch (error) {
    console.error("Attendance sync cron failed", error)
    return privateJson({ message: "Attendance sync failed." }, { status: 500 })
  }
}
