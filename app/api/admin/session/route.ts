import { NextResponse } from "next/server"
import { getAdminSession } from "@/lib/adminAuth"

export async function GET() {
  const session = await getAdminSession()

  return NextResponse.json(session)
}
