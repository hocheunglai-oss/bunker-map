import { NextResponse } from "next/server"
import { clearAdminAndLinkedSpcSessions } from "@/lib/adminAuth"

export async function POST() {
  try {
    await clearAdminAndLinkedSpcSessions()
  } catch {
    return NextResponse.json(
      {
        success: false,
        message: "Session revocation could not be confirmed. Please try again.",
      },
      { status: 503 },
    )
  }

  return NextResponse.json({ success: true })
}
