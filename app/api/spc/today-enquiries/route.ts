import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { normaliseSpcRole } from "@/lib/spcPages"
import { listSpcTodayEnquiries } from "@/lib/spcTodayEnquiries"

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-today-enquiries", "view")
    const role = normaliseSpcRole(session.role)
    if (role !== "SUPPLIER TRADER" && role !== "ADMIN") throw new Error("Forbidden")
    const enquiries = await listSpcTodayEnquiries(session, request)
    return NextResponse.json(
      { enquiries },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load today's enquiries."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
