import { NextResponse } from "next/server"
import { isTripExpenseId, parseTripReceipt, TripExpenseInputError } from "@/lib/tripExpenseClaim"
import {
  createTripExpenseDb,
  getTripClaim,
  readTripExpenseJson,
  TRIP_PRIVATE_HEADERS,
  TripExpenseRequestError,
  tripClaimExistsForOwner,
  tripExpenseApiError,
  tripExpenseApiSession,
  tripReceiptBucket,
  tripReceiptPath,
  tripReceiptUploaded,
} from "@/lib/tripExpenseStore"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await tripExpenseApiSession(request, "edit")
    const { claimId, itemId, receipt: input } = await readTripExpenseJson(request)
    if (!isTripExpenseId(claimId) || !isTripExpenseId(itemId)) throw new TripExpenseInputError("Invalid receipt.")
    const receipt = parseTripReceipt(input)
    const db = createTripExpenseDb()
    if (await tripClaimExistsForOwner(db, claimId, actor.adminUserId)) {
      return NextResponse.json({ submitted: true }, { headers: TRIP_PRIVATE_HEADERS })
    }
    const path = tripReceiptPath(actor.adminUserId, claimId, itemId, receipt.id)
    const bucket = tripReceiptBucket(db)
    if (await tripReceiptUploaded(bucket, path, receipt)) {
      return NextResponse.json({ uploaded: true }, { headers: TRIP_PRIVATE_HEADERS })
    }
    const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: false })
    if (error) throw error
    return NextResponse.json({ url: data.signedUrl }, { headers: TRIP_PRIVATE_HEADERS })
  } catch (error) {
    return tripExpenseApiError(error, "Could not prepare the receipt upload. Try again.")
  }
}

export async function GET(request: Request) {
  try {
    const actor = await tripExpenseApiSession(request)
    const params = new URL(request.url).searchParams
    const id = params.get("claim")
    const receiptId = params.get("receipt")
    if (!isTripExpenseId(id) || !isTripExpenseId(receiptId)) throw new TripExpenseInputError("Invalid receipt.")
    const db = createTripExpenseDb()
    const claim = await getTripClaim(db, id, actor)
    const item = claim?.details.items.find(item => item.receipts.some(receipt => receipt.id === receiptId))
    const receipt = item?.receipts.find(receipt => receipt.id === receiptId)
    if (!claim || !item || !receipt) throw new TripExpenseRequestError("Receipt not found.", 404)

    const bucket = tripReceiptBucket(db)
    const path = tripReceiptPath(claim.submitted_by, id, item.id, receipt.id)
    const { data, error } = await bucket.createSignedUrl(path, 60, { download: receipt.name })
    if (error) throw error
    return NextResponse.redirect(data.signedUrl, { headers: TRIP_PRIVATE_HEADERS })
  } catch (error) {
    return tripExpenseApiError(error, "Could not open the receipt. Try again.")
  }
}
