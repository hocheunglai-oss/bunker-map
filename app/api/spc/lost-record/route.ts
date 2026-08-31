import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { updateSpcLostRecordReview } from "@/lib/spcLostReasons"

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-lost-record", "view")
    const payload = (await request.json()) as Record<string, unknown>
    const review = await updateSpcLostRecordReview(session, request, {
      id: payload.id,
      supplierLostReason: payload.supplierLostReason,
      supplierLostReasonDetails: payload.supplierLostReasonDetails,
      spcComments: payload.spcComments,
    })
    return NextResponse.json({ success: true, review })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update lost record."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 400 },
    )
  }
}
