import { NextResponse } from "next/server"
import { getSpcSession, refreshSpcSession } from "@/lib/spcAuth"

export async function GET() {
  const session = await getSpcSession()
  await refreshSpcSession()

  return NextResponse.json(session)
}
