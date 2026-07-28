import { NextResponse } from "next/server"
import { getRefreshedAdminSession } from "@/lib/adminAuth"

export async function GET() {
  const session = await getRefreshedAdminSession()

  return NextResponse.json(session)
}
