import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import {
  listSpcLostReasons,
  replaceSpcLostReasons,
  type SpcLostReasonAudience,
} from "@/lib/spcLostReasons"

function audience(value: unknown): SpcLostReasonAudience | null {
  return value === "BUYER TRADER" || value === "SUPPLIER TRADER" ? value : null
}

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to manage lost reasons."
  return NextResponse.json(
    { message },
    { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 400 },
  )
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-lost-record", "view")
    const [buyerReasons, supplierReasons] = await Promise.all([
      listSpcLostReasons(session, request, "BUYER TRADER"),
      listSpcLostReasons(session, request, "SUPPLIER TRADER"),
    ])
    return NextResponse.json({ buyerReasons, supplierReasons })
  } catch (error) {
    return responseError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-lost-record", "edit")
    const payload = (await request.json()) as { audience?: unknown; reasons?: unknown }
    const targetAudience = audience(payload.audience)
    if (!targetAudience) throw new Error("Lost reason audience is required.")
    const reasons = await replaceSpcLostReasons(session, request, targetAudience, payload.reasons)
    return NextResponse.json({ success: true, reasons })
  } catch (error) {
    return responseError(error)
  }
}
