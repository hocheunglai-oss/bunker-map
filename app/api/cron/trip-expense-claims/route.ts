import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { retryTripExpenseDeliveries } from "@/lib/tripExpenseDelivery"
import { TRIP_PRIVATE_HEADERS } from "@/lib/tripExpenseStore"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const actual = Buffer.from(request.headers.get("authorization") || "")
  const expected = Buffer.from("Bearer " + secret)
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
      process.env.VERCEL_ENV !== "production" || process.env.VERCEL_PROJECT_ID !== fcunoConnectionPolicy.vercel.projectId) {
    return NextResponse.json({ message: "Unauthorized" }, { headers: TRIP_PRIVATE_HEADERS, status: 401 })
  }
  try {
    const result = await retryTripExpenseDeliveries()
    if (result.failed) console.error("Trip expense claim delivery needs attention.")
    return NextResponse.json(result, { headers: TRIP_PRIVATE_HEADERS, status: result.failed ? 503 : 200 })
  } catch {
    return NextResponse.json({ message: "Claim delivery unavailable." }, { headers: TRIP_PRIVATE_HEADERS, status: 503 })
  }
}
