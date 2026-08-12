import { NextResponse } from "next/server"
import { hasSpcPagePermission, requireSpcSession } from "@/lib/spcAuth"
import {
  createSpcFeedback,
  createSpcFeedbackReadContext,
  loadSpcFeedback,
  reviewSpcFeedback,
} from "@/lib/spcFeedback"

function statusForMessage(message: string) {
  if (message === "Unauthorized") return 401
  if (message === "Forbidden") return 403
  if (message.includes("required") || message.includes("invalid") || message.includes("too long")) return 400
  return 500
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "view")) throw new Error("Forbidden")
    const records = await loadSpcFeedback(
      session,
      createSpcFeedbackReadContext(session, request),
    )
    return NextResponse.json({ records }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load feedback."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "edit")) throw new Error("Forbidden")
    const record = await createSpcFeedback(session, request, await request.json())
    return NextResponse.json({ record }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit feedback."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "edit")) throw new Error("Forbidden")
    const record = await reviewSpcFeedback(session, request, await request.json())
    return NextResponse.json({ record })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to review feedback."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}
