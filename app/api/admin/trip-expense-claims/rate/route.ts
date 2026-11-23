import { NextResponse } from "next/server"
import { readTripExchangeRate } from "@/lib/tripExpenseRate"
import { TRIP_PRIVATE_HEADERS, tripExpenseApiError, tripExpenseApiSession } from "@/lib/tripExpenseStore"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await tripExpenseApiSession(request)
    const params = new URL(request.url).searchParams
    const rate = await readTripExchangeRate(params.get("currency"), params.get("date"))
    return NextResponse.json(rate, { headers: TRIP_PRIVATE_HEADERS })
  } catch (error) {
    return tripExpenseApiError(error, "Automatic rate unavailable. Enter it manually.")
  }
}
