import { NextResponse } from "next/server"
import { processPendingSpcMobileDeliveries } from "@/lib/spcMobileEnquiries"
import { isVerifiedBackupActive } from "@/lib/backupMaintenance"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 })
  try {
    if (await isVerifiedBackupActive()) {
      return NextResponse.json({
        success: true,
        deferred: true,
        reason: "Verified daily backup in progress",
      })
    }
    return NextResponse.json({ success: true, ...(await processPendingSpcMobileDeliveries()) })
  } catch (error) {
    console.error("SPC mobile delivery cron failed", error)
    return NextResponse.json({ message: "SPC mobile delivery processing failed." }, { status: 500 })
  }
}
