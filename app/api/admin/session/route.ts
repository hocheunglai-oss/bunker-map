import { NextResponse } from "next/server"
import { getAdminSession, refreshAdminSession } from "@/lib/adminAuth"

export async function GET() {
  const session = await getAdminSession()
  await refreshAdminSession()

  return NextResponse.json(session)
}
