import { after, NextResponse } from "next/server"
import { isTripExpenseId, parseTripRate, validateTripExpense } from "@/lib/tripExpenseClaim"
import { deliverTripExpenseClaim } from "@/lib/tripExpenseDelivery"
import { readTripExchangeRate } from "@/lib/tripExpenseRate"
import {
  createTripExpenseDb,
  fileTripClaim,
  readTripExpenseJson,
  TRIP_PRIVATE_HEADERS,
  TripExpenseRequestError,
  tripClaimExistsForOwner,
  tripExpenseApiError,
  tripExpenseApiSession,
  verifyTripReceipts,
} from "@/lib/tripExpenseStore"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  try {
    const actor = await tripExpenseApiSession(request, "edit")
    const body = await readTripExpenseJson(request)
    const db = createTripExpenseDb()
    if (isTripExpenseId(body.id) && await tripClaimExistsForOwner(db, body.id, actor.adminUserId)) {
      return NextResponse.json({ id: body.id }, { headers: TRIP_PRIVATE_HEADERS })
    }

    const claim = validateTripExpense(body)
    if (claim.rate?.source === "frankfurter") {
      const current = await readTripExchangeRate(claim.currency, claim.departureDate)
      if (current.date !== claim.rate.date || parseTripRate(current.value) !== parseTripRate(claim.rate.value)) {
        throw new TripExpenseRequestError("Exchange rate updated. Refresh the rate and submit again.", 409)
      }
    }
    await verifyTripReceipts(db, actor.adminUserId, claim)
    const created = await fileTripClaim(db, actor, actor.displayName || actor.username || "FCUNO staff", claim)
    if (created && process.env.VERCEL_ENV === "production") {
      after(async () => {
        try {
          await deliverTripExpenseClaim(claim.id)
        } catch {
          console.error("Trip expense claim delivery needs attention.")
        }
      })
    }
    return NextResponse.json({ id: claim.id }, { headers: TRIP_PRIVATE_HEADERS, status: created ? 201 : 200 })
  } catch (error) {
    return tripExpenseApiError(error, "Could not submit the claim. Try again.")
  }
}
