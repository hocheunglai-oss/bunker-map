import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { getSystemHealth } from "@/lib/systemHealth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

export async function GET() {
  try {
    await requireAdminPagePermission("system-health", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : 403 }
    )
  }

  return NextResponse.json(await getSystemHealth())
}
