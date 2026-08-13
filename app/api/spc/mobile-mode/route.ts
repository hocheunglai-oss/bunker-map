import { NextResponse } from "next/server"
import { requireSpcSession } from "@/lib/spcAuth"
import { getSpcMobileMode, setSpcMobileMode } from "@/lib/spcMobileEnquiries"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Mobile Mode is unavailable."
  const status = message === "Unauthorized" ? 401 : message.startsWith("Only an active") ? 403 : 500
  return NextResponse.json({ message }, { status, headers: { "Cache-Control": "private, no-store" } })
}

export async function GET() {
  try {
    const session = await requireSpcSession()
    return NextResponse.json(await getSpcMobileMode(session), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcSession()
    const body = (await request.json()) as { enabled?: unknown }
    if (typeof body.enabled !== "boolean") return NextResponse.json({ message: "Mobile Mode selection is required." }, { status: 400 })
    return NextResponse.json(await setSpcMobileMode(session, body.enabled, request), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}
