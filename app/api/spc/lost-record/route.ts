import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { updateSpcLostRecordReview } from "@/lib/spcLostReasons"

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-lost-record", "view")
    const payload = (await request.json()) as Record<string, unknown>
    const review = await updateSpcLostRecordReview(session, request, {
      id: payload.id,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      supplierLostReason: payload.supplierLostReason,
      supplierLostReasonDetails: payload.supplierLostReasonDetails,
      spcComments: payload.spcComments,
    })
    return NextResponse.json({ success: true, review })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : ""
    const message = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Failed to update lost record."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : code === "40001" ? 409 : 400 },
    )
  }
}
