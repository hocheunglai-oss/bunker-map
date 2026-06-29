import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createSpcEnquiry, listSpcEnquiries } from "@/lib/spcEnquiries"

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

export async function GET() {
  try {
    const session = await requireSpcPagePermission("spc-buyer-enquiries", "view")
    const enquiries = await listSpcEnquiries(session)
    return NextResponse.json({ enquiries })
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
