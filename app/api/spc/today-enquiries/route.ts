import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { normaliseSpcRole } from "@/lib/spcPages"
import { readSpcRecordPage, spcRecordPageFailure } from "@/lib/spcRecordPageStore"

export async function GET(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-today-enquiries", "view")
    const role = normaliseSpcRole(session.role)
    if (role !== "SUPPLIER TRADER" && role !== "ADMIN") throw new Error("Forbidden")
    const page = await readSpcRecordPage(session, request, "today")
    return NextResponse.json(
      page,
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    )
  } catch (error) {
    const { message, status, code } = spcRecordPageFailure(error)
    return NextResponse.json(
      { message, code },
      { status, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    )
  }
}
