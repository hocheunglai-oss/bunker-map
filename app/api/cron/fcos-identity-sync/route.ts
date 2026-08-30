import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { isFcosIdentitySyncEnabled } from "@/lib/fcunoFederationFlags"
import { processFcunoIdentitySyncOutbox } from "@/lib/fcunoIdentitySync"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function authorized(request: Request, secret: string) {
  const actual = Buffer.from(request.headers.get("authorization") || "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !authorized(request, secret)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } })
  }
  if (!isFcosIdentitySyncEnabled()) {
    return NextResponse.json(
      { success: true, disabled: true, processed: 0 },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  }
  try {
    return NextResponse.json({ success: true, ...(await processFcunoIdentitySyncOutbox()) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("FCOS identity sync failed", error)
    return NextResponse.json({ message: "FCOS identity sync is unavailable." }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
  }
}
