import { NextResponse } from "next/server"
import { hasSpcPagePermission, requireSpcSession } from "@/lib/spcAuth"
import { SpcFeedbackError } from "@/lib/spcFeedbackShared"
import {
  createSpcFeedback,
  createSpcFeedbackReadContext,
  loadSpcFeedback,
  reviewSpcFeedback,
} from "@/lib/spcFeedback"

const headers = { "Cache-Control": "private, no-store" }

function failure(error: unknown, fallback: string) {
  if (error instanceof SpcFeedbackError) return NextResponse.json({ message: error.message }, { status: error.status, headers })
  const message = error instanceof Error ? error.message : ""
  if (message === "Unauthorized" || message === "Forbidden") {
    return NextResponse.json({ message }, { status: message === "Unauthorized" ? 401 : 403, headers })
  }
  return NextResponse.json({ message: fallback }, { status: 500, headers })
}

async function readInput(request: Request) {
  let input: unknown
  try { input = await request.json() } catch { throw new SpcFeedbackError("Feedback request is invalid.") }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpcFeedbackError("Feedback request is invalid.")
  return input
}

export async function GET(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "view")) throw new Error("Forbidden")
    const records = await loadSpcFeedback(
      session,
      createSpcFeedbackReadContext(session, request),
    )
    return NextResponse.json({ records }, { headers })
  } catch (error) {
    return failure(error, "Feedback could not be loaded. Please try again.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "edit")) throw new Error("Forbidden")
    const record = await createSpcFeedback(session, request, await readInput(request))
    return NextResponse.json({ record }, { status: 201, headers })
  } catch (error) {
    return failure(error, "Your submission could not be verified. Refresh feedback before sending it again.")
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-feedback", "edit")) throw new Error("Forbidden")
    const record = await reviewSpcFeedback(session, request, await readInput(request))
    return NextResponse.json({ record }, { headers })
  } catch (error) {
    return failure(error, "The saved review could not be verified. Refresh feedback before trying again.")
  }
}
