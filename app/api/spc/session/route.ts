import { NextResponse } from "next/server"
import { getSpcSession, refreshSpcSession } from "@/lib/spcAuth"
import { SPC_PAGE_DEFINITIONS } from "@/lib/spcPages"

export async function GET() {
  const session = await getSpcSession()
  await refreshSpcSession()

  return NextResponse.json({
    ...session,
    pages: session.authenticated ? SPC_PAGE_DEFINITIONS : [],
  })
}
