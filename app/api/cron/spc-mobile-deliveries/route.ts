import { NextResponse } from "next/server"
import { processPendingSpcMobileDeliveries } from "@/lib/spcMobileEnquiries"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 })
  try {
    return NextResponse.json({ success: true, ...(await processPendingSpcMobileDeliveries()) })
  } catch (error) {
    console.error("SPC mobile delivery cron failed", error)
    return NextResponse.json({ message: "SPC mobile delivery processing failed." }, { status: 500 })
  }
}
