import { NextResponse } from "next/server"
import { requireSpcSession } from "@/lib/spcAuth"
import { getSpcMobileMode, setSpcMobileMode } from "@/lib/spcMobileEnquiries"

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Backup Mode is unavailable."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" || message.startsWith("Only an active") || message.startsWith("Administrators can") || message.startsWith("Backup Mode stays") ? 403 : 500
  return NextResponse.json({ message }, { status, headers: { "Cache-Control": "private, no-store" } })
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcSession()
    const userId = new URL(request.url).searchParams.get("userId")
    return NextResponse.json(await getSpcMobileMode(session, userId), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcSession()
    const body = (await request.json()) as { enabled?: unknown; userId?: unknown }
    if (typeof body.enabled !== "boolean") return NextResponse.json({ message: "Backup Mode selection is required." }, { status: 400 })
    const userId = typeof body.userId === "string" ? body.userId : null
    return NextResponse.json(await setSpcMobileMode(session, body.enabled, request, userId), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}
