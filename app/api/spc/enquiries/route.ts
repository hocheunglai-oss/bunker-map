import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  createSpcEnquiry,
  listSpcEnquiries,
  updateSpcEnquiryOutcome,
  type SpcEnquiryOutcome,
} from "@/lib/spcEnquiries"

type EnquiryPayload = {
  title?: string
  vesselName?: string
  port?: string
  product?: string
  quantity?: string
  deliveryDate?: string
  supplierName?: string
  notes?: string
}

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.includes("required")
          ? 400
          : 500
  return NextResponse.json({ message }, { status })
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "view")
    const searchParams = new URL(request.url).searchParams
    const status = searchParams.get("status")?.trim() || undefined
    const limit = Number(searchParams.get("limit") || 250)
    const enquiries = await listSpcEnquiries(session, { status, limit })
    return NextResponse.json(
      { enquiries },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    return errorResponse(error, "Failed to load SPC enquiries.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    const payload = (await request.json()) as EnquiryPayload
    const enquiry = await createSpcEnquiry(payload, session, request)
    return NextResponse.json({ success: true, enquiry })
  } catch (error) {
    return errorResponse(error, "Failed to save SPC enquiry.")
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    const payload = (await request.json()) as { id?: unknown; outcome?: unknown }
    const id = typeof payload.id === "string" ? payload.id.trim() : ""
    const outcome: SpcEnquiryOutcome | null =
      payload.outcome === "stem" || payload.outcome === "lost" ? payload.outcome : null
    if (!id) throw new Error("Enquiry id is required.")
    if (!outcome) throw new Error("Outcome is required.")

    const enquiry = await updateSpcEnquiryOutcome(id, outcome, session, request)
    return NextResponse.json({ success: true, enquiry })
  } catch (error) {
    return errorResponse(error, "Failed to update SPC enquiry.")
  }
}
